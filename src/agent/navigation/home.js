/**
 * home.js — the bot's home waypoint (GO list: Navigation > home location,
 * UI > !sethome / !home).
 *
 * Home is stored twice, deliberately redundantly:
 *   - world-model LOCATION fact with the stable key 'home' (persisted via the
 *     world-model store, queryable by !where, decays never — it is durable),
 *   - the memory bank under the name 'home' (the classic !savedPlaces store).
 *
 * Reading prefers the world model and falls back to the memory bank so older
 * saves keep working.
 */

import { publishBase, unpublishBase } from './shared_bases.js';

const HOME_KEY = 'home';

/** Best-effort publish of one of this bot's bases to the shared registry. */
function publish(agent, kind, name, pos) {
    try {
        const owner = agent?.bot?.username ?? agent?.name ?? 'bot';
        const opts = agent?._shared_bases_dir ? { dir: agent._shared_bases_dir } : {};
        publishBase(owner, kind, name, pos, opts);
    } catch { /* coordination is optional */ }
}

/** Best-effort removal from the shared registry. */
function unpublish(agent, name) {
    try {
        const owner = agent?.bot?.username ?? agent?.name ?? 'bot';
        const opts = agent?._shared_bases_dir ? { dir: agent._shared_bases_dir } : {};
        unpublishBase(owner, name, opts);
    } catch { /* coordination is optional */ }
}

function currentPos(bot) {
    const p = bot?.entity?.position;
    if (!p || typeof p.x !== 'number') return null;
    return { x: p.x, y: p.y, z: p.z };
}

/**
 * Set home to the bot's current position.
 * @returns {Object|null} the recorded position or null when position unknown
 */
export function setHome(agent) {
    const pos = currentPos(agent?.bot);
    if (!pos) return null;

    try {
        agent.world_model?.record?.('location', {
            key: HOME_KEY,
            name: HOME_KEY,
            kind: 'waypoint',
            pos: { x: Math.round(pos.x), y: Math.round(pos.y), z: Math.round(pos.z) },
            source: 'observed',
        });
    } catch { /* world model optional */ }

    try {
        agent.memory_bank?.rememberPlace?.(HOME_KEY, pos.x, pos.y, pos.z);
    } catch { /* memory bank optional */ }

    publish(agent, 'home', HOME_KEY, pos);
    return pos;
}

/**
 * Recall the home position.
 * @returns {Object|null} {x,y,z} or null when no home has been set
 */
export function getHome(agent) {
    try {
        const facts = agent?.world_model?.facts?.location || [];
        const fact = facts.find((f) => f.key === HOME_KEY);
        if (fact?.pos) return { ...fact.pos };
    } catch { /* fall through */ }

    try {
        const mem = agent?.memory_bank?.recallPlace?.(HOME_KEY);
        if (Array.isArray(mem) && mem.length >= 3) {
            return { x: mem[0], y: mem[1], z: mem[2] };
        }
    } catch { /* fall through */ }

    return null;
}

/** Outpost keys look like 'outpost:<name>'. */
const OUTPOST_PREFIX = 'outpost:';

function cleanOutpostName(name) {
    return String(name ?? '').trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
}

/**
 * Mark the current position as a named outpost (GO list: multi-base /
 * outpost management). Stored with the same redundancy as home, and noted in
 * the mental map as a 'base' POI so the LLM can read it back.
 * @returns {Object|null} the recorded position or null when unusable
 */
export function setOutpost(agent, name) {
    const clean = cleanOutpostName(name);
    if (!clean) return null;
    const pos = currentPos(agent?.bot);
    if (!pos) return null;
    const key = OUTPOST_PREFIX + clean;
    const rounded = { x: Math.round(pos.x), y: Math.round(pos.y), z: Math.round(pos.z) };

    try {
        agent.world_model?.record?.('location', {
            key,
            name: clean,
            kind: 'waypoint',
            pos: rounded,
            source: 'observed',
        });
    } catch { /* world model optional */ }

    try {
        agent.memory_bank?.rememberPlace?.(key, pos.x, pos.y, pos.z);
    } catch { /* memory bank optional */ }

    try {
        agent._mental_map?.note?.(rounded, { name: `outpost-${clean}`, type: 'base', source: 'told', notes: 'named outpost' });
    } catch { /* mental map optional */ }

    publish(agent, 'outpost', clean, pos);
    return pos;
}

/**
 * List all known outposts.
 * @returns {Array<{name, x, y, z}>}
 */
export function listOutposts(agent) {
    const out = [];
    try {
        const facts = agent?.world_model?.facts?.location || [];
        for (const fact of facts) {
            if (typeof fact?.key === 'string' && fact.key.startsWith(OUTPOST_PREFIX) && fact.pos) {
                out.push({ name: fact.key.slice(OUTPOST_PREFIX.length), ...fact.pos });
            }
        }
    } catch { /* fall through */ }
    if (out.length) return out;
    try {
        const places = agent?.memory_bank?.getJson?.() ?? {};
        for (const [key, mem] of Object.entries(places)) {
            if (key.startsWith(OUTPOST_PREFIX) && Array.isArray(mem) && mem.length >= 3) {
                out.push({ name: key.slice(OUTPOST_PREFIX.length), x: mem[0], y: mem[1], z: mem[2] });
            }
        }
    } catch { /* fall through */ }
    return out;
}

/**
 * Remove a named outpost.
 * @returns {boolean} true when something was removed
 */
export function removeOutpost(agent, name) {
    const clean = cleanOutpostName(name);
    if (!clean) return false;
    const key = OUTPOST_PREFIX + clean;
    let removed = false;
    try {
        const facts = agent?.world_model?.facts?.location || [];
        const idx = facts.findIndex((f) => f.key === key);
        if (idx >= 0) { facts.splice(idx, 1); removed = true; }
    } catch { /* optional */ }
    try {
        const mem = agent?.memory_bank?.getJson?.();
        if (mem && key in mem) { delete mem[key]; removed = true; }
    } catch { /* optional */ }
    if (removed) unpublish(agent, clean);
    return removed;
}

/**
 * The base nearest to a position: home or any outpost. Defaults to the bot's
 * current position. Falls back to home alone when no outposts exist.
 * @returns {Object|null} {x, y, z, name} where name is 'home' or the outpost name
 */
export function nearestBase(agent, pos = null) {
    const from = pos ?? currentPos(agent?.bot);
    const candidates = [];
    const home = getHome(agent);
    if (home) candidates.push({ ...home, name: 'home' });
    for (const o of listOutposts(agent)) candidates.push(o);
    if (!candidates.length) return null;
    if (!from || typeof from.x !== 'number') return candidates[0];
    let best = null;
    let bestDist = Infinity;
    for (const c of candidates) {
        const d = (c.x - from.x) ** 2 + (c.y - from.y) ** 2 + (c.z - from.z) ** 2;
        if (d < bestDist) { bestDist = d; best = c; }
    }
    return best;
}
