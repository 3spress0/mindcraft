/**
 * hazards.js — hazard-aware navigation support.
 *
 * mineflayer-pathfinder's Movements already avoids fire, cobweb and lava.
 * This module classifies more hazard blocks, scans the local area for them
 * (legit: only blocks the bot can actually query), and can harden a
 * Movements instance so the pathfinder routes around hazard zones.
 */

import * as mc from '../../utils/mcdata.js';

/**
 * Damage/death blocks: never step into these if a route around exists.
 * This mirrors real Baritone's MovementHelper#avoidWalkingInto: fluids,
 * magma, cactus, sweet berry bush, fire variants and cobweb are hard hazards.
 * Soul sand and honey remain soft hazards because they are walkable.
 */
export const HARD_HAZARDS = [
    'lava', 'fire', 'soul_fire', 'magma_block', 'campfire', 'soul_campfire',
    'sweet_berry_bush', 'cactus', 'wither_rose', 'powder_snow'
];

export const SOFT_HAZARDS = [
    'soul_sand', 'honey_block', 'cobweb', 'web'
];

const TIER_MAP = new Map();
for (const name of HARD_HAZARDS) TIER_MAP.set(name, 'hard');
for (const name of SOFT_HAZARDS) TIER_MAP.set(name, 'soft');

/** 'hard' | 'soft' | null */
export function hazardTier(blockName) {
    return TIER_MAP.get(blockName) ?? null;
}

export function isHazard(blockName) {
    return TIER_MAP.has(blockName);
}

/**
 * Add hard hazard block ids to a Movements-like object's blocksToAvoid set.
 * entityCost approximates Baritone's mob-avoidance coefficient when supported.
 * `includeSoft` remains accepted for API compatibility; soft hazards are never
 * hard-blocked because pathfinder exposes no per-block cost hook.
 */
export function hardenMovements(movements, bot, { includeSoft = true, mobAvoidance = 3 } = {}) {
    if (!movements?.blocksToAvoid) return movements;
    if (typeof movements.entityCost === 'number' && mobAvoidance > 0) {
        movements.entityCost = Math.max(movements.entityCost, mobAvoidance);
    }
    const registry = bot?.registry;
    const names = includeSoft ? [...HARD_HAZARDS, ...SOFT_HAZARDS] : [...HARD_HAZARDS];
    for (const name of names) {
        let id = null;
        try {
            if (registry?.blocksByName?.[name]) id = registry.blocksByName[name].id;
            else id = mc.getBlockId?.(name);
        } catch { id = null; }
        if (id != null) movements.blocksToAvoid.add(id);
    }
    return movements;
}

/**
 * Scan for hazard blocks around a center point.
 * @param {object} bot
 * @param {object} [opts] - { center: {x,y,z}, radius (capped at 24), includeSoft }
 * @returns {Array<{name, tier, x, y, z, dist}>} sorted by distance, capped at 64.
 */
export function scanHazards(bot, { center = null, radius = 12, includeSoft = true } = {}) {
    const self = center ?? bot?.entity?.position;
    if (!self || typeof self.x !== 'number') return [];
    const r = Math.max(1, Math.min(24, Math.floor(radius)));
    const found = [];
    const seen = new Set();

    // sample on a coarse grid: every block at small radii, sparser further out
    const step = r > 12 ? 2 : 1;
    for (let dx = -r; dx <= r; dx += step) {
        for (let dz = -r; dz <= r; dz += step) {
            for (let dy = -3; dy <= 3; dy++) {
                const p = { x: Math.floor(self.x) + dx, y: Math.floor(self.y) + dy, z: Math.floor(self.z) + dz };
                let block = null;
                try { block = bot.blockAt?.(p, false); } catch { block = null; }
                if (!block) continue;
                const tier = hazardTier(block.name);
                if (!tier) continue;
                if (tier === 'soft' && !includeSoft) continue;
                const key = `${p.x},${p.y},${p.z}`;
                if (seen.has(key)) continue;
                seen.add(key);
                const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
                found.push({ name: block.name, tier, x: p.x, y: p.y, z: p.z, dist });
            }
        }
    }
    found.sort((a, b) => a.dist - b.dist);
    return found.slice(0, 64);
}

/**
 * Fall-risk evaluation at a position: how far down until solid ground,
 * and whether that drop would hurt. Water breaks the fall.
 * (GO list: fall-risk evaluation / fall-damage avoidance.)
 * @param {object} bot
 * @param {{x,y,z}} pos - a standing position (feet level)
 * @param {object} [opts] { maxCheck }
 * @returns {{risk: 'none'|'hurt'|'lethal'|'void', drop: number, water: boolean}}
 */
export function fallRiskAt(bot, pos, { maxCheck = 24 } = {}) {
    const out = { risk: 'void', drop: maxCheck, water: false };
    try {
        const x = Math.floor(pos.x);
        const z = Math.floor(pos.z);
        const solid = (name) => name && name !== 'air' && name !== 'cave_air' && !name.includes('water') && !name.includes('lava');
        for (let dy = 1; dy <= maxCheck; dy++) {
            const block = bot.blockAt?.({ x, y: Math.floor(pos.y) - dy, z }, false);
            const name = block?.name ?? 'air';
            if (name.includes('water')) out.water = true;
            if (solid(name)) {
                const drop = dy - 1;
                out.drop = drop;
                if (out.water) out.risk = 'none';
                else if (drop <= 3) out.risk = 'none';
                else if (drop <= 8) out.risk = 'hurt';
                else out.risk = 'lethal';
                return out;
            }
        }
    } catch { /* keep the default (void) */ }
    return out;
}

/** Human-readable hazard report for !hazards. */
export function hazardReport(bot, opts = {}) {
    const hazards = scanHazards(bot, opts);
    if (!hazards.length) return 'No hazards detected nearby.';
    const hard = hazards.filter(h => h.tier === 'hard');
    const soft = hazards.filter(h => h.tier === 'soft');
    const lines = [`${hazards.length} hazard block(s) nearby (${hard.length} dangerous, ${soft.length} slowing):`];
    for (const h of hazards.slice(0, 12)) {
        lines.push(`- ${h.name} [${h.tier}] at (${h.x}, ${h.y}, ${h.z}), ${h.dist.toFixed(1)}m`);
    }
    if (hazards.length > 12) lines.push(`... and ${hazards.length - 12} more`);
    return lines.join('\n');
}
