/**
 * placement.js — named storage locations (GO list: named storage locations,
 * storage-aware planning).
 *
 * The bot remembers chests it is told about ("!nameStorage tools") and where
 * it last unloaded. The autonomy loop uses these spots to route deposits
 * beyond the nearest-chest horizon, and the player can ask where things are
 * meant to go.
 *
 * Persisted per bot at bots/<botName>/storage_spots.json; bounded, atomic,
 * corrupt-file tolerant — same conventions as the player ledger.
 *
 * Names starting with '_' are internal bookkeeping (e.g. `_last_unload`) and
 * are hidden from listings but still usable for routing.
 */

import fs from 'fs';
import path from 'path';

export const MAX_SPOTS = 64;

function sanitizeName(name) {
    const clean = String(name ?? '').trim().replace(/[^A-Za-z0-9_ -]/g, '').slice(0, 24);
    return clean || null;
}

function spotKey(pos) {
    return `${Math.floor(pos.x)},${Math.floor(pos.y)},${Math.floor(pos.z)}`;
}

export class StorageSpotRegistry {
    /**
     * @param {object} opts { botName, dir = 'bots', now = Date.now }
     */
    constructor({ botName = 'bot', dir = 'bots', now = () => Date.now() } = {}) {
        this.botName = botName;
        this.dir = dir;
        this._now = now;
        /** name -> { name, x, y, z, type, updatedAt } */
        this.spots = new Map();
        this.load();
    }

    filePath() {
        return path.join(this.dir, this.botName, 'storage_spots.json');
    }

    /** Add or update a named spot. Returns the stored spot, or null if invalid. */
    add(name, pos, type = 'chest') {
        const clean = sanitizeName(name);
        if (!clean || !pos) return null;
        const existing = this.spots.get(clean);
        this.spots.set(clean, {
            name: clean,
            x: Math.floor(pos.x),
            y: Math.floor(pos.y),
            z: Math.floor(pos.z),
            type: String(type || 'chest'),
            accepts: existing?.accepts ?? null, // preserve reservations on re-add
            updatedAt: this._now()
        });
        // prune overflow: drop oldest non-internal spots first
        if (this.spots.size > MAX_SPOTS) {
            const entries = [...this.spots.entries()]
                .filter(([n]) => !n.startsWith('_'))
                .sort((a, b) => a[1].updatedAt - b[1].updatedAt);
            for (const [n] of entries) {
                if (this.spots.size <= MAX_SPOTS) break;
                this.spots.delete(n);
            }
        }
        this.persist();
        return this.spots.get(clean);
    }

    get(name) {
        const clean = sanitizeName(name);
        return clean ? this.spots.get(clean) ?? null : null;
    }

    /**
     * Reserve a named spot for specific item types (storage reservation).
     * Pass an empty list to clear the reservation.
     * @returns the updated spot, or null if the spot doesn't exist
     */
    reserve(name, itemTypes = []) {
        const clean = sanitizeName(name);
        const spot = clean ? this.spots.get(clean) : null;
        if (!spot) return null;
        const accepts = (itemTypes ?? [])
            .map(t => String(t ?? '').trim().toLowerCase())
            .filter(Boolean)
            .slice(0, 32);
        spot.accepts = accepts.length ? [...new Set(accepts)] : null;
        spot.updatedAt = this._now();
        this.persist();
        return spot;
    }

    /** All reservations: spots that only accept specific item types. */
    reservations() {
        return [...this.spots.values()].filter(s => Array.isArray(s.accepts) && s.accepts.length);
    }

    /** Find the reservation (if any) that claims an item type. */
    reservationFor(itemName) {
        const item = String(itemName ?? '').toLowerCase();
        return this.reservations().find(s => s.accepts.includes(item)) ?? null;
    }

    remove(name) {
        const clean = sanitizeName(name);
        if (!clean) return false;
        const had = this.spots.delete(clean);
        if (had) this.persist();
        return had;
    }

    /** All spots; hide internal '_'-prefixed names unless asked. */
    list({ includeInternal = false } = {}) {
        const out = [...this.spots.values()];
        if (!includeInternal) return out.filter(s => !s.name.startsWith('_'));
        return out;
    }

    /** Nearest spot to a position, within maxDist (Euclidean). */
    nearestTo(pos, { maxDist = 64, includeInternal = true } = {}) {
        if (!pos) return null;
        let best = null;
        let bestD = Infinity;
        for (const spot of this.spots.values()) {
            if (!includeInternal && spot.name.startsWith('_')) continue;
            const d = Math.hypot(spot.x - pos.x, spot.y - pos.y, spot.z - pos.z);
            if (d < bestD) { bestD = d; best = spot; }
        }
        if (best && bestD <= maxDist) return { ...best, distance: Math.round(bestD * 10) / 10 };
        return null;
    }

    persist() {
        try {
            const fp = this.filePath();
            fs.mkdirSync(path.dirname(fp), { recursive: true });
            const tmp = `${fp}.tmp`;
            fs.writeFileSync(tmp, JSON.stringify({ spots: [...this.spots.values()] }, null, 2));
            fs.renameSync(tmp, fp);
            return true;
        } catch { return false; }
    }

    load() {
        try {
            const raw = fs.readFileSync(this.filePath(), 'utf8');
            const data = JSON.parse(raw);
            const spots = Array.isArray(data?.spots) ? data.spots : [];
            for (const s of spots) {
                if (!s?.name || typeof s.x !== 'number') continue;
                this.spots.set(String(s.name).slice(0, 24), {
                    name: String(s.name).slice(0, 24),
                    x: Math.floor(s.x), y: Math.floor(s.y), z: Math.floor(s.z),
                    type: String(s.type || 'chest'),
                    accepts: Array.isArray(s.accepts) ? s.accepts.slice(0, 32) : null,
                    updatedAt: Number(s.updatedAt) || 0
                });
            }
            return true;
        } catch { return false; }
    }
}

/** Shared helper: registry for an agent's bot, if it has a name. */
export function getSpotRegistry(agent) {
    const botName = agent?.bot?.username ?? agent?.name;
    if (!botName) return null;
    if (!agent._storage_spots || agent._storage_spots.botName !== botName) {
        agent._storage_spots = new StorageSpotRegistry({ botName });
    }
    return agent._storage_spots;
}

export const _internal = { sanitizeName, spotKey };
