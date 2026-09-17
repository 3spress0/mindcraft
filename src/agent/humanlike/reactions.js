/**
 * reactions.js — context-dependent humanlike reactions.
 * (GO list: context-dependent reaction speed, hesitate before uncertain
 * actions, food selection based on context, avoid unnecessary inventory
 * rearrangement, occasional route reconsideration.)
 *
 * All randomness flows through the agent's seeded personality RNG; every
 * delay is bounded so humanization can never stall an action.
 */

import settings from '../../../settings.js';

/**
 * Context-dependent reaction delay: urgent situations react faster,
 * cautious personalities a touch slower. Returns ms, always bounded.
 * @param {object} agent
 * @param {object} [opts] { urgency: 'urgent'|'normal'|'relaxed', baseMs }
 */
export function contextReactionMs(agent, { urgency = 'normal', baseMs = null } = {}) {
    try {
        const base = baseMs ?? settings?.humanlike?.reaction_delay_ms ?? 220;
        const urgencyScale = urgency === 'urgent' ? 0.45 : urgency === 'relaxed' ? 1.5 : 1.0;
        let ms = base * urgencyScale;
        const personality = agent?.personality;
        if (personality?.timing) ms = personality.timing(ms, 0.3);
        else if (personality?.traits) ms *= (1.2 - (personality.traits.pace ?? 0.5) * 0.4);
        return Math.round(Math.max(0, Math.min(1500, ms)));
    } catch {
        return 200;
    }
}

/**
 * Hesitate before an uncertain/risky action: a short, personality-paced
 * pause that reads as "thinking it over" rather than lag. Never throws and
 * never sleeps longer than maxMs.
 * @param {object} agent
 * @param {string} label - what is being considered (for logs)
 * @param {object} [opts] { risk: 'low'|'normal'|'high', maxMs, sleep }
 * @returns {Promise<number>} ms actually waited
 */
export async function hesitate(agent, label = 'action', { risk = 'normal', maxMs = 900, sleep = null } = {}) {
    try {
        const riskScale = risk === 'high' ? 1.0 : risk === 'low' ? 0.4 : 0.7;
        let ms = Math.min(maxMs, 250 + 650 * riskScale);
        const personality = agent?.personality;
        if (personality?.timing) ms = personality.timing(ms, 0.4);
        else if (personality?.traits) ms *= 0.7 + (personality.traits.caution ?? 0.5) * 0.6;
        ms = Math.round(Math.max(0, Math.min(maxMs, ms)));
        const _sleep = sleep ?? ((t) => new Promise(r => setTimeout(r, t)));
        if (ms > 0) await _sleep(ms);
        try {
            const { logEvent } = await import('../library/structlog.js');
            logEvent(agent, 'autonomy', 'hesitation', { label, risk, ms });
        } catch { /* optional */ }
        return ms;
    } catch {
        return 0;
    }
}

/**
 * Food selection based on context. Picks a carried food item:
 *   - 'combat'    → fastest to eat (most plentiful, cheap)
 *   - 'settle'    → most filling per item (prefer high-value foods)
 *   - 'normal'    → whatever we have most of
 * Pure given inventory items; used by eat flows and tests.
 * @param {Array<{name, count}>} items
 * @param {string} context
 * @returns {string|null} item name or null
 */
export const HIGH_VALUE_FOODS = [
    'enchanted_golden_apple', 'golden_apple', 'golden_carrot', 'cooked_beef',
    'cooked_porkchop', 'cooked_mutton', 'cooked_chicken', 'cooked_salmon',
    'cooked_cod', 'baked_potato', 'bread'
];
export const QUICK_FOODS = ['bread', 'cooked_beef', 'cooked_porkchop', 'golden_carrot', 'baked_potato', 'cooked_chicken'];

export function chooseFood(items, context = 'normal') {
    const edible = (items ?? []).filter(i => i && i.name && (i.count ?? 1) > 0 && isFoodName(i.name));
    if (!edible.length) return null;
    if (context === 'settle') {
        for (const name of HIGH_VALUE_FOODS) {
            const found = edible.find(i => i.name === name);
            if (found) return found.name;
        }
    }
    if (context === 'combat') {
        for (const name of QUICK_FOODS) {
            const found = edible.find(i => i.name === name);
            if (found) return found.name;
        }
    }
    // default: most plentiful
    return [...edible].sort((a, b) => (b.count ?? 1) - (a.count ?? 1))[0].name;
}

function isFoodName(name) {
    return HIGH_VALUE_FOODS.includes(name) || QUICK_FOODS.includes(name) ||
        ['apple', 'melon_slice', 'sweet_berries', 'carrot', 'potato', 'baked_potato',
            'beetroot', 'beetroot_soup', 'mushroom_stew', 'rabbit_stew', 'suspicious_stew',
            'cookie', 'pumpkin_pie', 'cake', 'honey_bottle', 'dried_kelp', 'rotten_flesh',
            'raw_beef', 'raw_chicken', 'raw_mutton', 'raw_porkchop', 'raw_cod', 'raw_salmon',
            'tropical_fish', 'pufferfish', 'spider_eye', 'poisonous_potato', 'chorus_fruit'].includes(name);
}

/**
 * Is sorting this container actually worthwhile? Counts "item runs" (groups
 * of consecutive non-empty slots holding different items); sorting only pays
 * off when rearranging clearly reduces scatter. Avoids robotic "sort every
 * chest we touch" behavior.
 * @param {Array<{name}|null>} slots - container slots in order
 * @returns {{warranted, runs, scatteredTypes}}
 */
export function sortWarranted(slots) {
    const filled = (slots ?? []).filter(Boolean);
    if (filled.length < 4) return { warranted: false, runs: filled.length, scatteredTypes: 0 };
    let runs = 0;
    let prev = null;
    for (const s of slots ?? []) {
        if (!s) { prev = null; continue; }
        if (prev !== s.name) runs++;
        prev = s.name;
    }
    const typeCounts = new Map();
    for (const s of filled) typeCounts.set(s.name, (typeCounts.get(s.name) ?? 0) + 1);
    const scatteredTypes = [...typeCounts.values()].filter(n => n > 1).length;
    // worthwhile when runs clearly exceed distinct types (scatter)
    const distinct = typeCounts.size;
    return { warranted: runs > distinct * 1.5 && scatteredTypes >= 1, runs, scatteredTypes };
}

/**
 * Should an in-progress route be reconsidered? Seeded, bounded, and only
 * ever for long routes — returns true occasionally so navigation re-checks
 * hazards mid-route instead of blindly following a stale line.
 * @param {object} rng - seeded rng with .chance()
 * @param {object} [opts] { distTraveled, minDist, chance }
 */
export function routeReconsiderationDue(rng, { distTraveled = 0, minDist = 24, chance = 0.12 } = {}) {
    if (distTraveled < minDist) return false;
    try { return rng ? rng.chance(chance) : Math.random() < chance; }
    catch { return false; }
}
