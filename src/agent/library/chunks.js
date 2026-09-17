/**
 * chunks.js — chunk-load tracking.
 * (GO list: chunk awareness, chunk-load failure handling.)
 *
 * Navigating or digging into an unloaded chunk returns null blocks and makes
 * pathfinding give up. This attaches (once) cheap load/unload listeners so
 * the agent can ask "is the ground there actually loaded?" and wait briefly
 * instead of failing. Falls back to live column probes when the events are
 * unavailable.
 */

const MAX_TRACKED = 1024;

/** Attach (once) load/unload tracking to a bot. */
export function attachChunkTracking(bot) {
    if (!bot || bot._chunk_tracking) return bot?._chunk_tracking ?? null;
    const loaded = new Map(); // "cx,cz" -> true
    bot._chunk_tracking = loaded;
    const key = (cx, cz) => `${cx},${cz}`;
    try {
        bot.on('chunkColumnLoad', (pos) => {
            try {
                if (pos == null) return;
                loaded.set(key(Math.floor(pos.x / 16), Math.floor(pos.z / 16)), true);
                if (loaded.size > MAX_TRACKED) {
                    // drop oldest (Map preserves insertion order)
                    const first = loaded.keys().next().value;
                    loaded.delete(first);
                }
            } catch { /* tracking must never throw */ }
        });
        bot.on('chunkColumnUnload', (pos) => {
            try {
                if (pos == null) return;
                loaded.delete(key(Math.floor(pos.x / 16), Math.floor(pos.z / 16)));
            } catch { /* tracking must never throw */ }
        });
    } catch { /* events unavailable on some versions */ }
    return loaded;
}

/** Is the chunk containing `pos` known to be loaded? */
export function isChunkLoaded(bot, pos) {
    try {
        if (!bot || !pos) return false;
        attachChunkTracking(bot);
        const cx = Math.floor(pos.x / 16);
        const cz = Math.floor(pos.z / 16);
        if (bot._chunk_tracking?.has(`${cx},${cz}`)) return true;
        // live probe fallback
        return !!bot.world?.getColumnAt?.({ x: cx * 16 + 8, y: 64, z: cz * 16 + 8 });
    } catch {
        return false;
    }
}

/** How many tracked chunks are currently loaded (observability). */
export function loadedChunkCount(bot) {
    try {
        attachChunkTracking(bot);
        return bot?._chunk_tracking?.size ?? 0;
    } catch {
        return 0;
    }
}

/**
 * Wait until the chunk at `pos` is loaded (or timeout). Resolves true when
 * loaded. Non-blocking for already-loaded chunks.
 */
export async function waitChunksReady(bot, pos, { timeoutMs = 3000, pollMs = 100, sleep = null } = {}) {
    const _sleep = sleep ?? ((t) => new Promise(r => setTimeout(r, t)));
    const deadline = Date.now() + Math.max(0, timeoutMs);
    // poll cadence guard so a broken isChunkLoaded can't spin forever
    while (Date.now() < deadline) {
        if (isChunkLoaded(bot, pos)) return true;
        await _sleep(Math.max(20, pollMs));
    }
    return isChunkLoaded(bot, pos);
}
