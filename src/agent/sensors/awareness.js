/**
 * awareness.js — body & world state awareness beyond radar.
 * (GO list: movement-state awareness, chunk awareness, visibility scoring,
 * sound/event awareness where Mineflayer exposes it.)
 *
 * Everything reads state the server already sent us — position, velocity,
 * control state, loaded columns, sound events. Wired into getFullState so the
 * LLM knows not just *where things are* but *how the bot itself is moving*
 * and *what it just heard*.
 */

/**
 * Movement-state awareness: how the bot's body is moving right now.
 * @returns {{onGround, inWater, sneaking, sprinting, riding, falling,
 *            fallSpeed, speedH, position: {x,y,z}|null}}
 */
export function movementState(bot) {
    const out = {
        onGround: true, inWater: false, sneaking: false, sprinting: false,
        riding: false, falling: false, fallSpeed: 0, speedH: 0, position: null
    };
    try {
        const e = bot?.entity;
        if (!e) return out;
        if (e.position) out.position = { x: Math.round(e.position.x), y: Math.round(e.position.y), z: Math.round(e.position.z) };
        if (typeof e.onGround === 'boolean') out.onGround = e.onGround;
        const vel = e.velocity;
        if (vel) {
            out.fallSpeed = Math.round(Math.min(0, vel.y) * 100) / 100;
            out.speedH = Math.round(Math.hypot(vel.x ?? 0, vel.z ?? 0) * 100) / 100;
            out.falling = !out.onGround && (vel.y ?? 0) < -0.2;
        }
        try { out.inWater = typeof bot.isInWater === 'boolean' ? bot.isInWater : !!bot?.oxygenBar != null && false; } catch { /* optional */ }
        try {
            if (typeof bot.getControlState === 'function') {
                out.sneaking = !!bot.getControlState('sneak');
                out.sprinting = !!bot.getControlState('sprint');
            } else if (bot.controlState) {
                out.sneaking = !!bot.controlState.sneak;
                out.sprinting = !!bot.controlState.sprint;
            }
        } catch { /* control state optional */ }
        out.riding = !!bot?.vehicle;
    } catch { /* awareness must never throw */ }
    return out;
}

/**
 * Chunk awareness: which chunk the bot is in and whether the ground beneath
 * (and a 3x3 of columns around it) is actually loaded.
 * @returns {{chunkX, chunkZ, loaded, loadedAround, total: number}}
 */
export function chunkStatus(bot) {
    const out = { chunkX: null, chunkZ: null, loaded: false, loadedAround: 0, total: 9 };
    try {
        const pos = bot?.entity?.position;
        if (!pos) return out;
        const cx = Math.floor(pos.x / 16);
        const cz = Math.floor(pos.z / 16);
        out.chunkX = cx;
        out.chunkZ = cz;
        const probe = (x, z) => {
            try { return !!bot.world?.getColumnAt?.({ x: x * 16 + 8, y: pos.y, z: z * 16 + 8 }); }
            catch { return false; }
        };
        let n = 0;
        for (let dx = -1; dx <= 1; dx++) {
            for (let dz = -1; dz <= 1; dz++) {
                if (probe(cx + dx, cz + dz)) n++;
            }
        }
        out.loadedAround = n;
        out.loaded = probe(cx, cz);
    } catch { /* chunk awareness must never throw */ }
    return out;
}

/**
 * Visibility scoring: 0..1 estimate of how well the bot can see a target
 * point — distance falloff x line-of-sight x light at the target.
 * Pure reading of server-reported world data.
 * @param {object} bot
 * @param {{x,y,z}} target
 * @param {object} [opts] { maxDist }
 */
