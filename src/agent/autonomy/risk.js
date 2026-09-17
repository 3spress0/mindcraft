/**
 * risk.js — risk-aware planning for the autonomy loop (GO list: risk-aware
 * planning / configurable risk tolerance).
 *
 * Before the loop commits to an action, it looks at what is actually around
 * the bot right now — hostile mobs in range and whether it is night — and
 * scales that against the bot's risk posture (!setRisk). Risky autonomous
 * work (frontier exploration, farming away from base) is held when the local
 * situation is dangerous; safe upkeep (tool swaps, crafting reserves) still
 * runs.
 *
 * Legit: only entities the server has already told the bot about.
 */

import { isNightTime } from './needs.js';

export const HOSTILE_MOBS = [
    'zombie', 'husk', 'drowned', 'zombie_villager',
    'skeleton', 'stray', 'wither_skeleton', 'bogged',
    'creeper', 'spider', 'cave_spider', 'enderman',
    'witch', 'silverfish', 'slime', 'magma_cube',
    'phantom', 'pillager', 'vindicator', 'ravager', 'evoker', 'vex',
    'blaze', 'piglin_brute', 'ghast', 'warden', 'breeze', 'guardian', 'elder_guardian'
];

/** Needs that expose the bot to the world and should wait out danger. */
export const RISKY_NEEDS = new Set(['explore', 'farm', 'rest', 'patrol', 'husbandry', 'gather_resource']);

/** Posture multipliers: how much risk a posture tolerates. */
const POSTURE_SENSITIVITY = { cautious: 1.35, balanced: 1.0, bold: 0.65 };

/**
 * Assess local danger from server-reported entities.
 * @param {object} bot
 * @param {object} [opts] { radius, posture }
 * @returns {{score, level, night, hostiles: Array<{name, dist}>, posture}}
 */
export function assessLocalRisk(bot, { radius = 16, posture = null } = {}) {
    const stance = posture ?? bot?._risk_profile ?? 'balanced';
    const sensitivity = POSTURE_SENSITIVITY[stance] ?? 1.0;
    let night = false;
    try { night = isNightTime(bot); } catch { night = false; }

    const hostiles = [];
    try {
        const pos = bot?.entity?.position;
        const entities = bot?.entities ?? {};
        if (pos && typeof pos.distanceTo === 'function') {
            for (const entity of Object.values(entities)) {
                if (!entity?.name || !HOSTILE_MOBS.includes(entity.name)) continue;
                const dist = entity.position ? pos.distanceTo(entity.position) : Infinity;
                if (dist <= radius) hostiles.push({ name: entity.name, dist });
            }
        }
    } catch { /* entity scan is best-effort */ }
    hostiles.sort((a, b) => a.dist - b.dist);

    let score = 0;
    if (night) score += 0.25;
    score += Math.min(0.72, hostiles.length * 0.12);
    if (hostiles.length && hostiles[0].dist < 6) score += 0.15;
    score = Math.min(1, score * sensitivity);

    const level = score < 0.2 ? 'none' : score < 0.45 ? 'low' : 'high';
    return { score: Math.round(score * 100) / 100, level, night, hostiles, posture: stance };
}

/**
 * Drop risky needs when the local situation is dangerous.
 * Safe upkeep needs always survive.
 * @returns {Array} filtered needs (does not mutate the input)
 */
export function filterNeedsByRisk(needs, risk) {
    if (!Array.isArray(needs)) return [];
    if (!risk || risk.level !== 'high') return needs;
    return needs.filter(n => !RISKY_NEEDS.has(n.kind));
}

/** Short human-readable risk line for !autonomyStatus. */
export function riskLine(risk) {
    if (!risk) return 'risk: unknown';
    const mob = risk.hostiles.length
        ? `${risk.hostiles.length} hostile(s), nearest ${risk.hostiles[0].name} at ${Math.round(risk.hostiles[0].dist)}m`
        : 'no hostiles in range';
    return `risk: ${risk.level} (${risk.score.toFixed(2)}; ${risk.night ? 'night' : 'day'}, ${mob}, posture ${risk.posture})`;
}
