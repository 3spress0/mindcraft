/**
 * radar.js — legit awareness sensors, inspired by the information modules of
 * utility clients like Meteor Client and LiquidBounce (PlayerList, ESP,
 * entity trackers): exact positions, bearings and states of everything around
 * the bot — collected purely from what the server already sends us, no
 * cheats, no packets we shouldn't have.
 *
 * The point is to feed this into the AI context (full_state.js, !radar) so
 * the bot reasons about *where* players and mobs are instead of just knowing
 * that they exist.
 *
 * This module is dependency-free on purpose: it only reads the bot object,
 * so it is safe to import from anywhere (including test environments).
 */

// 16-point compass; index 0 faces +Z which is SOUTH in Minecraft. Increasing
// index rotates counter-clockwise on a north-up map (S -> E -> N -> W), which
// matches the direction of increasing atan2(dx, dz).
const COMPASS = ['S', 'SSE', 'SE', 'ESE', 'E', 'ENE', 'NE', 'NNE', 'N', 'NNW', 'NW', 'WNW', 'W', 'WSW', 'SW', 'SSW'];

/**
 * Compass bearing from the bot towards a target.
 * @returns one of 16 compass points, e.g. 'N', 'SSE'
 */
export function cardinalBearing(dx, dz) {
    // atan2(dx, dz): 0 => +Z (south), +90deg => +X (east), 180 => -Z (north).
    const angle = Math.atan2(dx, dz) * (180 / Math.PI);
    const idx = Math.round(((angle % 360) + 360) % 360 / 22.5) % 16;
    return COMPASS[idx];
}

function posOf(thing) {
    const p = thing?.position;
    if (!p || typeof p.x !== 'number') return null;
    return p;
}

function round1(v) {
    return Math.round(v * 10) / 10;
}

/** Shared entity flags (metadata index 0): onFire 0x01, sneaking 0x02, sprinting 0x08. */
function sharedFlags(entity) {
    const flags = entity?.metadata?.[0];
    if (typeof flags !== 'number') return { onFire: false, sneaking: false, sprinting: false };
    return {
        onFire: !!(flags & 0x01),
        sneaking: !!(flags & 0x02),
        sprinting: !!(flags & 0x08),
    };
}

/**
 * Best-effort health from entity metadata. The LivingEntity health index has
 * moved across versions (8 pre-1.17, 9 since); accept the first plausible one.
 */
function readHealth(entity) {
    for (const idx of [9, 8]) {
        const v = entity?.metadata?.[idx];
        if (typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 100) return v;
    }
    return null;
}

function heldItemName(entity) {
    try {
        if (typeof entity.getEquipment === 'function') {
            const eq = entity.getEquipment();
            const main = eq?.MAIN_HAND ?? eq?.mainHand;
            if (main?.name) return main.name;
        }
        const meta = entity?.metadata?.[8]; // some versions expose the carried stack here
        if (meta?.name) return meta.name;
    } catch { /* equipment not available on this version */ }
    return null;
}

/**
 * Detailed intel on every visible player (Meteor PlayerList/Tracers style).
 * @returns Array<{username, position, distance, bearing, health, flags, heldItem, ping}>
 */
/**
 * Visibility scoring hook (GO list: visibility scoring): 0..1 estimate of
 * how well the bot can currently see a position (distance x LOS x light).
 * Lazily uses sensors/awareness to avoid an import cycle at module load.
 */
let _visibilityScore = null;
export function visibilityAt(bot, pos) {
    try {
        if (!_visibilityScore) {
            // dynamic require would be async; use cached import set at first call
            return null;
        }
        return _visibilityScore(bot, pos);
    } catch {
        return null;
    }
}
export function _setVisibilityFn(fn) { _visibilityScore = fn; }

