/**
 * safe_zones.js — safe-zone seeking + durable safe/danger locations.
 * (GO list: safe-zone locations, safe-zone seeking, known safe locations,
 * known dangerous locations, fall-risk evaluation.)
 *
 * A "safe spot" is a nearby standing position with solid ground, headroom,
 * no hard hazards close by, reasonable light, and preferably overhead cover.
 * The seeker walks to the best one when danger spikes (wired into the
 * autonomy combat guard); verified spots are recorded in the world model so
 * the bot remembers where it is safe — and where it got hurt.
 *
 * Legit: only blocks the server already sent us are queried.
 */

import { scanHazards, hazardTier, fallRiskAt } from './hazards.js';

const DEFAULT_TTL_MS = 30 * 24 * 3600 * 1000; // safe/danger spots: 30 days

function posKey(p) {
    return `${Math.round(p.x)},${Math.round(p.y)},${Math.round(p.z)}`;
}

/**
 * Score a candidate standing position.
 * @returns {number|null} null when the spot is unusable
 */
export function scoreSafeSpot(bot, pos, { hazards = [] } = {}) {
    try {
        const stand = { x: Math.floor(pos.x), y: Math.floor(pos.y), z: Math.floor(pos.z) };
        const ground = bot.blockAt?.({ x: stand.x, y: stand.y - 1, z: stand.z }, false);
        if (!ground || ground.name === 'air' || ground.name === 'water' || ground.name === 'lava') return null;
        if (hazardTier(ground.name)) return null;
        const feet = bot.blockAt?.(stand, false);
        const head = bot.blockAt?.({ x: stand.x, y: stand.y + 1, z: stand.z }, false);
        const passable = (b) => !b || b.name === 'air' || b.name === 'cave_air' || b.name === 'water';
        if (!passable(feet) || !passable(head)) return null;
        // fall risk: standing on a ledge is not "safe"
        const fall = fallRiskAt(bot, stand);
        if (fall.risk === 'lethal') return null;
        // hard hazards within 2 blocks disqualify
        for (const h of hazards) {
            if (h.tier !== 'hard') continue;
            const d = Math.hypot(h.x - stand.x, h.y - stand.y, h.z - stand.z);
            if (d <= 2) return null;
        }
        let score = 1;
        // overhead cover matters at night / underground
        const roof = bot.blockAt?.({ x: stand.x, y: stand.y + 3, z: stand.z }, false);
        const covered = !!roof && roof.name !== 'air' && roof.name !== 'cave_air';
        if (covered) score += 1.5;
        // light
        let light = null;
        try { light = bot.lightLevelAt?.(stand.x, stand.y, stand.z); } catch { light = null; }
        if (typeof light === 'number') score += Math.min(1, light / 15) * 1.5;
        if (fall.risk === 'none') score += 0.5;
        return Math.round(score * 100) / 100;
    } catch {
        return null;
    }
}

/**
 * Scan for safe standing spots around the bot.
 * @returns {Array<{x,y,z,score,covered}>} best first, capped
 */
export function scanSafeSpots(bot, { radius = 8, maxSpots = 6 } = {}) {
    const self = bot?.entity?.position;
    if (!self) return [];
    const hazards = (() => {
        try { return scanHazards(bot, { radius: Math.min(16, radius + 4) }); } catch { return []; }
    })();
    const spots = [];
    const r = Math.max(2, Math.min(16, Math.floor(radius)));
    for (let dx = -r; dx <= r; dx += 2) {
        for (let dz = -r; dz <= r; dz += 2) {
            for (let dy = -1; dy <= 2; dy++) {
                const p = { x: Math.floor(self.x) + dx, y: Math.floor(self.y) + dy, z: Math.floor(self.z) + dz };
                const score = scoreSafeSpot(bot, p, { hazards });
                if (score == null) continue;
                // distance penalty: prefer close refuge
                const distPenalty = Math.hypot(dx, dz) * 0.06;
                spots.push({ x: p.x, y: p.y, z: p.z, score: Math.round((score - distPenalty) * 100) / 100 });
            }
        }
    }
    spots.sort((a, b) => b.score - a.score);
    // de-duplicate adjacent duplicates: keep one per 2x2 area
    const kept = [];
    for (const s of spots) {
        if (kept.some(k => Math.hypot(k.x - s.x, k.z - s.z) < 2)) continue;
        kept.push(s);
        if (kept.length >= maxSpots) break;
    }
    return kept;
}

/**
 * Seek refuge: walk to the best nearby safe spot; fall back to backing away.
 * Never throws — refuge is best-effort by definition.
 * @returns {Promise<string>} summary
 */