export function visibilityScore(bot, target, { maxDist = 48 } = {}) {
    try {
        const self = bot?.entity?.position;
        if (!self || !target || typeof target.x !== 'number') return 0;
        const dist = Math.hypot(target.x - self.x, (target.y ?? self.y) - self.y, target.z - self.z);
        if (dist > maxDist) return 0;
        const distFactor = 1 - (dist / maxDist) * 0.6;
        // line of sight: coarse ray sampling, matching the legit-radar style
        let los = 1;
        try {
            const from = { x: self.x, y: self.y + 1.6, z: self.z };
            const to = { x: target.x, y: (target.y ?? self.y) + 0.5, z: target.z };
            const steps = Math.max(2, Math.ceil(dist / 0.5));
            let blocked = false;
            for (let i = 1; i < steps; i++) {
                const t = i / steps;
                const p = { x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t, z: from.z + (to.z - from.z) * t };
                const block = bot.blockAt?.(p, false);
                if (block && block.name !== 'air' && !block.name.includes('water') && block.name !== 'cave_air') {
                    blocked = true;
                    break;
                }
            }
            los = blocked ? 0.15 : 1;
        } catch { los = 0.5; }
        // light at the target, when the API is available
        let light = 0.75;
        try {
            const lvl = bot.lightLevelAt?.(Math.floor(target.x), Math.floor(target.y), Math.floor(target.z));
            if (typeof lvl === 'number') light = 0.35 + 0.65 * (Math.max(0, Math.min(15, lvl)) / 15);
        } catch { /* keep the default */ }
        return Math.round(distFactor * los * light * 100) / 100;
    } catch {
        return 0;
    }
}

/** Sound classes worth surfacing to the LLM (legit: server sound events). */
export const NOTABLE_SOUNDS = [
    'explosion', 'thunder', 'lightning', 'tnt', 'ghast', 'wither', 'dragon',
    'hurt', 'attack', 'break', 'explode', 'splash', 'lava', 'fall', 'anvil',
    'portal', 'bell', 'horn', 'raid'
];

/** Attach (once) a sound listener keeping a bounded ring of recent sounds. */
export function attachSoundAwareness(bot) {
    if (!bot || bot._sound_awareness) return bot?._sound_awareness ?? null;
    const ring = [];
    bot._sound_awareness = ring;
    try {
        bot.on('soundEffectHeard', (soundName, position) => {
            try {
                ring.push({
                    name: String(soundName ?? 'unknown').slice(0, 96),
                    t: Date.now(),
                    x: position?.x != null ? Math.round(position.x) : null,
                    z: position?.z != null ? Math.round(position.z) : null
                });
                if (ring.length > 48) ring.splice(0, ring.length - 48);
            } catch { /* never break on sound */ }
        });
    } catch { /* event not available on this version */ }
    return ring;
}

/** Recent sounds within a window, most recent last. */
export function recentSounds(bot, { windowMs = 10000 } = {}) {
    attachSoundAwareness(bot);
    const ring = bot?._sound_awareness;
    if (!Array.isArray(ring)) return [];
    const cutoff = Date.now() - windowMs;
    return ring.filter(s => s.t >= cutoff);
}

/** The subset of recent sounds worth mentioning to the planner. */
export function notableSounds(bot, { windowMs = 15000 } = {}) {
    return recentSounds(bot, { windowMs }).filter(s =>
        NOTABLE_SOUNDS.some(k => s.name.toLowerCase().includes(k)));
}

/** One-line sound digest for the full state / !listen. */
export function soundReport(bot, { windowMs = 15000 } = {}) {
    const sounds = recentSounds(bot, { windowMs });
    if (!sounds.length) return 'No sounds heard recently.';
    const notable = sounds.filter(s => NOTABLE_SOUNDS.some(k => s.name.toLowerCase().includes(k)));
    const shown = (notable.length ? notable : sounds).slice(-4);
    const parts = shown.map(s => {
        const where = s.x != null ? ` toward (${s.x}, ${s.z})` : '';
        return `${s.name}${where}`;
    });
    return `${sounds.length} sound(s) in the last ${Math.round(windowMs / 1000)}s; notable: ${parts.join('; ') || 'none'}`;
}

// register visibility scoring with the radar (radar does not import this
// module, so there is no cycle — radar exposes the hook, we fill it)
import('./radar.js').then(({ _setVisibilityFn }) => {
    try { _setVisibilityFn?.(visibilityScore); } catch { /* optional */ }
}).catch(() => {});

