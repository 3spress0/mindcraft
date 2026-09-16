/**
 * storage/index.js — the container index / item-location database.
 *
 * GO-list coverage: Storage > container indexing, item-location database,
 * storage lookup; World model > persistent containers.
 *
 * Every time the bot looks into (or deposits/withdraws from) a container,
 * the index remembers where it is and what was inside. The AI can then answer
 * "where is my iron?" with a position instead of re-scanning the world, and
 * the radar's legit storage scan seeds positions for unopened containers.
 *
 * Best-effort by design: contents are tracked from the bot's own window
 * interactions (open/view/put/take deltas), never from packets we shouldn't
 * have. Entries are capped and pruned by age so the index stays small.
 */

import fs from 'fs';
import path from 'path';

const DEFAULT_MAX_CONTAINERS = 256;
const DEFAULT_MAX_AGE_MS = 1000 * 60 * 60 * 24 * 7; // a week without a re-scan

export function containerKey(pos) {
    return `${Math.floor(pos.x)},${Math.floor(pos.y)},${Math.floor(pos.z)}`;
}

export class StorageIndex {
    constructor({ maxContainers = DEFAULT_MAX_CONTAINERS, maxAgeMs = DEFAULT_MAX_AGE_MS } = {}) {
        this.maxContainers = maxContainers;
        this.maxAgeMs = maxAgeMs;
        /** key -> { key, type, x, y, z, items: {name: count}, updatedAt } */
        this.containers = new Map();
    }

    /**
     * Record a full container observation (opening/viewing a chest window).
     * @param {string} type  container block name, e.g. 'chest'
     * @param {Object} pos   {x,y,z}
     * @param {Array}  items [{ name, count }]
     */
    record(type, pos, items, now = Date.now()) {
        const key = containerKey(pos);
        const counts = {};
        for (const item of items || []) {
            if (!item?.name) continue;
            counts[item.name] = (counts[item.name] || 0) + (item.count || 1);
        }
        this.containers.set(key, {
            key,
            type: String(type || 'container'),
            x: Math.floor(pos.x),
            y: Math.floor(pos.y),
            z: Math.floor(pos.z),
            items: counts,
            updatedAt: now,
        });
        this._prune(now);
        return this.containers.get(key);
    }

    /**
     * Adjust a known container by a deposit/withdrawal delta without
     * re-opening it. Unknown containers are created lazily.
     */
    adjust(pos, itemName, delta, { type = 'chest', now = Date.now() } = {}) {
        if (!itemName || delta === 0) return null;
        const key = containerKey(pos);
        let entry = this.containers.get(key);
        if (!entry) {
            entry = this.record(type, pos, [], now);
        }
        const count = (entry.items[itemName] || 0) + delta;
        if (count <= 0) delete entry.items[itemName];
        else entry.items[itemName] = count;
        entry.updatedAt = now;
        return entry;
    }

    /**
     * Locate every container believed to hold an item.
     * @returns Array<{type, x, y, z, count, updatedAt}> sorted by count desc
     */
    findItem(itemName, now = Date.now()) {
        const hits = [];
        for (const entry of this.containers.values()) {
            if (now - entry.updatedAt > this.maxAgeMs) continue;
            const count = entry.items[itemName];
            if (count) {
                hits.push({ type: entry.type, x: entry.x, y: entry.y, z: entry.z, count, updatedAt: entry.updatedAt });
            }
        }
        hits.sort((a, b) => b.count - a.count);
        return hits;
    }

    /** Aggregate item totals across all known containers. */
    totals(now = Date.now()) {
        const totals = {};
        for (const entry of this.containers.values()) {
            if (now - entry.updatedAt > this.maxAgeMs) continue;
            for (const [name, count] of Object.entries(entry.items)) {
                totals[name] = (totals[name] || 0) + count;
            }
        }
        return totals;
    }

    /** Register a container position without contents (radar storage scan). */
    notePosition(type, pos, now = Date.now()) {
        const key = containerKey(pos);
        if (this.containers.has(key)) return this.containers.get(key);
        return this.record(type, pos, [], now);
    }

    forget(pos) {
        return this.containers.delete(containerKey(pos));
    }

