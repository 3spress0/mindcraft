/**
 * task_loop.js — the autonomous task loop.
 *
 * While the agent is idle (no user action, no conversation, no self-prompt
 * running), the loop periodically evaluates needs (needs.js) and executes the
 * most urgent one through the normal action manager, so everything stays
 * interruptible and shows up in the behavior FSM. Results are recorded in a
 * bounded history surfaced by !autonomyStatus.
 *
 * Design guardrails:
 *   - only runs when truly idle; never interrupts user-driven work,
 *   - bounded, personality-paced cooldown between runs,
 *   - advisory needs (e.g. inventory_full) are reported, not executed,
 *   - every executor result is caught; the loop itself never throws.
 */

import settings from '../../../settings.js';
import { evaluateNeeds, countFreeSlots, isNightTime } from './needs.js';
import { EXECUTORS } from './executors.js';
import { listTools } from '../library/durability.js';
import { isEdible } from './unload.js';
import { farmSnapshot } from './farming.js';
import { planBreeding } from './husbandry.js';
import { assessLocalRisk, filterNeedsByRisk, riskLine } from './risk.js';
import { updateCombatState, executeEscape, combatStateLine } from './combat.js';
import { seekSafeZone } from '../navigation/safe_zones.js';
import { scanDarkSpots } from './base.js';
import { executePatrolNeed } from './patrol.js';
import { getHome, nearestBase } from '../navigation/home.js';
import { touchHeartbeat } from '../library/crash_guard.js';
import { worldSettings } from '../library/world_config.js';
import { logEvent } from '../library/structlog.js';
import * as world from '../library/world.js';
import convoManager from '../conversation.js';

/** Errands after which the bot walks back home (when one is set). */
export const RETURN_HOME_KINDS = new Set(['explore', 'farm', 'inventory_full', 'patrol', 'husbandry']);

/**
 * Batch related tasks (GO list: batch related tasks): needs that pair well
 * in a single outing. When the first one finishes, a pending partner runs
 * right away instead of going home and coming back out.
 */
export const BATCH_PAIRS = {
    farm: ['inventory_full', 'husbandry'],
    inventory_full: ['farm'],
    husbandry: ['farm'],
    maintain_base: ['inventory_full']
};

/** Needs that stay acceptable while combat is engaged (upkeep only). */
export const COMBAT_SAFE_NEEDS = new Set(['tool_replace', 'restock_torches', 'restock_food']);

export function getAutonomyConfig(agent = null) {
    // Per-world configuration: settings.worlds overrides merge in here.
    let block = settings.autonomy ?? {};
    try {
        if (agent) block = worldSettings(agent)?.autonomy ?? block;
    } catch { /* world overrides are optional */ }
    const needs = {
        tool_replace_threshold: block.needs?.tool_replace_threshold ?? 0.15,
        explore_when_idle: block.needs?.explore_when_idle ?? true,
        explore_idle_s: block.needs?.explore_idle_s ?? 60,
        explore_legs: block.needs?.explore_legs ?? 2,
        free_slot_alert: block.needs?.free_slot_alert ?? 2,
        min_torches: block.needs?.min_torches ?? 8,
        min_food: block.needs?.min_food ?? 5,
        max_unload_types: block.needs?.max_unload_types ?? 8,
        farm_radius: block.needs?.farm_radius ?? 16,
        max_harvest: block.needs?.max_harvest ?? 16,
        max_plants: block.needs?.max_plants ?? 24,
        max_till: block.needs?.max_till ?? 4,
        farm_expand: block.needs?.farm_expand ?? true,
        breed_radius: block.needs?.breed_radius ?? 16,
        max_breed_pairs: block.needs?.max_breed_pairs ?? 2,
        maintain_radius: block.needs?.maintain_radius ?? 8,
        return_home_after_errand: block.needs?.return_home_after_errand ?? true,
        patrol_pois: Array.isArray(block.needs?.patrol_pois) ? block.needs.patrol_pois : []
    };
    const [lo, hi] = Array.isArray(block.cooldown_s) && block.cooldown_s.length === 2
        ? block.cooldown_s : [20, 60];
    return {
        enabled: block.enabled !== false,
        cooldown_s: [Math.max(5, lo), Math.max(5, hi)],
        action_timeout_s: Math.max(30, block.action_timeout_s ?? 180),
        history_limit: Math.max(4, block.history_limit ?? 16),
        // Scheduled tasks (GO list): [{ at: 'dawn'|'dusk'|'HH:MM', do: '<need kind>' }]
        scheduled: Array.isArray(block.scheduled) ? block.scheduled : [],
        needs
    };
}

