/**
 * nether_nav.js — dedicated nether navigation logic (GO list).
 *
 * The nether is its own problem: open lava seas, fragile footing, and the
 * 1:8 scale. This module keeps the bot honest down there — hardened
 * pathfinding while inside, and plain-language nav advice (lava near the
 * route, nearest known portal, bearing to the counterpart spot) that also
 * feeds the LLM's full state. Low-level pathing stays with baritone.
 */

import { hardenMovements, scanHazards } from './hazards.js';
import { currentDimension, listPortals, netherCounterpart } from './portals.js';

/**
 * Harden the live pathfinder for nether travel (lava/fire avoidance, no
 * risky drops). Idempotent-ish and guarded; returns what it did.
 * @param {object} bot
 * @returns {{hardened:boolean, reason?:string}}
 */
export function netherHarden(bot) {
    try {
        const movements = bot?.pathfinder?.movements;
        if (!movements) return { hardened: false, reason: 'no pathfinder movements' };
        hardenMovements(movements, bot, { includeSoft: true });
        if (bot.pathfinder.setMovements) bot.pathfinder.setMovements(movements);
        bot._nether_hardened = true;
        return { hardened: true };
    } catch (e) { return { hardened: false, reason: e.message }; }
}

/**
 * Plain-language nether nav advice for a destination in the OVERWORLD.
 * Pure given its inputs; used by executePortalTrip and readable by the LLM.
 * @param {object} ctx { dimension, lavaNear, nearestPortalDist, counterpart, pos }
 * @returns {string}
 */
export function netherNavAdvice(ctx = {}) {
    const parts = [];
    if (ctx.dimension === 'the_nether') parts.push('in the nether');
    else parts.push(`outside the nether (${ctx.dimension ?? 'overworld'})`);
    if (typeof ctx.lavaNear === 'number') {
        parts.push(ctx.lavaNear > 0 ? `${ctx.lavaNear} lava block(s) nearby — careful footing` : 'no lava close by');
    }
    if (typeof ctx.nearestPortalDist === 'number') {
        parts.push(`nearest known portal ~${Math.round(ctx.nearestPortalDist)}m away`);
    }
    if (ctx.counterpart && ctx.pos) {
        const dx = ctx.counterpart.x - ctx.pos.x;
        const dz = ctx.counterpart.z - ctx.pos.z;
        const bearing = Math.round((Math.atan2(dz, dx) * 180 / Math.PI + 360) % 360);
        parts.push(`target bearing ~${bearing} deg, ${Math.round(Math.hypot(dx, dz))}m`);
    }
    return parts.join('; ');
}

/**
 * Build a live advice line for the agent (never throws).
 * @param {object} agent
 * @param {{x:number,z:number}} overworldDest
 */
export function buildNetherAdvice(agent, overworldDest = null) {
    try {
        const bot = agent?.bot;
        const dim = currentDimension(agent);
        let lavaNear = 0;
        try {
            lavaNear = scanHazards(bot, { radius: 10, includeSoft: false })
                .filter(h => String(h.name ?? '').includes('lava')).length;
        } catch { /* scan optional */ }
        let nearestPortalDist = null;
        try {
            const here = bot?.entity?.position;
            if (here) {
                for (const p of listPortals(agent, dim) ?? []) {
                    const d = Math.hypot(p.x - here.x, p.z - here.z);
                    if (nearestPortalDist == null || d < nearestPortalDist) nearestPortalDist = d;
                }
            }
        } catch { /* portals optional */ }
        let counterpart = null;
        let pos = null;
        try {
            if (overworldDest) {
                counterpart = dim === 'the_nether' ? netherCounterpart(overworldDest) : overworldDest;
                pos = bot?.entity?.position ?? null;
            }
        } catch { /* math optional */ }
        return netherNavAdvice({ dimension: dim, lavaNear, nearestPortalDist, counterpart, pos });
    } catch { return 'nether advice unavailable'; }
}
