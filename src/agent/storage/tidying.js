/**
 * tidying.js — chest-side sorting & stack management (GO list: sorting,
 * stack management, storage optimization).
 *
 * A chest the bot uses a lot ends up with scattered partial stacks of the
 * same item. Tidying consolidates them the way a player would: withdraw the
 * scattered item entirely and re-deposit it, which lets vanilla merge the
 * stacks. Category manifesting also tells the LLM what a chest is "for".
 *
 * Everything runs through ordinary container windows — legit.
 */

export const CHEST_CAPACITY = 27;

const TOOL_WORDS = ['pickaxe', 'axe', 'shovel', 'hoe', 'sword'];
const ARMOR_WORDS = ['helmet', 'chestplate', 'leggings', 'boots', 'elytra', 'shield'];
const FOOD_WORDS = ['bread', 'apple', 'cooked_', 'golden_carrot', 'melon_slice', 'carrot', 'potato', 'beetroot', 'sweet_berries', 'chorus_fruit', 'dried_kelp', 'cookie', 'pumpkin_pie', 'mushroom_stew', 'rabbit_stew', 'beetroot_soup', 'suspicious_stew', 'honey_bottle', 'cake', 'rotten_flesh'];
const RESOURCE_WORDS = ['ingot', 'nugget', 'ore', 'coal', 'charcoal', 'diamond', 'emerald', 'lapis', 'redstone', 'quartz', 'iron', 'gold', 'copper'];

/** Classify an item into a coarse category for manifests/grouping. */
export function categorize(itemName) {
    const n = String(itemName ?? '').toLowerCase();
    if (!n) return 'misc';
    if (TOOL_WORDS.some(w => n.endsWith(w))) return 'tools';
    if (ARMOR_WORDS.some(w => n.includes(w))) return 'armor';
    if (FOOD_WORDS.some(w => n.includes(w))) return 'food';
    if (RESOURCE_WORDS.some(w => n.includes(w))) return 'resources';
    return 'blocks';
}

/**
 * Analyze a chest's contents for tidying opportunities.
 * @param {Array<{name, count}>} items  aggregated or slot-level contents
 * @returns {{distinct, totalItems, scattered: Array<{name, stacks, total}>, fillRatio}}
 */
export function analyzeContents(items) {
    const byName = new Map(); // name -> { stacks, total }
    for (const it of items ?? []) {
        if (!it?.name) continue;
        const cur = byName.get(it.name) ?? { stacks: 0, total: 0 };
        cur.stacks += 1;
        cur.total += it.count ?? 1;
        byName.set(it.name, cur);
    }
    const scattered = [];
    for (const [name, agg] of byName) {
        // 2+ stacks where consolidation could help (total fits fewer stacks)
        const minStacks = Math.max(1, Math.ceil(agg.total / 64));
        if (agg.stacks > minStacks) scattered.push({ name, stacks: agg.stacks, total: agg.total });
    }
    scattered.sort((a, b) => (b.stacks - b.total / 64) - (a.stacks - a.total / 64));
    const totalItems = [...byName.values()].reduce((n, a) => n + a.total, 0);
    return {
        distinct: byName.size,
        totalItems,
        scattered,
        fillRatio: Math.round((byName.size / CHEST_CAPACITY) * 100) / 100
    };
}

/**
 * Deterministic tidy plan: one consolidate step per scattered item, ordered
 * by the most slot-waste first.
 * @returns {Array<{action: 'consolidate', item, stacksBefore, stacksAfter}>}
 */
export function planTidy(items) {
    const { scattered } = analyzeContents(items);
    return scattered.map(s => ({
        action: 'consolidate',
        item: s.name,
        stacksBefore: s.stacks,
        stacksAfter: Math.max(1, Math.ceil(s.total / 64))
    }));
}

/** Category manifest: what this chest holds, grouped. */
export function categoryManifest(items) {
    const cats = new Map();
    for (const it of items ?? []) {
        if (!it?.name) continue;
        const cat = categorize(it.name);
        cats.set(cat, (cats.get(cat) ?? 0) + (it.count ?? 1));
    }
    return [...cats.entries()].sort((a, b) => b[1] - a[1]);
}

/**
 * Execute a tidy plan against a chest: for each scattered item, pull it all
 * out and put it back — vanilla merges the stacks on re-deposit.
 * @param {object} bot
 * @param {object} chestBlock  the chest block (must be reachable)
 * @returns {Promise<string>} human-readable result
 */
export async function executeTidy(bot, chestBlock) {
    if (!bot || !chestBlock?.position) return 'tidy: no chest to tidy';
    const skills = await import('../library/skills.js');

    // 1. open once to read contents and build the plan
    let contents = [];
    try {
        await skills.goToPosition(bot, chestBlock.position.x, chestBlock.position.y, chestBlock.position.z, 2);
        const container = await bot.openContainer(chestBlock);
        contents = (container.containerItems?.() ?? []).map(i => ({ name: i.name, count: i.count }));
        await container.close();
    } catch (e) {
        return `tidy failed: ${e.message}`;
    }

    const plan = planTidy(contents);
    if (!plan.length) return 'tidy: chest already tidy — nothing to consolidate';

    // 2. consolidate: withdraw-all + re-deposit lets vanilla merge stacks
    let consolidated = 0;
    for (const step of plan) {
        if (bot.interrupt_code) break;
        try {
            await skills.takeFromChestAt(bot, chestBlock, step.item, -1);
            await skills.putInChestAt(bot, chestBlock, step.item, -1);
            consolidated++;
        } catch { /* skip this item, keep tidying the rest */ }
    }
    const manifest = categoryManifest(contents);
    const top = manifest.slice(0, 3).map(([c, n]) => `${c} x${n}`).join(', ');
    return `tidy: consolidated ${consolidated}/${plan.length} item type(s); contents: ${top || 'empty'}`;
}
