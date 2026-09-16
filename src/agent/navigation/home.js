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

const HOME_KEY = 'home';

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
