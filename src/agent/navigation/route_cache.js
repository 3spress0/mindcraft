/**
 * route_cache.js — remember successful routes so the bot does not pay the
 * pathfinding probe cost (and the robotic pause that comes with it) for
 * trips it has already made. Baritone does the same with its long-term
 * path memory; here it is bounded, persisted, and verified before reuse.
 *
 * A cache hit is only replayed after verifyRoute() samples the stored
 * waypoints against the *currently observed* world (legit: blocks the bot
 * can actually query). If the world changed, the entry is invalidated and
 * normal pathfinding runs.
 */

import fs from 'fs';
import path from 'path';
import settings from '../../../settings.js';
import { hazardTier } from './hazards.js';

export const DEFAULT_TTL_MS = 15 * 60 * 1000;
export const DEFAULT_MAX_ENTRIES = 64;
const MAX_WAYPOINTS = 160;

export function routeCacheSettings() {
    const block = settings.navigation?.route_cache ?? {};
    return {
        enabled: block.enabled !== false,
        ttlMs: Math.max(30000, (block.ttl_minutes ?? 15) * 60000),
        maxEntries: Math.max(4, block.max_entries ?? DEFAULT_MAX_ENTRIES)
    };
}

/** Snap to whole blocks for stable keys. */
export function snap(pos) {
    if (!pos || typeof pos.x !== 'number') return null;
    return { x: Math.round(pos.x), y: Math.round(pos.y ?? 0), z: Math.round(pos.z) };
}

export function routeKey(from, to, profile = 'default') {
    const f = snap(from);
    const t = snap(to);
    if (!f || !t) return null;
    return `${f.x},${f.y},${f.z}>${t.x},${t.y},${t.z}@${profile}`;
}

/** Keep every Nth node, always keeping first and last. */
export function downsample(pathNodes, every = 4) {
    if (!Array.isArray(pathNodes) || pathNodes.length === 0) return [];
    const step = Math.max(1, every);
    const out = [];
    for (let i = 0; i < pathNodes.length; i += step) {
        const n = pathNodes[i];
        out.push({ x: Math.round(n.x), y: Math.round(n.y), z: Math.round(n.z) });
    }
    const last = pathNodes[pathNodes.length - 1];
    const tail = { x: Math.round(last.x), y: Math.round(last.y), z: Math.round(last.z) };
    const lastOut = out[out.length - 1];
    if (!lastOut || lastOut.x !== tail.x || lastOut.y !== tail.y || lastOut.z !== tail.z) out.push(tail);
    return out.slice(0, MAX_WAYPOINTS);
}

/**
 * Sample waypoints against the live world. A waypoint is passable when the
 * feet block is not hazardous and either walkable (empty/water) or when the
 * block below is solid and not hazardous.
 * @returns {{valid:boolean, checked:number, blocked:Array}}
 */
export function verifyRoute(bot, waypoints, { sampleEvery = 6 } = {}) {
    if (!Array.isArray(waypoints) || waypoints.length === 0) return { valid: false, checked: 0, blocked: [] };
    const step = Math.max(1, sampleEvery);
    const blocked = [];
    let checked = 0;

    const blockAtSafe = (p) => {
        try { return bot.blockAt?.(p, false); } catch { return null; }
    };

    for (let i = 0; i < waypoints.length; i += step) {
        const w = waypoints[i];
        checked++;
        const feet = blockAtSafe({ x: w.x, y: w.y, z: w.z });
        const ground = blockAtSafe({ x: w.x, y: w.y - 1, z: w.z });
        const feetOk = feet && !hazardTier(feet.name) &&
            (feet.boundingBox === 'empty' || feet.name === 'water');
        const groundOk = ground && hazardTier(ground.name) !== 'hard' &&
            (ground.boundingBox !== 'empty' || (feet && feet.name === 'water'));
        if (!feetOk || !groundOk) blocked.push({ ...w, feet: feet?.name ?? 'unknown', ground: ground?.name ?? 'unknown' });
    }
    return { valid: blocked.length === 0, checked, blocked };
}

export class RouteCache {
    /**
     * @param {object} opts - { botName, dir, ttlMs, maxEntries, now }
     */
    constructor({ botName, dir = './bots', ttlMs = null, maxEntries = null, now = () => Date.now() } = {}) {
        const cfg = routeCacheSettings();
        this.botName = botName || 'bot';
        this.dir = path.join(dir, this.botName);
        this.fp = path.join(this.dir, 'route_cache.json');
        this.ttlMs = ttlMs ?? cfg.ttlMs;
        this.maxEntries = maxEntries ?? cfg.maxEntries;
        this._now = now;
        this.entries = new Map(); // key -> { waypoints, cost, savedAt }
        this.failures = new Map(); // key -> { count, lastAt } — known failed routes
    }

