/**
 * mental_map.js — the bot's mental map (GO list: persistent world knowledge
 * > mental map / POI notes). A journal of interesting places — villages,
 * houses, bases, farms, storage, water, landmarks, death sites — that the
 * LLM can note down ("remember this spot as a village") and read back later.
 *
 * Complements the WorldModel: the model holds verified, decaying facts; the
 * mental map holds durable, human-readable place notes with provenance
 * (told / observed / inferred), so the LLM can reason about *where things
 * are* across sessions.
 *
 * Persisted per bot at bots/<botName>/mental_map.json; bounded, atomic,
 * corrupt-file tolerant. Only legit information: positions the bot knows.
 */

import fs from 'fs';
import path from 'path';
import * as world from '../library/world.js';

export const POI_TYPES = ['village', 'house', 'base', 'farm', 'storage', 'water', 'cave', 'landmark', 'death', 'player', 'bed', 'spawn', 'portal', 'custom'];
export const MAX_POIS = 64;
const MERGE_RADIUS = 24; // same-type notes this close merge into one POI

/** All 16 bed colors — used to find the bot's respawn point (legit scan). */
export const BED_TYPES = [
    'white_bed', 'orange_bed', 'magenta_bed', 'light_blue_bed', 'yellow_bed',
    'lime_bed', 'pink_bed', 'gray_bed', 'light_gray_bed', 'cyan_bed',
    'purple_bed', 'blue_bed', 'brown_bed', 'green_bed', 'red_bed', 'black_bed'
];

function sanitizeName(name) {
    const clean = String(name ?? '').trim().replace(/[^A-Za-z0-9_ ./-]/g, '').slice(0, 32);
    return clean || null;
}

function normType(type) {
    const t = String(type ?? 'custom').trim().toLowerCase();
    return POI_TYPES.includes(t) ? t : 'custom';
}

export class MentalMap {
    /**
     * @param {object} opts { botName, dir = 'bots', now = Date.now }
     */
    constructor({ botName = 'bot', dir = 'bots', now = () => Date.now() } = {}) {
        this.botName = botName;
        this.dir = dir;
        this._now = now;
        /** name -> poi */
        this.pois = new Map();
        this.load();
    }

    filePath() {
        return path.join(this.dir, this.botName, 'mental_map.json');
    }

    /**
     * Note a place. Merges with an existing POI of the same type within
     * MERGE_RADIUS (bumps sightings, refreshes notes) instead of duplicating.
     * @returns {{poi, created: boolean}}
     */
    note(pos, { name, type = 'custom', notes = '', source = 'told' } = {}) {
        const clean = sanitizeName(name);
        if (!clean || !pos || typeof pos.x !== 'number') return null;
        const t = normType(type);
        const now = this._now();

        // merge by explicit name first, then by proximity + type
        let existing = this.pois.get(clean) ?? null;
        if (!existing) {
            for (const poi of this.pois.values()) {
                if (poi.type !== t) continue;
                if (Math.hypot(poi.x - pos.x, poi.z - pos.z) <= MERGE_RADIUS) { existing = poi; break; }
            }
        }
        if (existing) {
            existing.seen = (existing.seen ?? 1) + 1;
            existing.lastSeen = now;
            existing.source = source;
            if (notes) existing.notes = String(notes).slice(0, 160);
            this.persist();
            return { poi: existing, created: false };
        }

        const poi = {
            name: clean,
            type: t,
            x: Math.round(Number(pos.x)),
            y: Math.round(Number(pos.y)),
            z: Math.round(Number(pos.z)),
            notes: String(notes ?? '').slice(0, 160),
            source,
            seen: 1,
            firstSeen: now,
            lastSeen: now
        };
        this.pois.set(clean, poi);
        if (this.pois.size > MAX_POIS) {
            // prune least-recently-seen non-landmark POIs
            const ranked = [...this.pois.values()]
                .filter(p => p.type !== 'landmark' && p.type !== 'base')
                .sort((a, b) => (a.lastSeen ?? 0) - (b.lastSeen ?? 0));
            for (const p of ranked) {
                if (this.pois.size <= MAX_POIS) break;
                this.pois.delete(p.name);
            }
        }
        this.persist();
        return { poi, created: true };
    }

    get(name) {
        const clean = sanitizeName(name);
        return clean ? this.pois.get(clean) ?? null : null;
    }

    remove(name) {
        const clean = sanitizeName(name);
        if (!clean) return false;
        const had = this.pois.delete(clean);
        if (had) this.persist();
        return had;
    }

    list({ type = null } = {}) {
        const out = [...this.pois.values()];
        if (type) return out.filter(p => p.type === normType(type));
        return out;
    }

    /** Nearest POI to a position, optionally filtered by type. */
    nearestTo(pos, { type = null, maxDist = 512 } = {}) {
        if (!pos) return null;
        let best = null;
        let bestD = Infinity;
        for (const poi of this.list({ type })) {
            const d = Math.hypot(poi.x - pos.x, poi.y - pos.y, poi.z - pos.z);
            if (d < bestD) { bestD = d; best = poi; }
        }
        if (best && bestD <= maxDist) return { ...best, distance: Math.round(bestD * 10) / 10 };
        return null;
    }

