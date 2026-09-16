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
import convoManager from '../conversation.js';

export function getAutonomyConfig() {
    const block = settings.autonomy ?? {};
    const needs = {
        tool_replace_threshold: block.needs?.tool_replace_threshold ?? 0.15,
        explore_when_idle: block.needs?.explore_when_idle ?? true,
        explore_idle_s: block.needs?.explore_idle_s ?? 60,
        explore_legs: block.needs?.explore_legs ?? 2,
        free_slot_alert: block.needs?.free_slot_alert ?? 2
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
    return {
        tools,
        freeSlots: countFreeSlots(bot),
        idleForMs: typeof agent?.idleForMs === 'function' ? agent.idleForMs() : 0,
        isNight: isNightTime(bot),
        hasPendingResume: !!agent?.behavior_state?.hasPendingResume?.()
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
            const ctx = snapshotNeeds(this.agent, cfg);
            const needs = evaluateNeeds(ctx, cfg.needs);
            const actionable = needs.find(n => !n.advisory && this._executors[n.kind]);
            if (!actionable) {
                this._nextRunAt = now + this._cooldownMs(cfg);
                return;
            }

            this._running = true;
            this._nextRunAt = now + this._cooldownMs(cfg);
            let result = 'no result';
            try {
                const runner = async () => {
                    result = await this._executors[actionable.kind](this.agent, actionable, cfg.needs) ?? 'done';
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
        if (this.history.length) {
            lines.push('Recent history:');
            for (const h of this.history.slice(-5)) lines.push(`- ${h.kind}: ${h.result}`);
        }
        return lines.join('\n');
    }
}