    load() {
        try {
            if (!fs.existsSync(this.fp)) return this;
            const data = JSON.parse(fs.readFileSync(this.fp, 'utf8'));
            const now = this._now();
            for (const [key, entry] of Object.entries(data.entries ?? {})) {
                if (now - (entry.savedAt ?? 0) <= this.ttlMs && Array.isArray(entry.waypoints)) {
                    this.entries.set(key, entry);
                }
            }
            for (const [key, fail] of Object.entries(data.failures ?? {})) {
                if (now - (fail.lastAt ?? 0) <= this.ttlMs && Number(fail.count) > 0) {
                    this.failures.set(key, { count: Number(fail.count), lastAt: Number(fail.lastAt) });
                }
            }
        } catch (err) {
            console.error(`[route-cache] load failed: ${err.message}`);
        }
        return this;
    }

    persist() {
        try {
            fs.mkdirSync(this.dir, { recursive: true });
            const payload = {
                version: 1,
                entries: Object.fromEntries(this.entries),
                failures: Object.fromEntries(this.failures)
            };
            const tmp = `${this.fp}.${process.pid}.tmp`;
            fs.writeFileSync(tmp, JSON.stringify(payload));
            fs.renameSync(tmp, this.fp);
            return true;
        } catch (err) {
            console.error(`[route-cache] persist failed: ${err.message}`);
            return false;
        }
    }

    get(from, to, profile) {
        const key = routeKey(from, to, profile);
        if (!key) return null;
        const entry = this.entries.get(key);
        if (!entry) return null;
        if (this._now() - entry.savedAt > this.ttlMs) {
            this.entries.delete(key);
            return null;
        }
        return entry;
    }

    put(from, to, profile, { waypoints, cost = null }) {
        const key = routeKey(from, to, profile);
        if (!key || !Array.isArray(waypoints) || waypoints.length < 2) return null;
        this.entries.set(key, { waypoints, cost, savedAt: this._now() });
        this._prune();
        this.persist();
        return key;
    }

    invalidate(from, to, profile) {
        const key = routeKey(from, to, profile);
        if (!key) return false;
        const had = this.entries.delete(key);
        if (had) this.persist();
        return had;
    }

    /** Remember that a route attempt failed (GO list: known failed routes). */
    recordFailure(from, to, profile) {
        const key = routeKey(from, to, profile);
        if (!key) return null;
        const prev = this.failures.get(key) ?? { count: 0, lastAt: 0 };
        const entry = { count: prev.count + 1, lastAt: this._now() };
        this.failures.set(key, entry);
        if (this.failures.size > this.maxEntries) {
            const ordered = [...this.failures.entries()].sort((a, b) => a[1].lastAt - b[1].lastAt);
            for (let i = 0; i < ordered.length && this.failures.size > this.maxEntries; i++) {
                this.failures.delete(ordered[i][0]);
            }
        }
        this.persist();
        return entry;
    }

    /** A failed route stays "known failed" until the TTL passes. */
    isKnownFailure(from, to, profile) {
        const key = routeKey(from, to, profile);
        if (!key) return false;
        const fail = this.failures.get(key);
        if (!fail) return false;
        if (this._now() - fail.lastAt > this.ttlMs) {
            this.failures.delete(key);
            return false;
        }
        return true;
    }

    /** A successful trip forgives the route. */
    clearFailure(from, to, profile) {
        const key = routeKey(from, to, profile);
        if (!key) return false;
        const had = this.failures.delete(key);
        if (had) this.persist();
        return had;
    }

    clear() {
        const n = this.entries.size;
        this.entries.clear();
        this.persist();
        return n;
    }

    _prune() {
        if (this.entries.size <= this.maxEntries) return;
        const ordered = [...this.entries.entries()].sort((a, b) => a[1].savedAt - b[1].savedAt);
        const excess = this.entries.size - this.maxEntries;
        for (let i = 0; i < excess; i++) this.entries.delete(ordered[i][0]);
    }

    stats() {
        return {
            entries: this.entries.size,
            maxEntries: this.maxEntries,
            ttlMs: this.ttlMs,
            file: this.fp
        };
    }
}