export function playerIntel(bot, maxDistance = 64) {
    const me = posOf(bot.entity);
    if (!me) return [];
    const out = [];
    for (const entity of Object.values(bot.entities || {})) {
        if (!entity || entity.type !== 'player') continue;
        const pos = posOf(entity);
        if (!pos) continue;
        const username = entity.username || bot.players && Object.keys(bot.players).find((n) => bot.players[n]?.entity === entity);
        if (!username || username === bot.username) continue;
        const distance = me.distanceTo(pos);
        if (distance > maxDistance) continue;
        const flags = sharedFlags(entity);
        const info = bot.players?.[username];
        out.push({
            username,
            position: { x: round1(pos.x), y: round1(pos.y), z: round1(pos.z) },
            distance: round1(distance),
            bearing: cardinalBearing(pos.x - me.x, pos.z - me.z),
            health: readHealth(entity),
            onGround: entity.onGround !== false,
            sneaking: flags.sneaking,
            sprinting: flags.sprinting,
            heldItem: heldItemName(entity),
            ping: info?.ping ?? null,
            visibility: visibilityAt(bot, pos),
        });
    }
    out.sort((a, b) => a.distance - b.distance);
    return out;
}

/**
 * Non-player entities with position and bearing (LiquidBounce entity-tracker
 * style). Item entities are excluded — use groundItems() for those.
 */
export function entityIntel(bot, maxDistance = 32) {
    const me = posOf(bot.entity);
    if (!me) return [];
    const out = [];
    for (const entity of Object.values(bot.entities || {})) {
        if (!entity || entity.type === 'player' || entity.name === 'item') continue;
        const pos = posOf(entity);
        if (!pos) continue;
        const distance = me.distanceTo(pos);
        if (distance > maxDistance) continue;
        out.push({
            type: entity.type || 'unknown',
            name: entity.name || entity.displayName || entity.type || 'unknown',
            id: entity.id,
            position: { x: round1(pos.x), y: round1(pos.y), z: round1(pos.z) },
            distance: round1(distance),
            bearing: cardinalBearing(pos.x - me.x, pos.z - me.z),
            health: readHealth(entity),
        });
    }
    out.sort((a, b) => a.distance - b.distance);
    return out;
}

/** Dropped item entities on the ground near the bot. */
export function groundItems(bot, maxDistance = 16) {
    const me = posOf(bot.entity);
    if (!me) return [];
    const out = [];
    for (const entity of Object.values(bot.entities || {})) {
        if (!entity || entity.name !== 'item') continue;
        const pos = posOf(entity);
        if (!pos) continue;
        const distance = me.distanceTo(pos);
        if (distance > maxDistance) continue;
        const stack = entity.metadata?.[8];
        out.push({
            item: stack?.name || stack?.itemId || 'item',
            count: stack?.itemCount ?? stack?.count ?? 1,
            position: { x: round1(pos.x), y: round1(pos.y), z: round1(pos.z) },
            distance: round1(distance),
            bearing: cardinalBearing(pos.x - me.x, pos.z - me.z),
        });
    }
    out.sort((a, b) => a.distance - b.distance);
    return out;
}

export const STORAGE_BLOCKS = new Set([
    'chest', 'trapped_chest', 'ender_chest', 'barrel',
    'furnace', 'blast_furnace', 'smoker', 'hopper',
    'dispenser', 'dropper',
    'shulker_box',
    'white_shulker_box', 'orange_shulker_box', 'magenta_shulker_box', 'light_blue_shulker_box',
    'yellow_shulker_box', 'lime_shulker_box', 'pink_shulker_box', 'gray_shulker_box',
    'light_gray_shulker_box', 'cyan_shulker_box', 'purple_shulker_box', 'blue_shulker_box',
    'brown_shulker_box', 'green_shulker_box', 'red_shulker_box', 'black_shulker_box',
]);

/**
 * Legit storage scan (ChestESP without the cheats): where are the containers
 * around me? Positions only — nothing is opened or touched.
 * @returns { positions: Array<{type,x,y,z,distance}>, counts: {type: n} }
 */
export function storageScan(bot, maxDistance = 24) {
    const me = posOf(bot.entity);
    if (!me) return { positions: [], counts: {} };
    let found = [];
    try {
        found = bot.findBlocks({
            matching: (block) => block && STORAGE_BLOCKS.has(block.name),
            maxDistance,
            count: 512,
        }) || [];
    } catch {
        return { positions: [], counts: {} };
    }
    const positions = [];
    const counts = {};
    for (const p of found) {
        const block = bot.blockAt(p);
        if (!block || !STORAGE_BLOCKS.has(block.name)) continue;
        positions.push({
            type: block.name,
            x: p.x, y: p.y, z: p.z,
            distance: round1(me.distanceTo(p)),
            bearing: cardinalBearing(p.x - me.x, p.z - me.z),
        });
        counts[block.name] = (counts[block.name] || 0) + 1;
    }
    positions.sort((a, b) => a.distance - b.distance);
    return { positions, counts };
}

