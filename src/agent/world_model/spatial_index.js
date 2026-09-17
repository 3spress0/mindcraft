/**
 * spatial_index.js — region/chunk indexing over the world model.
 * (GO list: region/chunk indexing.)
 *
 * The world model stores facts with positions; lookups were O(n) scans.
 * This builds a chunk-bucketed index (16x16 columns) over any fact set so
 * "what do I know around here?" becomes a handful of bucket reads. Pure and
 * deterministic: index is rebuilt on demand, never persisted on its own.
 */

export const CHUNK = 16;

export function chunkKeyOf(x, z) {
    return `${Math.floor(x / CHUNK)},${Math.floor(z / CHUNK)}`;
}

/**
 * Build a chunk index over facts.
 * @param {Array} facts - objects with .position or .data.position
 * @returns {Map<string, Array>} chunk key -> facts
 */
export function buildChunkIndex(facts) {
    const index = new Map();
    for (const fact of facts ?? []) {
        const p = fact?.pos ?? fact?.position;
        if (!p || typeof p.x !== 'number' || typeof p.z !== 'number') continue;
        const key = chunkKeyOf(p.x, p.z);
        if (!index.has(key)) index.set(key, []);
        index.get(key).push(fact);
    }
    return index;
}

/**
 * Facts within `radiusChunks` chunks of a position (Chebyshev).
 * @returns {Array<{fact, dist}>} sorted by 2D distance
 */
export function factsNear(index, x, z, { radiusChunks = 1 } = {}) {
    const out = [];
    const cx = Math.floor(x / CHUNK);
    const cz = Math.floor(z / CHUNK);
    for (let dx = -radiusChunks; dx <= radiusChunks; dx++) {
        for (let dz = -radiusChunks; dz <= radiusChunks; dz++) {
            const bucket = index.get(`${cx + dx},${cz + dz}`);
            if (!bucket) continue;
            for (const fact of bucket) {
                const p = fact?.pos ?? fact?.position;
                const dist = Math.hypot(p.x - x, p.z - z);
                out.push({ fact, dist: Math.round(dist * 10) / 10 });
            }
        }
    }
    out.sort((a, b) => a.dist - b.dist);
    return out;
}

/** Index every positioned fact in a WorldModel across categories. */
export function indexWorldModel(model, categories = ['location', 'entity', 'resource', 'structure', 'threat']) {
    const facts = [];
    try {
        for (const category of categories) {
            for (const fact of model?.all?.(category) ?? []) facts.push(fact);
        }
    } catch { /* tolerate odd models */ }
    return buildChunkIndex(facts);
}

/** Digest: how knowledge is spread across regions. */
export function indexSummary(index) {
    if (!index || !index.size) return 'No positioned knowledge yet.';
    const total = [...index.values()].reduce((n, b) => n + b.length, 0);
    return `World knowledge indexed: ${total} positioned fact(s) across ${index.size} chunk region(s).`;
}
