/**
 * combat.js — combat polish (GO list: Combat/defense > threat scoring,
 * shield handling, emergency escape).
 *
 * Defensive by design: the bot scores threats to decide fight/hold/flee,
 * readies weapon + shield when something is close, and has an explicit
 * emergency-escape flow. All sensing is server-reported (bot.entities,
 * health, inventory) — nothing a player couldn't see.
 */

import * as world from '../library/world.js';

/**
 * Per-mob base threat: how dangerous one of these is when it is standing
 * right next to you. Tuned for vanilla survival, no cheats.
 */
export const THREAT_TABLE = {
    creeper: 3.0,          // explodes; highest priority
    charged_creeper: 4.0,
    skeleton: 2.4,         // ranged, keeps hitting from cover
    stray: 2.4,
    wither_skeleton: 2.8,
    witch: 2.6,            // potions, ranged
    pillager: 2.6,
    vindicator: 3.0,
    ravager: 3.4,
    blaze: 2.6,
    piglin_brute: 3.0,
    zombie: 1.6,
    husk: 1.6,
    drowned: 1.6,
    zombie_villager: 1.4,
    spider: 1.4,
    cave_spider: 1.8,      // poison
    enderman: 2.0,         // only dangerous when provoked, still fast
    silverfish: 1.2,
    endermite: 1.0,
    phantom: 1.4,
    slime: 1.0,
    magma_cube: 1.4,
    ghast: 2.2,
    hoglin: 2.2,
    zombified_piglin: 1.8,
    guardian: 2.0,
    elder_guardian: 2.8,
    evoker: 3.0,
    vex: 2.2
};

const DEFAULT_THREAT = 1.2; // unknown hostile: treat as a zombie-ish melee

/** Distance falloff: adjacent = full threat, ~16 blocks = almost none. */
export function distanceFactor(dist, { near = 4, far = 16 } = {}) {
    if (dist <= near) return 1;
    if (dist >= far) return 0;
    return 1 - (dist - near) / (far - near);
}

/**
 * Score all hostiles in range.
 * @returns {{threats: Array<{name, dist, score}>, total: number, level: string}}
 */
export function scoreThreats(bot, { radius = 16, hostiles = null } = {}) {
    const self = bot?.entity?.position;
    const threats = [];
    if (self && typeof self.distanceTo === 'function') {
        for (const entity of Object.values(bot?.entities ?? {})) {
            const base = THREAT_TABLE[entity?.name];
            if (base == null && !(hostiles ?? []).includes(entity?.name)) continue;
            if (!entity.position) continue;
            const dist = self.distanceTo(entity.position);
            if (dist > radius) continue;
            threats.push({
                name: entity.name,
                dist: Math.round(dist * 10) / 10,
                score: Math.round((base ?? DEFAULT_THREAT) * distanceFactor(dist) * 100) / 100
            });
        }
    }
    threats.sort((a, b) => b.score - a.score || a.dist - b.dist);
    const total = Math.round(threats.reduce((n, t) => n + t.score, 0) * 100) / 100;
    return { threats, total, level: threatLevel(total) };
}

/** Bucketed situation assessment. */
export function threatLevel(total) {
    if (total <= 0) return 'clear';
    if (total < 2) return 'skirmish';
    if (total < 4.5) return 'danger';
    return 'overwhelm';
}

/** Weapon tiers for quick hand-choosing (attack damage ordering). */
export const WEAPONS = [
    'netherite_sword', 'diamond_sword', 'iron_sword', 'stone_sword', 'golden_sword', 'wooden_sword',
    'netherite_axe', 'diamond_axe', 'iron_axe', 'stone_axe', 'golden_axe', 'wooden_axe',
    'trident', 'bow', 'crossbow'
];

/** The best weapon currently carried, or null. */
export function bestWeapon(bot) {
    const counts = world.getInventoryCounts(bot);
    for (const w of WEAPONS) {
        if ((counts[w] ?? 0) > 0) return w;
    }
    return null;
}

/**
 * Ready for combat: hold the best weapon, shield on the off-hand when one is
 * carried. Returns what was equipped (for logging).
 */
export async function combatReady(bot) {
    const done = [];
    const counts = world.getInventoryCounts(bot);
    const weapon = bestWeapon(bot);
    if (weapon) {
        try { await bot.equip?.(slotItem(bot, weapon), 'hand'); done.push(weapon); } catch { /* best-effort */ }
    }
    if ((counts.shield ?? 0) > 0) {
        try { await bot.equip?.(slotItem(bot, 'shield'), 'off-hand'); done.push('shield'); } catch { /* best-effort */ }
    }
    return done;
}

function slotItem(bot, name) {
    return (bot?.inventory?.slots ?? []).find(s => s && s.name === name) ?? { name };
}

/**
 * Should the bot run? Pure decision: critical health or an overwhelming
 * threat score both mean disengage.
 * @returns {{flee: boolean, reason: string}}
 */
export function decideEscape(bot, { healthThreshold = 6, overwhelmAt = 4.5, radius = 16 } = {}) {
    const health = typeof bot?.health === 'number' ? bot.health : 20;
    const { total, level } = scoreThreats(bot, { radius });
    if (health <= healthThreshold) return { flee: true, reason: `health ${Math.round(health)}/20` };
    if (total >= overwhelmAt || level === 'overwhelm') return { flee: true, reason: `threat score ${total} (${level})` };
    return { flee: false, reason: `health ${Math.round(health)}/20, threat ${total} (${level})` };
}

/**
 * Emergency escape flow: disengage, shield up if carried, back away.
 * Never throws — escape must always "work".
 * @returns {Promise<string>} summary
 */
export async function executeEscape(agent, { distance = 12 } = {}) {
    const bot = agent?.bot;
    if (!bot) return 'escape: no bot';
    const steps = [];
    try {
        const ready = await combatReady(bot);
        if (ready.includes('shield')) steps.push('shield up');
    } catch { /* optional */ }
    try {
        const skills = await import('../library/skills.js');
        await skills.moveAway(bot, distance);
        steps.push(`backed off ~${distance} blocks`);
    } catch { steps.push('could not move away cleanly'); }
    return steps.length ? `escape: ${steps.join(', ')}` : 'escape: disengaged';
}
