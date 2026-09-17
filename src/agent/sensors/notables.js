/**
 * notables.js — persistent block knowledge (GO list: persistent block
 * knowledge).
 *
 * Scans a bounded area for blocks worth remembering — ores, spawners,
 * beacons, beds, crafting stations — and records them in the world model as
 * durable `resource`/`structure` facts. Called opportunistically while
 * exploring or mining, so knowledge accumulates as a side effect of living
 * in the world instead of requiring explicit commands.
 *
 * Legit: only blocks the server has already sent (bot.blockAt on loaded
 * chunks). Coarse grid sampling keeps the scan cheap.
 */

/** Notable blocks -> world-model category and kind. */
export const NOTABLE_BLOCKS = {
    // ores (resource)
    coal_ore: 'ore', deepslate_coal_ore: 'ore',
    iron_ore: 'ore', deepslate_iron_ore: 'ore',
    copper_ore: 'ore', deepslate_copper_ore: 'ore',
    gold_ore: 'ore', deepslate_gold_ore: 'ore', nether_gold_ore: 'ore',
    redstone_ore: 'ore', deepslate_redstone_ore: 'ore',
    lapis_ore: 'ore', deepslate_lapis_ore: 'ore',
    diamond_ore: 'ore', deepslate_diamond_ore: 'ore',
    emerald_ore: 'ore', deepslate_emerald_ore: 'ore',
    nether_quartz_ore: 'ore', ancient_debris: 'ore',
    // interesting structures
    spawner: 'structure', beacon: 'structure',
    crafting_table: 'station', furnace: 'station', blast_furnace: 'station',
    smoker: 'station', enchanting_table: 'station', anvil: 'station',
    bed: 'station', white_bed: 'station', red_bed: 'station', blue_bed: 'station',
    black_bed: 'station', green_bed: 'station', yellow_bed: 'station'
};

const TTL_MS = 7 * 24 * 3600 * 1000; // block knowledge: 7 days until re-verified

/**
 * Scan for notable blocks around the bot and record them.
 * @param {object} agent
 * @param {object} [opts] { radius (capped 24), maxNotes }
 * @returns {number} facts noted this scan
 */
export function noteNotableBlocks(agent, { radius = 16, maxNotes = 12 } = {}) {
    const bot = agent?.bot;
    const model = agent?.world_model;
    const self = bot?.entity?.position;
    if (!bot || !model || !self) return 0;
    const r = Math.max(4, Math.min(24, Math.floor(radius)));
    let noted = 0;
    const step = r > 12 ? 2 : 1;
    try {
        for (let dx = -r; dx <= r; dx += step) {
            for (let dz = -r; dz <= r; dz += step) {
                for (let dy = -4; dy <= 4; dy += 2) {
                    const p = { x: Math.floor(self.x) + dx, y: Math.floor(self.y) + dy, z: Math.floor(self.z) + dz };
                    let block = null;
                    try { block = bot.blockAt?.(p, false); } catch { block = null; }
                    if (!block) continue;
                    const kind = NOTABLE_BLOCKS[block.name];
                    if (!kind) continue;
                    const category = kind === 'ore' ? 'resource' : 'structure';
                    try {
                        model.record(category, {
                            name: block.name,
                            kind,
                            pos: { x: p.x, y: p.y, z: p.z },
                            detail: { notedBy: 'scan' }
                        }, { expiresIn: TTL_MS });
                        noted++;
                    } catch { /* world-model writes are best-effort */ }
                    if (noted >= maxNotes) return noted;
                }
            }
        }
    } catch { /* scanning must never break the caller */ }
    return noted;
}
