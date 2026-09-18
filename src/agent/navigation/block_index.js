/**
 * Baritone-inspired loaded-world block index.
 *
 * Mineflayer's findBlocks is useful, but asking it for one nearest block is a
 * poor target selector: the nearest result can be unreachable, hidden, or a
 * stale chunk result. This module keeps the search policy in one place:
 * aliases expand to real block names, several candidates are returned, and
 * callers can revalidate candidates before interacting with them.
 *
 * This intentionally indexes loaded chunks only. Like Baritone's world
 * scanner, exploration/loading is a separate concern; we never force-load a
 * chunk merely to search it.
 */

const ALIASES = Object.freeze({
    wood: ['oak_log', 'birch_log', 'spruce_log', 'jungle_log', 'acacia_log',
        'dark_oak_log', 'mangrove_log', 'cherry_log', 'crimson_stem', 'warped_stem'],
    log: ['oak_log', 'birch_log', 'spruce_log', 'jungle_log', 'acacia_log',
        'dark_oak_log', 'mangrove_log', 'cherry_log', 'crimson_stem', 'warped_stem'],
    logs: ['oak_log', 'birch_log', 'spruce_log', 'jungle_log', 'acacia_log',
        'dark_oak_log', 'mangrove_log', 'cherry_log', 'crimson_stem', 'warped_stem'],
    stone: ['stone', 'cobblestone', 'deepslate', 'cobbled_deepslate'],
    coal: ['coal', 'coal_ore', 'deepslate_coal_ore'],
    iron: ['iron', 'iron_ore', 'deepslate_iron_ore', 'raw_iron_block'],
    gold: ['gold', 'gold_ore', 'deepslate_gold_ore', 'raw_gold_block'],
});

export function expandBlockNames(names) {
    const input = Array.isArray(names) ? names : [names];
    const out = [];
    for (const value of input) {
        const name = String(value ?? '').trim().toLowerCase();
        if (!name) continue;
        for (const expanded of ALIASES[name] ?? [name]) {
            if (!out.includes(expanded)) out.push(expanded);
        }
    }
    return out;
}

function distanceSq(a, b) {
    const dx = a.x - b.x;
    const dy = a.y - b.y;
    const dz = a.z - b.z;
    return dx * dx + dy * dy + dz * dz;
}

function isLoadedBlock(bot, position) {
    try {
        const block = bot.blockAt(position, false);
        return block && block.name !== 'air' && block.name !== 'cave_air' && block.name !== 'void_air';
    } catch {
        return false;
    }
}

/** Return many fresh candidates, ordered by distance, never only one. */
export function findBlockCandidates(bot, names, { radius = 64, max = 64, exclude = null } = {}) {
    const types = expandBlockNames(names);
    if (!bot?.findBlocks || !types.length) return [];
    const excluded = new Set((exclude ?? []).map(p => `${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`));
    const origin = bot.entity?.position;
    if (!origin) return [];
    let positions = [];
    try {
        positions = bot.findBlocks({
            matching: block => {
                const name = typeof block === 'number' ? bot.registry?.blocks?.[block]?.name : block?.name;
                return types.includes(name);
            },
            maxDistance: Math.max(1, Math.floor(radius)),
            count: Math.max(max, 8),
        }) ?? [];
    } catch {
        return [];
    }
    return positions
        .filter(p => p && !excluded.has(`${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`))
        .map(p => ({ position: p, block: bot.blockAt(p, false) }))
        .filter(entry => entry.block && types.includes(entry.block.name) && isLoadedBlock(bot, entry.position))
        .sort((a, b) => distanceSq(a.position, origin) - distanceSq(b.position, origin))
        .slice(0, max);
}

export function blockAliases() {
    return Object.fromEntries(Object.entries(ALIASES).map(([k, v]) => [k, [...v]]));
}