/**
 * Does a scheduled entry match the current in-game moment?
 * 'dawn' ≈ time 23000-1500, 'dusk' ≈ 12000-14000, 'HH:MM' maps 24h -> 24000
 * with a ±30-minute window. Pure given (entry, timeOfDay) — testable.
 */
export function scheduledMatches(entry, timeOfDay) {
    if (!entry?.at || typeof timeOfDay !== 'number') return false;
    const at = String(entry.at).toLowerCase();
    const near = (a, b, win = 1000) => {
        const d = Math.abs(a - b);
        return Math.min(d, 24000 - d) <= win;
    };
    if (at === 'dawn') return near(timeOfDay, 0);
    if (at === 'dusk') return near(timeOfDay, 13000);
    const m = at.match(/^(\d{1,2}):(\d{2})$/);
    if (m) {
        const minutes = Number(m[1]) * 60 + Number(m[2]);
        const mcTime = Math.round((minutes / (24 * 60)) * 24000);
        return near(timeOfDay, mcTime, 500);
    }
    return false;
}

/** Build the state snapshot needs.js consumes. Pure given the agent. */
export function snapshotNeeds(agent, cfg) {
    const bot = agent?.bot;
    const threshold = cfg.needs.tool_replace_threshold;
    let tools = [];
    try { tools = listTools(bot, threshold); } catch { tools = []; }
    let inventoryCounts = {};
    try { inventoryCounts = world.getInventoryCounts(bot); } catch { inventoryCounts = {}; }
    let foodCount = 0;
    try {
        for (const item of bot?.inventory?.slots ?? []) {
            if (item && isEdible(bot, item)) foodCount += item.count ?? 1;
        }
    } catch { foodCount = 0; }
    // Only scan crops when food is actually low — keeps the loop cheap.
    let farm = null;
    if (foodCount < cfg.needs.min_food) {
        try { farm = farmSnapshot(bot, { radius: cfg.needs.farm_radius }); } catch { farm = null; }
    }
    // Husbandry: only worth scanning animals when breeding food is carried.
    let husbandryPairs = 0;
    try {
        const breedingFood = ['wheat', 'carrot', 'wheat_seeds', 'beetroot_seeds']
            .some(f => (inventoryCounts[f] ?? 0) >= 2);
        if (breedingFood) {
            const plans = planBreeding(bot, { radius: cfg.needs.breed_radius ?? 16 });
            husbandryPairs = plans.reduce((n, p) => n + p.pairs, 0);
        }
    } catch { husbandryPairs = 0; }
    // Bedtime + base-maintenance context (cheap checks, night-gated scan).
    let bedKnown = false;
    try { bedKnown = (agent?.mental_map?.list?.({ type: 'bed' }) ?? []).length > 0 || !!bot?._bed_known; }
    catch { bedKnown = false; }
    let homeSet = false;
    try { homeSet = !!getHome(agent); } catch { homeSet = false; }
    let darkSpots = 0;
    if (homeSet) {
        try {
            // maintain whichever base the bot is currently living at
            const base = nearestBase(agent) ?? getHome(agent);
            darkSpots = scanDarkSpots(bot, { center: base, radius: cfg.needs.maintain_radius ?? 8 }).length;
        } catch { darkSpots = 0; }
    }
    const patrolReady = Array.isArray(cfg.needs.patrol_pois) && cfg.needs.patrol_pois.length >= 2;
    return {
        tools,
        freeSlots: countFreeSlots(bot),
        idleForMs: typeof agent?.idleForMs === 'function' ? agent.idleForMs() : 0,
        isNight: isNightTime(bot),
        hasPendingResume: !!agent?.behavior_state?.hasPendingResume?.(),
        inventoryCounts,
        foodCount,
        farm,
        bedKnown,
        homeSet,
        darkSpots,
        patrolReady,
        husbandryPairs
    };
}

export class AutonomyLoop {
    /**
     * @param {object} agent
     * @param {object} [opts] - { now, rng, executors } injectable for tests
     */
    constructor(agent, { now = () => Date.now(), rng = null, executors = EXECUTORS } = {}) {
        this.agent = agent;
        this._now = now;
        this._rng = rng; // optional seeded rng for cooldown pacing
        this._executors = executors;
        this._runtimeEnabled = null; // !setAutonomy override; null = follow settings
        this._exploreOverride = null; // !setRisk override; null = follow settings
        this._running = false;
        this._nextRunAt = 0;
        this.lastRun = null; // { t, kind, detail, result }
        this.history = [];
    }

