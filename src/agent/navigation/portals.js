/**
 * portals.js — portal locations & routing groundwork (GO list: Navigation >
 * portal locations / portal routing).
 *
 * The bot finds nether portals the legit way (they are ordinary server-
 * reported blocks), remembers them as 'portal' POIs per dimension, anchors
 * arrivals when the server moves it between dimensions, and does the classic
 * 1:8 overworld<->nether coordinate math to plan portal trips.
 */

import { Vec3 } from 'vec3';

export const PORTAL_BLOCK = 'nether_portal';
/** Overworld:nether scale. */
export const NETHER_SCALE = 8;

/**
 * Find portal block clusters nearby. Adjacent portal blocks collapse into
 * one portal position (the cluster average) — a portal is a frame, not N
 * separate points.
 * @returns {Array<{x, y, z, blocks}>} nearest first
 */
export function scanPortals(bot, { radius = 32, maxPortals = 4 } = {}) {
    const self = bot?.entity?.position;
    if (!self) return [];
    let positions = [];
    try {
        positions = bot.findBlocks?.({ matching: (id) => true, maxDistance: radius, count: 256 }) ?? [];
    } catch { return []; }
    const portalBlocks = [];
    for (const p of positions) {
        try {
            const b = bot.blockAt?.(p);
            if (b?.name === PORTAL_BLOCK) portalBlocks.push(p);
        } catch { /* skip */ }
    }
    if (!portalBlocks.length) return [];

    // cluster blocks that touch (Chebyshev distance <= 2)
    const clusters = [];
    for (const p of portalBlocks) {
        let placed = false;
        for (const c of clusters) {
            if (c.some(q => Math.max(Math.abs(q.x - p.x), Math.abs(q.y - p.y), Math.abs(q.z - p.z)) <= 2)) {
                c.push(p);
                placed = true;
                break;
            }
        }
        if (!placed) clusters.push([p]);
    }
    const portals = clusters.slice(0, maxPortals).map(blocks => {
        const n = blocks.length;
        const sum = blocks.reduce((acc, b) => ({ x: acc.x + b.x, y: acc.y + b.y, z: acc.z + b.z }), { x: 0, y: 0, z: 0 });
        return { x: Math.round(sum.x / n), y: Math.round(sum.y / n), z: Math.round(sum.z / n), blocks: n };
    });
    portals.sort((a, b) => {
        const da = (a.x - self.x) ** 2 + (a.z - self.z) ** 2;
        const db = (b.x - self.x) ** 2 + (b.z - self.z) ** 2;
        return da - db;
    });
    return portals;
}

function portalName(dim) {
    return `portal-${dim === 'the_nether' ? 'nether' : 'overworld'}`;
}

/** Remember a portal position (mental map 'portal' POI + world-model fact). */
export function notePortalAt(agent, pos, dim = null, { suffix = '' } = {}) {
    if (!pos || typeof pos.x !== 'number') return null;
    const dimension = dim ?? currentDimension(agent);
    const name = portalName(dimension) + suffix;
    const rounded = { x: Math.round(pos.x), y: Math.round(pos.y), z: Math.round(pos.z) };
    try {
        agent?._mental_map?.note?.(rounded, {
            name, type: 'portal', source: 'observed',
            notes: `nether portal in ${dimension}`
        });
    } catch { /* optional */ }
    try {
        agent?.world_model?.record?.('location', {
            key: `portal:${dimension}`,
            name,
            kind: 'portal',
            pos: rounded,
            source: 'observed',
        });
    } catch { /* optional */ }
    return rounded;
}

/** Note any portals within radius. Returns new POIs created. */
export function notePortalsIfNear(agent, { radius = 32 } = {}) {
    const portals = scanPortals(agent?.bot, { radius });
    let noted = 0;
    const dim = currentDimension(agent);
    portals.forEach((p, i) => {
        const res = notePortalAt(agent, p, dim, { suffix: portals.length > 1 ? `-${i + 1}` : '' });
        if (res) noted++;
    });
    return noted;
}

/** Current dimension string, resilient to odd server states. */
export function currentDimension(agent) {
    try {
        const d = agent?.bot?.game?.dimension;
        if (typeof d === 'string') return d;
        if (d && typeof d === 'object' && typeof d.name === 'string') return d.name;
    } catch { /* fall through */ }
    return 'overworld';
}

/** Remembered portals for a dimension (mental map first). */
export function listPortals(agent, dim = null) {
    const out = [];
    try {
        const pois = agent?._mental_map?.list?.({ type: 'portal' }) ?? [];
        const prefix = dim == null ? null : (dim === 'the_nether' ? 'portal-nether' : 'portal-overworld');
        for (const p of pois) {
            if (!prefix || String(p.name ?? '').startsWith(prefix)) {
                out.push({ name: p.name, x: p.x, y: p.y, z: p.z, notes: p.notes });
            }
        }
    } catch { /* optional */ }
    return out;
}

/** Overworld -> nether counterpart (1:8). */
export function netherCounterpart(pos) {
    return { x: Math.round(pos.x / NETHER_SCALE), y: pos.y ?? 64, z: Math.round(pos.z / NETHER_SCALE) };
}

/** Nether -> overworld counterpart (1:8). */
export function overworldCounterpart(pos) {
    return { x: Math.round(pos.x * NETHER_SCALE), y: pos.y ?? 64, z: Math.round(pos.z * NETHER_SCALE) };
}

/**
 * Plan a portal trip to an overworld destination. Pure planning — returns
 * explicit steps the bot (or player) can follow. Uses remembered portals
 * when it knows them.
 * @returns {{steps: string[], netherTarget: object, portalKnown: boolean}}
 */
export function planPortalTrip(agent, dest, { fromDim = null } = {}) {
    if (!dest || typeof dest.x !== 'number' || typeof dest.z !== 'number') {
        return { steps: ['Need a destination: !portalPlan <x> <z>'], netherTarget: null, portalKnown: false };
    }
    const dim = fromDim ?? currentDimension(agent);
    const netherTarget = netherCounterpart(dest);
    const herePortal = listPortals(agent, dim)[0] ?? null;
    const steps = [];
    if (dim === 'the_nether') {
        steps.push(`Travel through the nether to about (${netherTarget.x}, ${netherTarget.z}).`);
        steps.push(herePortal
            ? `Build or enter a portal near (${netherTarget.x}, ${netherTarget.z}) — known portal "${herePortal.name}" at (${Math.round(herePortal.x)}, ${Math.round(herePortal.z)}) may help.`
            : `Build a portal near (${netherTarget.x}, ${netherTarget.z}) and light it.`);
        steps.push(`Arrive in the overworld near (${Math.round(dest.x)}, ${Math.round(dest.z)}).`);
    } else {
        steps.push(herePortal
            ? `Go to the known portal "${herePortal.name}" at (${Math.round(herePortal.x)}, ${Math.round(herePortal.y)}, ${Math.round(herePortal.z)}).`
            : 'Find or build a nether portal and light it.');
        steps.push(`In the nether, travel to about (${netherTarget.x}, ${netherTarget.z}) (overworld / ${NETHER_SCALE}).`);
        steps.push(`Build or use a portal there; it links back near (${Math.round(dest.x)}, ${Math.round(dest.z)}).`);
    }
    return { steps, netherTarget, portalKnown: !!herePortal };
}
