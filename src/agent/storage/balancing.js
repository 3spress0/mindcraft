/**
 * balancing.js — multi-chest load balancing (GO list: storage optimization).
 *
 * Instead of cramming everything into the single nearest chest, the unload
 * executor asks this module which chests to use. Ranking combines estimated
 * free capacity (from the storage index — legit, since it only reflects what
 * the bot has seen in its own container windows) with distance, and the
 * deposit list is spread across several chests so no single one overflows.
 *
 * Reservations (see placement.js) take precedence: an entry whose item type
 * matches a reserved spot is routed to that spot's chest regardless of rank.
 */

import { containerKey } from './index.js';

export const CHEST_SLOTS = 27;
export const DEFAULT_STACK = 64;

/** Estimated stacks used by a container entry (ceil per item type). */
export function estimatedStacks(entry) {
    if (!entry?.items) return 0;
    let stacks = 0;
    for (const count of Object.values(entry.items)) {
        stacks += Math.ceil(Math.max(0, count) / DEFAULT_STACK);
    }
    return stacks;
}

/** Estimated free slots (0..27) from a storage-index entry. */
export function estimatedFreeSlots(entry) {
    if (!entry) return CHEST_SLOTS; // never observed -> assume room
    return Math.max(0, CHEST_SLOTS - estimatedStacks(entry));
}

/**
 * Rank candidate chests for depositing.
 * @param {Array} chests      [{ position, name }] from world.getNearestBlocks
 * @param {object} [opts]     { index: StorageIndex, pos: bot position, maxChests }
 * @returns {Array<{pos, key, free, distance, score}>} best first
 */
export function rankChests(chests, { index = null, pos = null, maxChests = 4 } = {}) {
    const out = [];
    for (const chest of chests ?? []) {
        const cpos = chest?.position;
        if (!cpos) continue;
        const key = containerKey(cpos);
        const entry = index?.containers?.get?.(key) ?? null;
        const free = estimatedFreeSlots(entry);
        let distance = 0;
        try {
            distance = pos?.distanceTo ? pos.distanceTo(cpos) : Infinity;
        } catch { distance = Infinity; }
        // prefer emptier chests, penalize distance lightly
        const score = free - (Number.isFinite(distance) ? distance / 8 : 6);
        out.push({ pos: cpos, key, free, distance: Math.round(distance * 10) / 10, score });
    }
    out.sort((a, b) => b.score - a.score || a.distance - b.distance);
    return out.slice(0, Math.max(1, maxChests));
}

/**
 * Spread unload entries across ranked chests, never exceeding estimated
 * capacity. Entries whose type a reservation claims are routed there first.
 * @param {Array<{name, count}>} entries
 * @param {Array} chests        rankChests output
 * @param {Array} [reservations] [{ accepts: [item], x, y, z }]
 * @returns {Map<string, {pos, items: Array<{name, count}>}>>} keyed by containerKey
 */
export function distributeDeposits(entries, chests, reservations = []) {
    const plan = new Map();
    const budget = new Map(); // key -> remaining free stacks
    for (const c of chests ?? []) budget.set(c.key, c.free);

    const ensure = (key, pos) => {
        if (!plan.has(key)) plan.set(key, { pos, items: [] });
        return plan.get(key);
    };
    const stacksNeeded = (count) => Math.max(1, Math.ceil(count / DEFAULT_STACK));

    for (const entry of entries ?? []) {
        if (!entry?.name) continue;
        // 1. reservation match wins outright
        const res = (reservations ?? []).find(r =>
            Array.isArray(r.accepts) && r.accepts.includes(entry.name));
        if (res) {
            const rkey = containerKey({ x: res.x, y: res.y, z: res.z });
            ensure(rkey, { x: res.x, y: res.y, z: res.z }).items.push(entry);
            continue;
        }
        // 2. otherwise the ranked chest with the most remaining budget
        let target = null;
        for (const c of chests ?? []) {
            if ((budget.get(c.key) ?? 0) >= stacksNeeded(entry.count)) { target = c; break; }
        }
        if (!target) target = chests?.[0] ?? null; // fall back: try the best chest anyway
        if (!target) continue;
        budget.set(target.key, (budget.get(target.key) ?? 0) - stacksNeeded(entry.count));
        ensure(target.key, target.pos).items.push(entry);
    }
    return plan;
}

/** Human-readable plan summary for logs/tests. */
export function describePlan(plan) {
    const lines = [];
    for (const [, target] of plan) {
        const p = target.pos;
        const what = target.items.map(i => `${i.count}x ${i.name}`).join(', ');
        lines.push(`(${Math.floor(p.x)}, ${Math.floor(p.y)}, ${Math.floor(p.z)}): ${what}`);
    }
    return lines.join(' | ');
}