    get enabled() {
        if (this._runtimeEnabled != null) return this._runtimeEnabled;
        return getAutonomyConfig().enabled;
    }

    setRuntimeEnabled(on) { this._runtimeEnabled = !!on; }

    /** Risk-posture hook: force exploration on/off regardless of settings. */
    setExploreEnabled(on) { this._exploreOverride = on == null ? null : !!on; }

    /** Personality-paced cooldown in ms within the configured envelope. */
    _cooldownMs(cfg) {
        const [lo, hi] = cfg.cooldown_s;
        const mid = (lo + hi) / 2 * 1000;
        const personality = this.agent?.personality;
        if (personality?.timing) return personality.timing(mid, 0.35);
        if (this._rng) return Math.round(this._rng.range(lo * 1000, hi * 1000));
        return Math.round(mid);
    }

    /** Whether the agent is too busy for autonomous actions right now. */
    _blocked() {
        const a = this.agent;
        if (!a?.bot) return true;
        if (a._paused) return true; // global !pause is a hard gate
        if (typeof a.isIdle === 'function' && !a.isIdle()) return true;
        if (typeof a.isHandlingMessage === 'function' && a.isHandlingMessage()) return true;
        if (a.self_prompter?.isActive?.()) return true;
        try {
            if (convoManager.inConversation()) return true;
        } catch { /* conversation manager optional */ }
        return false;
    }

