/**
 * needs.js — pure, deterministic needs evaluation for the autonomous task
 * loop (GO list: long-term autonomy). Given a snapshot of the bot's state,
 * it returns scored needs sorted by urgency. No bot access here — callers
 * build the snapshot, which keeps this fully testable.
 */

export const NEED_KINDS = ['tool_replace', 'inventory_full', 'explore'];

export function autonomyDefaults() {
    return {
        tool_replace_threshold: 0.15,
        explore_when_idle: true,
        explore_idle_s: 60,
        explore_legs: 2,
        free_slot_alert: 2
    };
}

/**
 * Evaluate needs from a state snapshot.
 * @param {object} ctx
 * @param {Array}  [ctx.tools]        toolCondition rows (from durability.listTools)
 * @param {number} [ctx.freeSlots]    free main-inventory slots
 * @param {number} [ctx.idleForMs]    ms since last activity change
 * @param {boolean} [ctx.isNight]
 * @param {boolean} [ctx.hasPendingResume] FSM remembers an interrupted task
 * @param {object} [cfg] overrides of autonomyDefaults()
 * @returns {Array<{kind, urgency, detail, advisory}>} sorted by urgency desc
 */
export function evaluateNeeds(ctx = {}, cfg = {}) {
    const c = { ...autonomyDefaults(), ...cfg };
    const needs = [];

    // 1. Broken or nearly-dead tools first — they hard-block work.
    const tools = Array.isArray(ctx.tools) ? ctx.tools : [];
    let worst = null;
    for (const t of tools) {
        if (!t || t.pct == null) continue;
        if (t.pct < c.tool_replace_threshold && (!worst || t.pct < worst.pct)) worst = t;
    }
    if (worst) {
        needs.push({
            kind: 'tool_replace',
            urgency: worst.broken ? 0.95 : 0.7,
            detail: worst.name,
            advisory: false,
            info: `${worst.name} at ${Math.round(worst.pct * 100)}% (${worst.remaining}/${worst.maxDurability})`
        });
    }

    // 2. Inventory nearly full — advisory until an unload executor exists.
    if (typeof ctx.freeSlots === 'number' && ctx.freeSlots <= c.free_slot_alert) {
        needs.push({
            kind: 'inventory_full',
            urgency: 0.8,
            detail: `${ctx.freeSlots} free slot(s)`,
            advisory: true,
            info: `Only ${ctx.freeSlots} inventory slot(s) left — unload soon.`
        });
    }

    // 3. Idle long enough with nothing pending -> go see the world.
    if (c.explore_when_idle) {
        const idleMs = ctx.idleForMs ?? 0;
        if (idleMs >= c.explore_idle_s * 1000 && !ctx.hasPendingResume) {
            // nights are for staying put unless curiosity demands otherwise
            const urgency = ctx.isNight ? 0.15 : 0.3;
            needs.push({
                kind: 'explore',
                urgency,
                detail: `idle ${Math.round(idleMs / 1000)}s`,
                advisory: false,
                info: `Idle ${Math.round(idleMs / 1000)}s; frontier exploration.`
            });
        }
    }

    needs.sort((a, b) => b.urgency - a.urgency);
    return needs;
}

/** Count free slots in the main inventory (slots 9-44 in mineflayer layout). */
export function countFreeSlots(bot) {
    const slots = bot?.inventory?.slots ?? [];
    let free = 0;
    for (let i = 9; i <= 44 && i < slots.length; i++) {
        if (slots[i] == null) free++;
    }
    return free;
}

/** Mineflayer timeOfDay is 0-24000; night is roughly 13000-23000. */
export function isNightTime(bot) {
    const t = bot?.time?.timeOfDay;
    if (typeof t !== 'number') return false;
    return t >= 13000 && t < 23000;
}
