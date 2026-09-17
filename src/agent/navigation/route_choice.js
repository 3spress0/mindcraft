/**
 * route_choice.js — risk-aware route selection (GO list: risk-aware
 * planning). Given candidate routes and known hazards, score each route by
 * how much hazard corridor it crosses and prefer the safer one, trading off
 * against raw length. Also converts hazard scans into avoid-zones the
 * frontier explorer steers around.
 *
 * Pure functions over plain data — everything stays deterministic and
 * unit-testable.
 */

import { hazardTier } from './hazards.js';

const TIER_WEIGHT = { hard: 2, soft: 1 };

function dist2D(ax, az, bx, bz) {
    return Math.hypot(ax - bx, az - bz);
}

/** Total 2D length of a waypoint route. */
export function routeLength(waypoints) {
    let len = 0;
    for (let i = 1; i < (waypoints?.length ?? 0); i++) {
        const a = waypoints[i - 1];
        const b = waypoints[i];
        len += Math.hypot(b.x - a.x, b.z - a.z);
    }
    return Math.round(len * 10) / 10;
}

/**
 * Hazard exposure of a route: how many sampled points sit within `corridor`
 * of a hazard, weighted by tier (hard hazards count double).
 * @returns {{score, samples, exposed}}
 */
export function hazardExposure(waypoints, hazards, { corridor = 4, sampleEvery = 2 } = {}) {
    const pts = waypoints ?? [];
    const hz = hazards ?? [];
    if (!pts.length) return { score: 0, samples: 0, exposed: 0 };
    let score = 0;
    let samples = 0;
    let exposed = 0;
    for (let i = 0; i < pts.length; i += Math.max(1, sampleEvery)) {
        const p = pts[i];
        samples++;
        let nearest = Infinity;
        for (const h of hz) {
            const d = dist2D(p.x, p.z, h.x, h.z);
            if (d < nearest) nearest = d;
        }
        if (nearest <= corridor) {
            exposed++;
            // weight by the closest hazard's tier
            let tier = 'soft';
            let best = Infinity;
            for (const h of hz) {
                const d = dist2D(p.x, p.z, h.x, h.z);
                if (d < best) { best = d; tier = h.tier ?? hazardTier(h.name) ?? 'soft'; }
            }
            score += TIER_WEIGHT[tier] ?? 1;
        }
    }
    return { score, samples, exposed };
}

/**
 * Choose the safest route among candidates.
 * @param {Array<{waypoints}>} routes
 * @param {Array} hazards  [{x, z, tier|name}]
 * @param {object} [opts] { corridor, riskWeight }
 * @returns {{chosen, index, scores}} — scores[i] = length + riskWeight*exposure
 */
/**
 * Score candidate routes by length + hazard exposure and pick one.
 * With `rng` + `varietyChance`, a near-equivalent alternative is occasionally
 * preferred instead — same safety class, less robotic repetition.
 */
export function chooseSaferRoute(routes, hazards = [], {
    corridor = 4, riskWeight = 8, rng = null, varietyChance = 0, varietyTolerance = 0.15
} = {}) {
    const candidates = (routes ?? []).filter(r => Array.isArray(r.waypoints) && r.waypoints.length);
    if (!candidates.length) return { chosen: null, index: -1, scores: [], varied: false };
    const scores = candidates.map(r => {
        const len = routeLength(r.waypoints);
        const exposure = hazardExposure(r.waypoints, hazards, { corridor });
        // r.penalty lets callers handicap a route (e.g. block-breaking paths)
        return Math.round((len + riskWeight * exposure.score + (Number(r.penalty) || 0)) * 10) / 10;
    });
    let best = 0;
    for (let i = 1; i < scores.length; i++) {
        if (scores[i] < scores[best]) best = i;
    }
    // Humanlike touch: sometimes take a route that is almost as good.
    let index = best;
    let varied = false;
    if (rng && varietyChance > 0 && candidates.length > 1) {
        const limit = scores[best] * (1 + varietyTolerance) + 1e-9;
        const near = [];
        for (let i = 0; i < candidates.length; i++) {
            if (i !== best && scores[i] <= limit) near.push(i);
        }
        if (near.length && rng.chance(varietyChance)) {
            index = near[Math.floor(rng.range(0, near.length)) % near.length];
            varied = true;
        }
    }
    return { chosen: candidates[index], index, scores, varied };
}

/**
 * Turn a hazard scan into circular avoid-zones for exploration.
 * Hard hazards get a wider berth.
 * @returns {Array<{x, z, r}>}
 */
export function avoidZonesFromHazards(hazards, { radius = 10, maxZones = 16 } = {}) {
    const zones = [];
    for (const h of hazards ?? []) {
        if (zones.length >= maxZones) break;
        const tier = h.tier ?? hazardTier(h.name) ?? 'soft';
        const r = radius + (tier === 'hard' ? 4 : 0);
        zones.push({ x: h.x, z: h.z, r });
    }
    return zones;
}

/** Whether a point falls inside any avoid-zone. */
export function inAvoidZone(x, z, zones) {
    for (const zone of zones ?? []) {
        if (dist2D(x, z, zone.x, zone.z) <= zone.r) return true;
    }
    return false;
}