    /**
     * Drive one tick from agent.update(). Safe to call often; the cooldown
     * and _running guard keep it cheap. Never throws.
     */
    async tick() {
        try {
            if (!this.enabled || this._running) return;
            const now = this._now();
            if (now < this._nextRunAt) return;
            if (this._blocked()) return;
            // crash-recovery backoff: after a detected crash-loop, hold the
            // loop off for an escalating window (GO list: persistent crash
            // recovery)
            if (this.agent?._autonomy_backoff_until && now < this.agent._autonomy_backoff_until) return;
            // heartbeat for crash detection — throttled, never throws
            try {
                if (now - (this._lastHeartbeat ?? 0) > 15000) {
                    this._lastHeartbeat = now;
                    const botName = this.agent?.bot?.username ?? this.agent?.name;
                    if (botName) touchHeartbeat(botName);
                }
            } catch { /* heartbeat is advisory */ }

            const cfg = getAutonomyConfig(this.agent);

            // Combat guard (GO list: reactive flee / safe-zone seeking /
            // threat-driven posture): when things go bad the loop stops
            // planning chores and gets the bot to safety first.
            let combatState = null;
            try { combatState = updateCombatState(this.agent.bot); } catch { combatState = null; }
            this.lastCombat = combatState;
            // Food selection based on context (GO list): in a fight the bot
            // grabs quick calories; at peace it eats for saturation.
            try {
                const ae = this.agent?.bot?.autoEat;
                if (ae?.options) {
                    const want = combatState?.phase === 'engaged' ? 'foodPoints' : 'saturation';
                    if (ae.options.priority !== want) ae.options.priority = want;
                }
            } catch { /* auto-eat tuning is advisory */ }
            if (combatState?.phase === 'fleeing' && now - (this._lastEscapeAt ?? 0) > 30000) {
                this._lastEscapeAt = now;
                this._running = true;
                let result = 'escape: unknown';
                try {
                    const runner = async () => {
                        const esc = await executeEscape(this.agent);
                        const zone = await seekSafeZone(this.agent, { radius: 10 });
                        return `${esc} | ${zone}`;
                    };
                    if (this.agent.actions?.runAction) {
                        const code = await this.agent.actions.runAction('autonomy:escape', runner, { timeout: cfg.action_timeout_s });
                        result = code?.interrupted ? 'escape [interrupted]' : 'escape executed';
                    } else {
                        result = await runner();
                    }
                } catch (e) {
                    result = `escape error: ${e.message}`;
                }
                const entry = { t: now, kind: 'escape', detail: combatState.reason ?? combatState.level, result };
                this.history.push(entry);
                if (this.history.length > cfg.history_limit) this.history.splice(0, this.history.length - cfg.history_limit);
                this.lastRun = entry;
                this._nextRunAt = now + this._cooldownMs(cfg);
                return;
            }

            // Occasionally reconsider goals (GO list): after long idle
            // stretches, drop an advisory nudge into the conversation so the
            // model re-evaluates priorities on its next turn. Gated, seeded,
            // never forces an LLM call.
            try {
                const idleMs = typeof this.agent.idleForMs === 'function' ? this.agent.idleForMs() : 0;
                if (idleMs > 15 * 60_000 && now - (this._lastReconsiderAt ?? 0) > 30 * 60_000) {
                    const rng = this._rng ?? this.agent?.personality?.rng ?? null;
                    if (!rng?.chance || rng.chance(0.35)) {
                        this._lastReconsiderAt = now;
                        this.agent.history?.add?.('system',
                            'You have been idle for a while. Reconsider your current goals and priorities — is there something more useful to do?');
                        logEvent(this.agent, 'autonomy', 'reconsider_goals', { idleMs: Math.round(idleMs / 1000) });
                    }
                }
            } catch { /* advisory */ }

            // Scheduled tasks: dawn/dusk/clock-time chores, once per mc-day.
            try {
                const due = this._dueScheduled(cfg);
                if (due) {
                    const entry = await this._runNeed(due.need, cfg, now, `scheduled@${due.entry.at}`);
                    if (entry) {
                        this._nextRunAt = now + this._cooldownMs(cfg);
                        return;
                    }
                }
            } catch { /* scheduling must never break the loop */ }

            if (this._exploreOverride != null) cfg.needs.explore_when_idle = this._exploreOverride;
            const ctx = snapshotNeeds(this.agent, cfg);
            let needs = evaluateNeeds(ctx, cfg.needs);

            // Risk-aware planning: dangerous local conditions hold risky work
            // (exploration, farming) while safe upkeep still proceeds.
            let risk = null;
            try { risk = assessLocalRisk(this.agent.bot, { posture: this.agent.bot?._risk_profile }); }
            catch { risk = null; }
            this.lastRisk = risk;
            let safeNeeds = filterNeedsByRisk(needs, risk);
            // Threat-driven posture: while actively engaged, only upkeep runs.
            if (combatState?.phase === 'engaged') {
                safeNeeds = safeNeeds.filter(n => COMBAT_SAFE_NEEDS.has(n.kind));
            }
            const actionable = safeNeeds.find(n => !n.advisory && this._executors[n.kind]);
            if (!actionable) {
                const held = needs.find(n => !n.advisory && this._executors[n.kind]);
                if (held && (risk?.level === 'high' || combatState?.phase === 'engaged')) {
                    const why = combatState?.phase === 'engaged' ? combatStateLine(combatState) : riskLine(risk);
                    const entry = { t: now, kind: held.kind, detail: held.detail, result: `held: ${why}` };
                    this.history.push(entry);
                    if (this.history.length > cfg.history_limit) this.history.splice(0, this.history.length - cfg.history_limit);
                    this.lastRun = entry;
                }
                this._nextRunAt = now + this._cooldownMs(cfg);
                return;
            }

            this._running = true;
            this._nextRunAt = now + this._cooldownMs(cfg);
            let result = 'no result';
            try {
                const runner = async () => {
                    result = await this._executors[actionable.kind](this.agent, actionable, cfg.needs) ?? 'done';
                    // Batch related tasks: a pending partner need runs in the
                    // same outing before we walk home.
                    const partners = BATCH_PAIRS[actionable.kind] ?? [];
                    for (const kind of partners) {
                        if (this.agent?.bot?.interrupt_code) break;
                        const partner = safeNeeds.find(n => n.kind === kind && !n.advisory && this._executors[kind]);
                        if (!partner) continue;
                        try {
                            const partnerResult = await this._executors[kind](this.agent, partner, cfg.needs);
                            result += ` [batched ${kind}: ${partnerResult ?? 'done'}]`;
                        } catch { /* batching is best-effort */ }
                        break; // one partner per outing keeps runs bounded
                    }
                    // Humanlike touch: come home after wandering errands.
                    if (RETURN_HOME_KINDS.has(actionable.kind) && cfg.needs.return_home_after_errand !== false) {
                        try {
                            const bot = this.agent?.bot;
                            const base = nearestBase(this.agent) ?? getHome(this.agent);
                            if (base && bot && !bot.interrupt_code) {
                                const skills = await import('../library/skills.js');
                                await skills.goToPosition(bot, base.x, base.y, base.z, 4);
                                result += ' [returned home]';
                            }
                        } catch { /* returning home is best-effort */ }
                    }
                };
                if (this.agent.actions?.runAction) {
                    const code = await this.agent.actions.runAction(
                        `autonomy:${actionable.kind}`,
                        runner,
                        { timeout: cfg.action_timeout_s }
                    );
                    if (code?.interrupted) result = `${result} [interrupted]`;
                } else {
                    await runner();
                }
            } catch (e) {
                result = `executor error: ${e.message}`;
            }
            const entry = { t: now, kind: actionable.kind, detail: actionable.detail, result };
            this.history.push(entry);
            if (this.history.length > cfg.history_limit) {
                this.history.splice(0, this.history.length - cfg.history_limit);
            }
            this.lastRun = entry;
        } catch (e) {
            // the loop must never take the agent down
        } finally {
            this._running = false;
        }
    }

