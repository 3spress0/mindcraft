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
import { assessLocalRisk, filterNeedsByRisk, riskLine } from './risk.js';
import { scanDarkSpots } from './base.js';
import { executePatrolNeed } from './patrol.js';
import { getHome, nearestBase } from '../navigation/home.js';
import * as world from '../library/world.js';
import convoManager from '../conversation.js';

/** Errands after which the bot walks back home (when one is set). */
export const RETURN_HOME_KINDS = new Set(['explore', 'farm', 'inventory_full', 'patrol']);

export function getAutonomyConfig() {
    const block = settings.autonomy ?? {};
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
        needs
    };
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
        patrolReady
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

            const cfg = getAutonomyConfig();
            if (this._exploreOverride != null) cfg.needs.explore_when_idle = this._exploreOverride;
            const ctx = snapshotNeeds(this.agent, cfg);
            const needs = evaluateNeeds(ctx, cfg.needs);

            // Risk-aware planning: dangerous local conditions hold risky work
            // (exploration, farming) while safe upkeep still proceeds.
            let risk = null;
            try { risk = assessLocalRisk(this.agent.bot, { posture: this.agent.bot?._risk_profile }); }
            catch { risk = null; }
            this.lastRisk = risk;
            const safeNeeds = filterNeedsByRisk(needs, risk);
            const actionable = safeNeeds.find(n => !n.advisory && this._executors[n.kind]);
            if (!actionable) {
                const held = needs.find(n => !n.advisory && this._executors[n.kind]);
                if (held && risk?.level === 'high') {
                    const entry = { t: now, kind: held.kind, detail: held.detail, result: `held: ${riskLine(risk)}` };
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

    /** Status lines for !autonomyStatus. */
    summarize() {
        const cfg = getAutonomyConfig();
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
        if (this.history.length) {
            lines.push('Recent history:');
            for (const h of this.history.slice(-5)) lines.push(`- ${h.kind}: ${h.result}`);
        }
        return lines.join('\n');
    }
}
