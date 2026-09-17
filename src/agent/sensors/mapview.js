/**
 * mapview.js — ASCII map rendering (GO list: !map, path visualization).
 *
 * Draws a top-down ASCII map of the bot's surroundings from legit,
 * server-reported data: hazards, players, mobs, and remembered POIs. Also
 * renders a computed path onto the same grid so !showPath can visualize a
 * route before walking it.
 */

import { scanHazards } from '../navigation/hazards.js';
import { playerIntel, entityIntel } from './radar.js';
import { getMentalMap } from '../memory/mental_map.js';

/**
 * Build an ASCII map grid.
 * @param {object} agent
 * @param {object} [opts] { radius, path (array of {x,z} to draw), includePois }
 * @returns {string}
 */
export function asciiMap(agent, { radius = 16, path = null, includePois = true } = {}) {
    const bot = agent?.bot;
    const self = bot?.entity?.position;
    if (!self) return 'Cannot map: position unknown.';
    const r = Math.max(6, Math.min(32, Math.floor(radius)));
    const W = r * 2 + 1;
    const grid = Array.from({ length: W }, () => Array(W).fill('·'));

    const mark = (x, z, ch) => {
        const gx = Math.round(x - self.x) + r;
        const gz = Math.round(z - self.z) + r;
        if (gx < 0 || gx >= W || gz < 0 || gz >= W) return false;
        grid[gz][gx] = ch;
        return true;
    };

    // hazards first (lowest layer)
    try {
        for (const h of scanHazards(bot, { radius: r })) {
            mark(h.x, h.z, h.tier === 'hard' ? '#' : '~');
        }
    } catch { /* optional */ }

    // remembered POIs
    if (includePois) {
        try {
            const map = getMentalMap?.(agent);
            for (const p of map?.list?.() ?? []) {
                mark(p.x, p.z, p.type === 'home' || p.type === 'base' ? 'H' : 'P');
            }
        } catch { /* optional */ }
    }

    // path overlay
    if (Array.isArray(path)) {
        for (const p of path) {
            const px = p?.position?.x ?? p?.x;
            const pz = p?.position?.z ?? p?.z;
            if (typeof px === 'number' && typeof pz === 'number') mark(px, pz, '*');
        }
    }

    // mobs and players on top
    try {
        for (const e of entityIntel(bot, r)) mark(e.position.x, e.position.z, 'm');
    } catch { /* optional */ }
    try {
        for (const p of playerIntel(bot, r)) mark(p.position.x, p.position.z, '@');
    } catch { /* optional */ }

    // the bot itself, last so it is never hidden
    grid[r][r] = 'B';

    const frame = '+' + '-'.repeat(W) + '+';
    const rows = grid.map(row => '|' + row.join('') + '|');
    const legend = 'B=you @=player m=mob #=hard hazard ~=soft hazard *=path H=base P=POI';
    return [frame, ...rows, frame, legend,
        `Center: (${Math.round(self.x)}, ${Math.round(self.z)}), 1 char = 1 block, N is up (-z)`].join('\n');
}