/**
 * Suffocation detection (GO list): the bot's head/eyes block is filled by a
 * solid non-air block (sand collapse, gravel, piston, buried by a build).
 * Pure read of server state — safe to call every tick.
 * @returns {{suffocating:boolean, block:string|null}}
 */
export function suffocationState(bot) {
    try {
        const pos = bot?.entity?.position;
        if (!pos) return { suffocating: false, block: null };
        for (const dy of [1, 2]) {
            const b = bot.blockAt?.({ x: pos.x, y: Math.floor(pos.y) + dy, z: pos.z }, false);
            if (b && b.name !== 'air' && b.name !== 'water' && b.name !== 'lava'
                && b.boundingBox !== 'empty') {
                return { suffocating: true, block: b.name };
            }
        }
    } catch { /* awareness must never throw */ }
    return { suffocating: false, block: null };
}

/**
 * Persistent block knowledge (GO list): remember noteworthy blocks the bot
 * can actually see — ores, stations, beds, chests — as world-model facts with
 * a TTL so stale entries prune themselves. Never throws.
 * @returns {number} facts recorded
 */
export function rememberNotableBlocks(agent, { radius = 24, max = 8 } = {}) {
    const bot = agent?.bot;
    if (!bot?.entity?.position || !agent?.world_model) return 0;
    let recorded = 0;
    try {
        const { findBlocks } = bot;
        const center = bot.entity.position;
        const oreNames = ['coal_ore', 'iron_ore', 'copper_ore', 'gold_ore', 'redstone_ore',
            'lapis_ore', 'diamond_ore', 'emerald_ore', 'deepslate_coal_ore', 'deepslate_iron_ore',
            'deepslate_copper_ore', 'deepslate_gold_ore', 'deepslate_redstone_ore',
            'deepslate_lapis_ore', 'deepslate_diamond_ore', 'deepslate_emerald_ore',
            'ancient_debris', 'nether_gold_ore', 'nether_quartz_ore'];
        const stationNames = ['crafting_table', 'furnace', 'blast_furnace', 'smoker',
            'enchanting_table', 'anvil', 'brewing_stand', 'smithing_table',
            'stonecutter', 'cartography_table', 'loom', 'grindstone', 'chest', 'bed'];
        const wanted = [...oreNames, ...stationNames];
        const found = typeof findBlocks === 'function'
            ? findBlocks({ matching: (b) => wanted.includes(b.name), maxDistance: radius, count: max * 2 })
            : [];
        for (const p of found.slice(0, max)) {
            try {
                const b = bot.blockAt?.(p, false);
                if (!b) continue;
                const kind = oreNames.includes(b.name) ? 'ore' : 'station';
                agent.world_model.record('world', {
                    name: b.name,
                    kind,
                    pos: { x: Math.round(p.x), y: Math.round(p.y), z: Math.round(p.z) },
                    detail: `${kind} spotted near (${Math.round(center.x)}, ${Math.round(center.z)})`
                }, { expiresIn: 14 * 24 * 3600 * 1000 });
                recorded++;
            } catch { /* per-block advisory */ }
        }
    } catch { /* never throw */ }
    return recorded;
}

/**
 * Entity-vanish awareness (GO list): track entities we were watching and
 * notice when they disappear without a visible cause (player logout, chunk
 * unload, despawn). Returns the entries that vanished since last call.
 */
export function trackVanishedEntities(bot, watched, { maxDist = 48 } = {}) {
    if (!bot?.entity?.position || !Array.isArray(watched) || watched.length === 0) return [];
    const vanished = [];
    try {
        const me = bot.entity.position;
        const alive = new Set();
        for (const e of Object.values(bot.entities ?? {})) {
            if (e && e.uuid != null) alive.add(e.uuid);
            else if (e && e.id != null) alive.add(e.id);
        }
        for (const w of watched) {
            if (!w || w.id == null) continue;
            if (alive.has(w.id) || alive.has(w.uuid)) continue;
            const dist = w.position
                ? Math.hypot(w.position.x - me.x, w.position.z - me.z) : 0;
            if (dist <= maxDist) vanished.push({ id: w.id, name: w.name ?? 'entity', position: w.position ?? null });
        }
    } catch { /* never throw */ }
    return vanished;
}