    _prune(now = Date.now()) {
        // Age out stale entries first...
        for (const [key, entry] of this.containers) {
            if (now - entry.updatedAt > this.maxAgeMs) this.containers.delete(key);
        }
        // ...then enforce the cap, dropping oldest observations.
        if (this.containers.size <= this.maxContainers) return;
        const sorted = [...this.containers.values()].sort((a, b) => a.updatedAt - b.updatedAt);
        const excess = this.containers.size - this.maxContainers;
        for (let i = 0; i < excess; i++) this.containers.delete(sorted[i].key);
    }

    /** Human-readable rendering for !storage. */
    render(now = Date.now()) {
        const entries = [...this.containers.values()]
            .filter((e) => now - e.updatedAt <= this.maxAgeMs)
            .sort((a, b) => b.updatedAt - a.updatedAt);
        const itemCount = Object.keys(this.totals(now)).length;
        const lines = [`STORAGE INDEX (${entries.length} containers, ${itemCount} distinct items)`];
        if (entries.length === 0) {
            lines.push('No containers indexed yet. View a chest with !viewChest or scan with !radar.');
            return lines.join('\n');
        }
        for (const entry of entries.slice(0, 20)) {
            const age = Math.round((now - entry.updatedAt) / 1000);
            const ageText = age < 60 ? `${age}s ago` : age < 3600 ? `${Math.round(age / 60)}m ago` : `${Math.round(age / 3600)}h ago`;
            const items = Object.entries(entry.items)
                .sort((a, b) => b[1] - a[1])
                .slice(0, 8)
                .map(([name, count]) => `${name} x${count}`)
                .join(', ');
            lines.push(`- ${entry.type} at (${entry.x}, ${entry.y}, ${entry.z}), seen ${ageText}: ${items || 'empty'}`);
        }
        if (entries.length > 20) lines.push(`...and ${entries.length - 20} more containers`);
        return lines.join('\n');
    }

    /** Persist through the attached store, if any. Safe to call always. */
    persist() {
        try {
            if (this._store) this._store.save(this);
        } catch { /* best effort */ }
    }

    toJSON() {
        return { version: 1, containers: [...this.containers.values()] };
    }

    static fromJSON(data) {
        const index = new StorageIndex();
        for (const entry of data?.containers || []) {
            if (entry && entry.key) index.containers.set(entry.key, { items: {}, ...entry });
        }
        return index;
    }
}

/**
 * Atomic JSON persistence for a bot's storage index:
 * bots/<name>/storage_index.json (same pattern as world_model/store.js).
 */
export class StorageIndexStore {
    constructor(botName, dir = './bots') {
        this.dir = path.join(dir, botName);
        this.fp = path.join(this.dir, 'storage_index.json');
    }

    save(index) {
        try {
            fs.mkdirSync(this.dir, { recursive: true });
            const tmp = `${this.fp}.${process.pid}.tmp`;
            fs.writeFileSync(tmp, JSON.stringify(index.toJSON(), null, 2));
            fs.renameSync(tmp, this.fp);
            return true;
        } catch (err) {
            console.error(`[storage] save failed: ${err.message}`);
            return false;
        }
    }

    load() {
        try {
            if (!fs.existsSync(this.fp)) return null;
            return StorageIndex.fromJSON(JSON.parse(fs.readFileSync(this.fp, 'utf8')));
        } catch (err) {
            console.error(`[storage] failed to load index (starting fresh): ${err.message}`);
            return null;
        }
    }
}

/**
 * Lazily attach the per-agent storage index (loaded from disk on first use).
 * Also mirrors it onto the bot so skills (which only see `bot`) can feed it.
 */
export function getStorageIndex(agent) {
    if (!agent.storage_index) {
        let index = null;
        let store = null;
        try {
            store = new StorageIndexStore(agent.name);
            index = store.load();
            agent.storage_index_store = store;
        } catch { /* persistence unavailable: run in-memory */ }
        agent.storage_index = index || new StorageIndex();
        agent.storage_index._store = store;
    }
    if (agent.bot && !agent.bot._storage_index) {
        agent.bot._storage_index = agent.storage_index;
    }
    return agent.storage_index;
}

/** Persist the agent's index if a store is attached. Safe to call always. */
export function saveStorageIndex(agent) {
    try {
        if (agent.storage_index && agent.storage_index_store) {
            agent.storage_index_store.save(agent.storage_index);
        }
    } catch { /* best effort */ }
}
