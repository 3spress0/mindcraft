/**
 * shared_bases.js — multi-agent base coordination (GO list: multi-agent
 * outpost coordination).
 *
 * Every agent in the process publishes its home/outposts to one shared,
 * file-backed registry (`bots/shared/bases.json` by default). Any agent can
 * then see where its companions live and route there — the social version of
 * the mental map, without any extra server traffic.
 */

import fs from 'fs';
import path from 'path';

export const DEFAULT_SHARED_DIR = './bots/shared';
const FILE = 'bases.json';

function registryPath(dir = DEFAULT_SHARED_DIR) {
    return path.join(dir, FILE);
}

/** Read the whole registry; {} on any problem. */
export function loadRegistry(dir = DEFAULT_SHARED_DIR) {
    try {
        return JSON.parse(fs.readFileSync(registryPath(dir), 'utf8')) ?? {};
    } catch { return {}; }
}

/** Atomic write; never throws. */
export function saveRegistry(registry, dir = DEFAULT_SHARED_DIR) {
    try {
        fs.mkdirSync(dir, { recursive: true });
        const fp = registryPath(dir);
        const tmp = `${fp}.${process.pid}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify(registry, null, 1));
        fs.renameSync(tmp, fp);
        return true;
    } catch { return false; }
}

/**
 * Publish one of this bot's bases to the shared registry.
 * @param {string} owner - bot name
 * @param {string} kind - 'home' | 'outpost'
 * @param {string} name - base name (home is 'home')
 * @param {{x,y,z}} pos
 */
export function publishBase(owner, kind, name, pos, { dir = DEFAULT_SHARED_DIR, now = () => Date.now() } = {}) {
    if (!owner || !pos || typeof pos.x !== 'number') return false;
    const key = `${owner}:${name}`;
    const registry = loadRegistry(dir);
    registry[key] = {
        owner,
        kind,
        name,
        x: Math.round(pos.x),
        y: Math.round(pos.y),
        z: Math.round(pos.z),
        updatedAt: now()
    };
    return saveRegistry(registry, dir);
}

/** Remove one base from the registry (e.g. outpost deleted). */
export function unpublishBase(owner, name, { dir = DEFAULT_SHARED_DIR } = {}) {
    const registry = loadRegistry(dir);
    const key = `${owner}:${name}`;
    if (!(key in registry)) return false;
    delete registry[key];
    return saveRegistry(registry, dir);
}

/** Drop everything an owner published (bot retired/renamed). */
export function unpublishOwner(owner, { dir = DEFAULT_SHARED_DIR } = {}) {
    const registry = loadRegistry(dir);
    let changed = false;
    for (const key of Object.keys(registry)) {
        if (key.startsWith(`${owner}:`)) { delete registry[key]; changed = true; }
    }
    return changed ? saveRegistry(registry, dir) : false;
}

/** All shared bases, optionally filtered by owner. Nearest-first when `pos` given. */
export function listSharedBases({ owner = null, pos = null, dir = DEFAULT_SHARED_DIR } = {}) {
    const entries = Object.values(loadRegistry(dir))
        .filter(e => !owner || e.owner === owner);
    if (pos && typeof pos.x === 'number') {
        entries.sort((a, b) => {
            const da = (a.x - pos.x) ** 2 + (a.z - pos.z) ** 2;
            const db = (b.x - pos.x) ** 2 + (b.z - pos.z) ** 2;
            return da - db;
        });
    } else {
        entries.sort((a, b) => `${a.owner}:${a.name}`.localeCompare(`${b.owner}:${b.name}`));
    }
    return entries;
}

/** The shared base nearest to a position (any owner), or null. */
export function nearestSharedBase(pos, { dir = DEFAULT_SHARED_DIR } = {}) {
    return listSharedBases({ pos, dir })[0] ?? null;
}
