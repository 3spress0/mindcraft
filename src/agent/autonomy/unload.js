/**
 * unload.js — autonomous storage management (GO list: autonomous storage
 * management). When the inventory is nearly full, the loop deposits
 * non-essential items into the nearest chest the bot can reach, keeping
 * tools, armor, food and a few working items.
 *
 * Uses only legit information: the bot's own inventory and blocks it can
 * actually find in the world. Deposits go through skills.putInChest so the
 * storage index stays accurate.
 */

import * as world from '../library/world.js';
import { isTool } from '../library/durability.js';
import { getSpotRegistry } from '../storage/placement.js';

const ARMOR_WORDS = ['helmet', 'chestplate', 'leggings', 'boots', 'elytra', 'shield', 'turtle_helmet'];
const WORKING_ITEMS = ['water_bucket', 'lava_bucket', 'bucket', 'flint_and_steel', 'fishing_rod', 'compass', 'clock', 'map', 'lead', 'saddle'];
const FOOD_WORDS = ['bread', 'apple', 'cooked_', 'golden_apple', 'golden_carrot', 'melon_slice', 'carrot', 'potato', 'beetroot', 'sweet_berries', 'chorus_fruit', 'dried_kelp', 'cookie', 'pumpkin_pie', 'mushroom_stew', 'rabbit_stew', 'beetroot_soup', 'suspicious_stew', 'honey_bottle', 'cake'];

/** True when the item is edible (registry-first, name fallback). */
export function isEdible(bot, item) {
    if (!item?.name) return false;
    try {
        const foods = bot?.registry?.foodsById;
        if (foods && foods[item.type] != null) return true;
    } catch { /* fall through to name heuristics */ }
    return FOOD_WORDS.some(w => item.name.includes(w));
}

/** Items the bot should never auto-deposit. */
export function shouldKeep(bot, item) {
    if (!item?.name) return true;
    if (isTool(item.name)) return true;
    if (ARMOR_WORDS.some(w => item.name.includes(w))) return true;
    if (WORKING_ITEMS.includes(item.name)) return true;
    if (isEdible(bot, item)) return true;
    return false;
}

/**
 * Aggregate what should be unloaded.
 * @returns {Array<{name, count}>} sorted by count desc, capped at maxTypes
 */
export function itemsToUnload(bot, { maxTypes = 8 } = {}) {
    const counts = world.getInventoryCounts(bot);
    const slots = bot?.inventory?.slots ?? [];
    const byName = {};
    for (const item of slots) {
        if (!item || shouldKeep(bot, item)) continue;
        byName[item.name] = (byName[item.name] ?? 0) + (item.count ?? 1);
    }
    const out = Object.entries(byName)
        .map(([name, count]) => ({ name, count }))
        .filter(e => counts[e.name] === e.count); // only full-inventory aggregates
    out.sort((a, b) => b.count - a.count);
    return out.slice(0, Math.max(1, maxTypes));
}

/**
 * Unload executor: find the nearest chest and deposit the unload list.
 * Returns a short result string.
 */
export async function executeInventoryUnload(agent, need, cfg = {}) {
    const bot = agent?.bot;
    if (!bot) return 'unload: no bot';
    const maxTypes = Math.max(1, Math.min(16, cfg.max_unload_types ?? 8));

    const list = itemsToUnload(bot, { maxTypes });
    if (!list.length) return 'unload: nothing worth depositing';

    let chest = world.getNearestBlock(bot, 'chest', 32);

    // No chest in immediate range? Route to a known storage spot (named
    // spots from !nameStorage, or where we last unloaded successfully).
    if (!chest) {
        try {
            const registry = getSpotRegistry(agent);
            const spot = registry?.nearestTo(bot.entity?.position, { maxDist: 64 });
            if (spot) {
                const skills = await import('../library/skills.js');
                await skills.goToPosition(bot, spot.x, spot.y, spot.z, 3);
                if (!bot.interrupt_code) chest = world.getNearestBlock(bot, 'chest', 10);
            }
        } catch { /* spot routing is best-effort */ }
    }
    if (!chest) return 'unload: no chest within 32 blocks (and no known storage spot) — build or find storage first';

    let skills;
    try { skills = await import('../library/skills.js'); }
    catch (e) { return `unload failed: ${e.message}`; }

    let deposited = 0;
    const done = [];
    for (const entry of list) {
        if (bot.interrupt_code) break;
        try {
            const ok = await skills.putInChest(bot, entry.name, entry.count);
            if (ok) { deposited += entry.count; done.push(`${entry.count}x ${entry.name}`); }
        } catch { /* keep going with the rest */ }
    }
    if (!deposited) return 'unload: reached the chest but deposited nothing';

    // Remember where this worked so future runs can route straight here.
    try {
        const pos = chest?.position ?? world.getNearestBlock(bot, 'chest', 10)?.position;
        if (pos) getSpotRegistry(agent)?.add('_last_unload', pos, 'chest');
    } catch { /* bookkeeping only */ }

    return `unload: deposited ${deposited} item(s) (${done.slice(0, 4).join(', ')}${done.length > 4 ? ', ...' : ''})`;
}