/**
 * Sampled line-of-sight check between the bot's eye and a target point.
 * Passable cells (air, torches, water...) don't block; solid blocks do.
 * @param {Object} bot
 * @param {Object} target {x,y,z} — the point to look at
 * @param {Object} opts  { targetEyeHeight=0, step=0.25, maxDistance=64 }
 */
export function lineOfSight(bot, target, { targetEyeHeight = 0, step = 0.25, maxDistance = 64 } = {}) {
    const me = posOf(bot.entity);
    if (!me || !target) return false;
    const from = { x: me.x, y: me.y + 1.62, z: me.z };
    const to = { x: target.x, y: (target.y || 0) + targetEyeHeight, z: target.z };
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const dz = to.z - from.z;
    const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (dist > maxDistance) return false;
    if (dist < 1e-6) return true;

    const steps = Math.max(1, Math.floor(dist / step));
    for (let i = 1; i < steps; i++) {
        const t = i / steps;
        const p = { x: from.x + dx * t, y: from.y + dy * t, z: from.z + dz * t };
        let block = null;
        try {
            block = bot.blockAt(p, false);
        } catch {
            block = null;
        }
        if (!block) continue; // unloaded chunk: don't claim occlusion
        if (block.boundingBox === 'empty') continue; // air, torches, water...
        const name = block.name || '';
        if (name === 'air' || name.endsWith('_air')) continue;
        return false;
    }
    return true;
}

/**
 * Full radar sweep formatted for chat/AI context.
 */
export function radarReport(bot, opts = {}) {
    const players = playerIntel(bot, opts.playerRange ?? 64);
    const entities = entityIntel(bot, opts.entityRange ?? 32);
    const items = groundItems(bot, opts.itemRange ?? 16);
    const storage = storageScan(bot, opts.storageRange ?? 24);

    const lines = ['RADAR'];

    lines.push(players.length ? `Players (${players.length}):` : 'Players: none in range.');
    for (const p of players) {
        const bits = [`${p.username} at (${p.position.x}, ${p.position.y}, ${p.position.z}) — ${p.distance}m ${p.bearing}`];
        if (p.health != null) bits.push(`hp ~${Math.round(p.health)}`);
        if (p.heldItem) bits.push(`holding ${p.heldItem}`);
        if (p.sneaking) bits.push('sneaking');
        lines.push(`- ${bits.join(', ')}`);
    }

    const notable = entities.slice(0, 12);
    lines.push(notable.length ? `Entities (${entities.length}):` : 'Entities: none in range.');
    for (const e of notable) {
        lines.push(`- ${e.name} at (${e.position.x}, ${e.position.y}, ${e.position.z}) — ${e.distance}m ${e.bearing}`);
    }
    if (entities.length > notable.length) lines.push(`- ...and ${entities.length - notable.length} more`);

    lines.push(items.length ? `Ground items (${items.length}):` : 'Ground items: none in range.');
    for (const it of items.slice(0, 8)) {
        lines.push(`- ${it.item} x${it.count} at (${it.position.x}, ${it.position.y}, ${it.position.z}) — ${it.distance}m ${it.bearing}`);
    }

    const storageTypes = Object.entries(storage.counts).map(([t, n]) => `${n} ${t}`).join(', ');
    lines.push(storageTypes ? `Storage nearby: ${storageTypes}` : 'Storage: none in range.');

    return lines.join('\n');
}

/**
 * Compact player-position snapshot for the AI state (full_state.js):
 * just name, position, distance, bearing per player.
 */
export function playerPositionSnapshot(bot, maxDistance = 64, maxPlayers = 8) {
    return playerIntel(bot, maxDistance).slice(0, maxPlayers).map((p) => ({
        name: p.username,
        x: p.position.x,
        y: p.position.y,
        z: p.position.z,
        distance: p.distance,
        bearing: p.bearing,
    }));
}