    /** Find the first scheduled entry due now (deduped once per mc-day). */
    _dueScheduled(cfg) {
        if (!cfg.scheduled?.length) return null;
        const bot = this.agent?.bot;
        const t = bot?.time;
        let timeOfDay = null;
        let day = 0;
        if (typeof t === 'number') {
            timeOfDay = t % 24000;
            day = Math.floor(t / 24000);
        } else if (typeof t?.timeOfDay === 'number') {
            timeOfDay = t.timeOfDay % 24000;
            day = Math.floor((t.age ?? t.timeOfDay) / 24000);
        }
        if (timeOfDay == null) return null;
        for (const entry of cfg.scheduled) {
            if (!entry?.do || !scheduledMatches(entry, timeOfDay)) continue;
            const key = `${day}:${entry.at}:${entry.do}`;
            this._scheduledDone ??= new Set();
            if (this._scheduledDone.has(key)) continue;
            if (this._scheduledDone.size > 64) this._scheduledDone.clear();
            this._scheduledDone.add(key);
            const need = { kind: String(entry.do), detail: 'scheduled', advisory: false };
            if (!this._executors[need.kind]) continue;
            return { entry, need };
        }
        return null;
    }

    /** Run a need through the normal action-manager flow (scheduled tasks). */
    async _runNeed(need, cfg, now, detailPrefix = '') {
        let result = 'no result';
        try {
            const runner = async () => {
                result = await this._executors[need.kind](this.agent, need, cfg.needs) ?? 'done';
            };
            if (this.agent.actions?.runAction) {
                const code = await this.agent.actions.runAction(`autonomy:${need.kind}`, runner, { timeout: cfg.action_timeout_s });
                if (code?.interrupted) result = `${result} [interrupted]`;
            } else {
                await runner();
            }
        } catch (e) {
            result = `executor error: ${e.message}`;
        }
        const entry = { t: now, kind: need.kind, detail: detailPrefix || need.detail, result };
        this.history.push(entry);
        if (this.history.length > cfg.history_limit) this.history.splice(0, this.history.length - cfg.history_limit);
        this.lastRun = entry;
        return entry;
    }

    /** Status lines for !autonomyStatus. */
    summarize() {
        const cfg = getAutonomyConfig(this.agent);
        let ctx = {};
        try { ctx = snapshotNeeds(this.agent, cfg); } catch { ctx = {}; }
        let needs = [];
        try { needs = evaluateNeeds(ctx, cfg.needs); } catch { needs = []; }
        const lines = [`AUTONOMY (${this.enabled ? 'ON' : 'OFF'})`];
        lines.push(`Cooldown: ${cfg.cooldown_s[0]}-${cfg.cooldown_s[1]}s, action timeout ${cfg.action_timeout_s}s`);
        if (this.lastRun) {
            lines.push(`Last run: ${this.lastRun.kind} (${this.lastRun.detail}) -> ${this.lastRun.result}`);
        } else {
            lines.push('Last run: none yet');
        }
        lines.push(needs.length
            ? `Current needs: ${needs.map(n => `${n.kind}${n.advisory ? ' (advisory)' : ''}`).join(', ') || 'none'}`
            : 'Current needs: none');
        let riskLineText = '';
        try { riskLineText = riskLine(this.lastRisk ?? assessLocalRisk(this.agent?.bot)); } catch { riskLineText = ''; }
        if (riskLineText) lines.push(riskLineText);
        try {
            if (this.lastCombat) lines.push(combatStateLine(this.lastCombat));
        } catch { /* optional */ }
        if (this.history.length) {
            lines.push('Recent history:');
            for (const h of this.history.slice(-5)) lines.push(`- ${h.kind}: ${h.result}`);
        }
        return lines.join('\n');
    }
}
