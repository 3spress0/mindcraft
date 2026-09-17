/**
 * recall.js — spatial memory retrieval (GO list: semantic memory retrieval,
 * wired locally). Given a free-text query ("village with a blacksmith",
 * "where did I store iron", "my base"), search everything the bot knows
 * about places — mental map POIs, saved memory-bank places, named storage
 * spots, home — and rank the matches.
 *
 * Deterministic keyword scoring (no external embedding service): exact name
 * hits beat prefix hits, which beat type hits, which beat note/word hits;
 * ties break by distance from the bot. Reproducible and offline.
 */

import { getMentalMap } from './mental_map.js';
import { POI_TYPES } from './mental_map.js';

export function tokenize(text) {
    return String(text ?? '')
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter(t => t.length >= 2);
}

/** Cosine similarity of two equal-length vectors (0 when degenerate). */
export function cosineSimilarity(a, b) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length === 0 || a.length !== b.length) return 0;
    let dot = 0;
    let na = 0;
    let nb = 0;
    for (let i = 0; i < a.length; i++) {
        dot += a[i] * b[i];
        na += a[i] * a[i];
        nb += b[i] * b[i];
    }
    if (na <= 0 || nb <= 0) return 0;
    return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/**
 * Optional embedding hook (GO list: semantic memory retrieval). If the agent
 * carries an `_embedding_provider` with `embed(text) -> number[]`, recall
 * blends vector similarity into the keyword score. Providers are injected —
 * any embedding model can back it; without one, keyword scoring stands alone.
 */
async function embedDocs(agent, query, docs) {
    const provider = agent?._embedding_provider;
    if (!provider || typeof provider.embed !== 'function') return null;
    try {
        const q = await provider.embed(query);
        const out = [];
        for (const doc of docs) {
            const v = await provider.embed(doc.text);
            out.push(cosineSimilarity(q, v));
        }
        return out;
    } catch { return null; }
}

/** Build the searchable corpus of everything spatial the bot knows. */
export function buildCorpus(agent) {
    const docs = [];
    const botPos = agent?.bot?.entity?.position ?? null;

    const add = (kind, name, pos, extra = '') => {
        if (!name) return;
        docs.push({
            kind,
            name: String(name),
            x: pos?.x != null ? Math.round(pos.x) : null,
            y: pos?.y != null ? Math.round(pos.y) : null,
            z: pos?.z != null ? Math.round(pos.z) : null,
            text: `${name} ${extra}`.toLowerCase(),
            distance: pos && botPos
                ? Math.round(Math.hypot(pos.x - botPos.x, (pos.y ?? botPos.y) - botPos.y, pos.z - botPos.z) * 10) / 10
                : null
        });
    };

    try {
        const map = getMentalMap(agent);
        if (map) {
            for (const p of map.list()) {
                add('poi', p.name, p, `${p.type} ${p.notes ?? ''}`);
            }
        }
    } catch { /* corpus is best-effort */ }

    try {
        const mem = agent?.memory_bank?.memory ?? {};
        for (const [key, xyz] of Object.entries(mem)) {
            if (Array.isArray(xyz) && xyz.length >= 3) {
                add('memory', key, { x: xyz[0], y: xyz[1], z: xyz[2] }, 'saved place');
            }
        }
    } catch { /* optional */ }

    try {
        const spots = agent?._storage_spots;
        if (spots?.list) {
            for (const s of spots.list()) {
                add('storage', `storage-${s.name}`, s, `chest ${s.accepts?.join(' ') ?? ''}`);
            }
        }
    } catch { /* optional */ }

    return docs;
}

/**
 * Score one document against query tokens.
 * @returns {number} 0 = no match
 */
export function scoreDoc(doc, tokens) {
    const name = doc.name.toLowerCase();
    let score = 0;
    for (const t of tokens) {
        if (name === t) score += 5;                 // exact name
        else if (name.includes(t)) score += 3;      // name substring
        else if (doc.text.includes(t)) score += 1;  // notes/type/extra
        // type hits get a bonus for POI docs
        if (doc.kind === 'poi' && POI_TYPES.includes(t) && doc.text.includes(t)) score += 1.5;
    }
    return score;
}

/**
 * Recall matching places, best first.
 * @returns {Promise<Array<{kind, name, x, y, z, score, distance, text}>>}
 */
export async function recall(agent, query, { limit = 8, maxDistance = null } = {}) {
    const tokens = tokenize(query);
    if (!tokens.length) return [];
    const corpus = buildCorpus(agent);
    const vectorScores = await embedDocs(agent, String(query ?? '').toLowerCase(), corpus);
    const hits = [];
    corpus.forEach((doc, i) => {
        let score = scoreDoc(doc, tokens);
        if (vectorScores) {
            // blend: vector similarity boosts, keyword floor keeps sanity
            score = score + 2 * Math.max(0, vectorScores[i] ?? 0);
        }
        if (score <= 0) return;
        if (maxDistance != null && doc.distance != null && doc.distance > maxDistance) return;
        hits.push({ ...doc, score: Math.round(score * 100) / 100 });
    });
    hits.sort((a, b) =>
        b.score - a.score ||
        (a.distance ?? Infinity) - (b.distance ?? Infinity) ||
        a.name.localeCompare(b.name));
    return hits.slice(0, Math.max(1, limit));
}

/** Human-readable recall result. */
export function recallSummary(query, hits) {
    if (!hits.length) return `I don't remember anything matching "${query}".`;
    const lines = [`RECALL "${query}" (${hits.length} match${hits.length === 1 ? '' : 'es'})`];
    for (const h of hits) {
        const where = h.x != null ? ` at (${h.x}, ${h.y}, ${h.z})` : '';
        const dist = h.distance != null ? `, ${h.distance}m away` : '';
        lines.push(`- [${h.kind}] ${h.name}${where}${dist}`);
    }
    return lines.join('\n');
}
