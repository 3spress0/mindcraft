/**
 * base.js — proactive base maintenance (GO list: self-maintained base).
 *
 * The most common base problem is darkness letting mobs spawn. This module
 * scans the area around the bot's home for dark spots and places torches
 * there — bounded, interrupt-aware, and only when the bot actually carries
 * torches. Light levels come straight from the server (bot.lightAt), so it's
 * fully legit.
 */

import { getHome } from '../navigation/home.js';
import * as world from '../library/world.js';

/**
 * Scan for dark spots around a center.
 * @param {object} bot
 * @param {object} [opts] { center, radius, maxLight, lightProvider }
 *        lightProvider(pos) -> 0..15 (injectable for tests)
 * @returns {Array<{x, y, z, light}>} darkest first, capped at 32
 */
export function scanDarkSpots(bot, { center = null, radius = 8, maxLight = 6, lightProvider = null } = {}) {
    const c = center ?? bot?.entity?.position;
    if (!c || typeof c.x !== 'number') return [];
    const lightAt = lightProvider ?? ((pos) => bot.lightAt?.(pos) ?? 15);
    const r = Math.max(1, Math.min(16, Math.floor(radius)));
    const spots = [];
    for (let dx = -r; dx <= r; dx++) {
        for (let dz = -r; dz <= r; dz++) {
            // ground level + one up is where spawns actually happen
            for (const dy of [0, 1]) {
                const pos = { x: Math.floor(c.x) + dx, y: Math.floor(c.y) + dy, z: Math.floor(c.z) + dz };
                let light = 15;
                try { light = lightAt(pos); } catch { light = 15; }
                if (light <= maxLight) spots.push({ ...pos, light });
            }
        }
    }
    spots.sort((a, b) => a.light - b.light);
    return spots.slice(0, 32);
}

/**
 * Base-maintenance executor: light the dark spots around home.
 * @returns {Promise<string>} human-readable result
 */
export async function executeBaseMaintenance(agent, need, cfg = {}) {
    const bot = agent?.bot;
    if (!bot) return 'maintain_base: no bot';

    let home = null;
    try { home = getHome(agent); } catch { home = null; }
    const center = home ?? bot.entity?.position;
    if (!center) return 'maintain_base: no home set (use !sethome)';

    const radius = Math.max(4, Math.min(16, cfg.maintain_radius ?? 8));
    const spots = scanDarkSpots(bot, { center, radius });
    if (!spots.length) return 'maintain_base: area around home is well lit';

    const torches = (world.getInventoryCounts(bot)['torch'] ?? 0);
    if (torches < 1) return 'maintain_base: found dark spots but no torches to place';

    const skills = await import('../library/skills.js');
    let placed = 0;
    for (const spot of spots) {
        if (placed >= torches || placed >= 16 || bot.interrupt_code) break;
        try {
            // torch goes on top of the block below the dark air space
            const ok = await skills.placeBlock(bot, 'torch', spot.x, spot.y, spot.z, 'bottom', true);
            if (ok) placed++;
        } catch { /* this spot failed; keep the base bright elsewhere */ }
    }
    if (!placed) return 'maintain_base: could not place any torches';
    return `maintain_base: placed ${placed} torch(es) around home`;
}