    /** Compact, LLM-friendly summary of what the bot knows. */
    summarize({ limit = 12 } = {}) {
        const all = [...this.pois.values()].sort((a, b) => (b.lastSeen ?? 0) - (a.lastSeen ?? 0));
        const lines = [`MENTAL MAP (${all.length} place${all.length === 1 ? '' : 's'} remembered)`];
        if (!all.length) {
            lines.push('No places noted yet. Note discoveries with !notePlace <name> <type> [notes].');
            return lines.join('\n');
        }
        for (const p of all.slice(0, limit)) {
            const extra = p.notes ? ` — ${p.notes}` : '';
            const seen = p.seen > 1 ? ` (seen x${p.seen})` : '';
            lines.push(`- ${p.name} [${p.type}] at (${p.x}, ${p.y}, ${p.z})${seen}${extra}`);
        }
        if (all.length > limit) lines.push(`…and ${all.length - limit} more.`);
        return lines.join('\n');
    }

    /**
     * Enrich the map from knowledge the bot already has (home, storage
     * spots, last death) without overwriting LLM-authored notes.
     * @returns {number} POIs added
     */
    seedFromAgent(agent) {
        let added = 0;
        try {
            const home = agent?.memory_bank?.recallPlace?.('home');
            if (home && !this.nearestTo({ x: home[0], y: home[1], z: home[2] }, { type: 'base', maxDist: MERGE_RADIUS })) {
                const res = this.note({ x: home[0], y: home[1], z: home[2] }, { name: 'home', type: 'base', source: 'inferred', notes: 'home waypoint' });
                if (res?.created) added++;
            }
        } catch { /* optional enrichment */ }
        try {
            const death = agent?.memory_bank?.recallPlace?.('last_death_position');
            if (death && !this.list({ type: 'death' }).length) {
                const res = this.note({ x: death[0], y: death[1], z: death[2] }, { name: 'last-death', type: 'death', source: 'observed', notes: 'where I last died' });
                if (res?.created) added++;
            }
        } catch { /* optional enrichment */ }
        try {
            const registry = agent?._storage_spots;
            if (registry?.list) {
                for (const spot of registry.list()) {
                    if (this.nearestTo(spot, { type: 'storage', maxDist: MERGE_RADIUS })) continue;
                    const res = this.note(spot, { name: `storage-${spot.name}`, type: 'storage', source: 'inferred', notes: `named chest "${spot.name}"` });
                    if (res?.created) added++;
                }
            }
        } catch { /* optional enrichment */ }
        return added;
    }

    persist() {
        try {
            const fp = this.filePath();
            fs.mkdirSync(path.dirname(fp), { recursive: true });
            const tmp = `${fp}.tmp`;
            fs.writeFileSync(tmp, JSON.stringify({ pois: [...this.pois.values()] }, null, 2));
            fs.renameSync(tmp, fp);
            return true;
        } catch { return false; }
    }

    load() {
        try {
            const data = JSON.parse(fs.readFileSync(this.filePath(), 'utf8'));
            const pois = Array.isArray(data?.pois) ? data.pois : [];
            for (const p of pois) {
                if (!p?.name || typeof p.x !== 'number') continue;
                const name = String(p.name).slice(0, 32);
                this.pois.set(name, {
                    name,
                    type: normType(p.type),
                    x: Math.round(p.x), y: Math.round(p.y ?? 64), z: Math.round(p.z),
                    notes: String(p.notes ?? '').slice(0, 160),
                    source: String(p.source ?? 'told'),
                    seen: Number(p.seen) || 1,
                    firstSeen: Number(p.firstSeen) || 0,
                    lastSeen: Number(p.lastSeen) || 0
                });
            }
            return true;
        } catch { return false; }
    }
}

/** Shared helper: mental map for an agent's bot, cached on the agent. */
export function getMentalMap(agent) {
    const botName = agent?.bot?.username ?? agent?.name;
    if (!botName) return null;
    if (!agent._mental_map || agent._mental_map.botName !== botName) {
        agent._mental_map = new MentalMap({ botName });
    }
    return agent._mental_map;
}

/**
 * Scan for beds near the bot and note the nearest one as the respawn anchor
 * (legit: bed blocks the server reports). Returns the noted POI or null.
 */
export function noteBedIfNear(agent, { radius = 32 } = {}) {
    const bot = agent?.bot;
    const map = getMentalMap(agent);
    if (!bot || !map) return null;
    try {
        const bed = world.getNearestBlock(bot, BED_TYPES, radius);
        if (bed?.position) {
            const res = map.note(bed.position, {
                name: 'bed',
                type: 'bed',
                source: 'observed',
                notes: `${bed.name} — respawn anchor`
            });
            return res?.poi ?? null;
        }
    } catch { /* bed scan is best-effort */ }
    return null;
}