export async function seekSafeZone(agent, { radius = 10 } = {}) {
    const bot = agent?.bot;
    if (!bot) return 'safe-zone: no bot';
    let spots = [];
    try { spots = scanSafeSpots(bot, { radius }); } catch { spots = []; }
    if (!spots.length) {
        try {
            const skills = await import('../library/skills.js');
            await skills.moveAway(bot, 8);
            return 'safe-zone: no covered spot found, backed away instead';
        } catch {
            return 'safe-zone: no covered spot found and could not back away';
        }
    }
    const best = spots[0];
    try {
        const skills = await import('../library/skills.js');
        await skills.goToPosition(bot, best.x, best.y, best.z, 1);
        try { noteSafeSpot(agent, best); } catch { /* memory is optional */ }
        return `safe-zone: took cover at (${best.x}, ${best.y}, ${best.z}) [score ${best.score}]`;
    } catch {
        return `safe-zone: could not reach (${best.x}, ${best.y}, ${best.z})`;
    }
}

/** Record a verified safe spot in the world model (durable). */
export function noteSafeSpot(agent, pos, { label = 'refuge' } = {}) {
    const model = agent?.world_model;
    if (!model || !pos) return false;
    try {
        model.record('location', {
            name: `safe:${posKey(pos)}`,
            kind: 'safe_spot',
            pos: { x: Math.round(pos.x), y: Math.round(pos.y), z: Math.round(pos.z) },
            detail: { label }
        }, { expiresIn: DEFAULT_TTL_MS });
        return true;
    } catch {
        return false;
    }
}

/**
 * Record a place that hurt us / looked dangerous (durable danger map).
 * @param {object} agent
 * @param {object} opts { pos, reason }
 */
export function recordDangerSpot(agent, { pos = null, reason = 'danger' } = {}) {
    const model = agent?.world_model;
    const p = pos ?? agent?.bot?.entity?.position;
    if (!model || !p) return false;
    try {
        model.record('threat', {
            name: `danger:${posKey(p)}`,
            kind: 'danger_spot',
            pos: { x: Math.round(p.x), y: Math.round(p.y), z: Math.round(p.z) },
            detail: { reason: String(reason).slice(0, 64) }
        }, { expiresIn: DEFAULT_TTL_MS });
        return true;
    } catch {
        return false;
    }
}

/** Known safe spots from the world model, nearest first. */
export function knownSafeSpots(agent, { pos = null, maxDistance = Infinity } = {}) {
    return queryNamed(agent, 'safe:', { pos, maxDistance });
}

/** Known danger spots from the world model, nearest first. */
export function knownDangerSpots(agent, { pos = null, maxDistance = Infinity } = {}) {
    return queryNamed(agent, 'danger:', { pos, maxDistance });
}

function queryNamed(agent, prefix, { pos, maxDistance }) {
    const model = agent?.world_model;
    if (!model) return [];
    try {
        const origin = pos ?? agent?.bot?.entity?.position ?? model.player?.position;
        const found = [];
        for (const category of ['location', 'threat']) {
            for (const fact of model.all(category)) {
                if (!String(fact?.name ?? '').startsWith(prefix)) continue;
                const p = fact?.pos;
                if (!p) continue;
                let dist = 0;
                if (origin?.distanceTo) {
                    dist = origin.distanceTo({ x: p.x, y: p.y ?? origin.y, z: p.z });
                } else if (origin && typeof origin.x === 'number') {
                    dist = Math.hypot(p.x - origin.x, p.z - origin.z);
                }
                if (dist > maxDistance) continue;
                found.push({ ...p, name: fact.name, dist: Math.round(dist), label: fact?.detail?.label ?? fact?.detail?.reason ?? '' });
            }
        }
        found.sort((a, b) => a.dist - b.dist);
        return found.slice(0, 12);
    } catch {
        return [];
    }
}

/** Human-readable report for !safeSpots / !dangerSpots. */
export function safeSpotsReport(agent, { radius = 8 } = {}) {
    const live = (() => {
        try { return scanSafeSpots(agent?.bot, { radius }); } catch { return []; }
    })();
    const remembered = knownSafeSpots(agent);
    const lines = [];
    lines.push(live.length
        ? `Safe spots nearby: ${live.map(s => `(${s.x}, ${s.y}, ${s.z}) score ${s.score}`).join(', ')}`
        : 'No safe spots found nearby right now.');
    if (remembered.length) {
        lines.push(`Remembered safe places: ${remembered.slice(0, 5).map(s => `(${s.x}, ${s.y}, ${s.z}) ${s.dist}m`).join(', ')}`);
    }
    return lines.join('\n');
}

export function dangerSpotsReport(agent) {
    const spots = knownDangerSpots(agent);
    if (!spots.length) return 'No dangerous places remembered.';
    return `Remembered danger: ${spots.slice(0, 8).map(s => `(${s.x}, ${s.y}, ${s.z}) ${s.label} ${s.dist}m`).join(', ')}`;
}
