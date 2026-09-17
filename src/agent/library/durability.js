/**
 * durability.js — tool durability awareness and replacement planning
 * (GO list: tool durability awareness, automatic replacement tools,
 * tool durability management).
 *
 * Everything here is legit: durability comes from the item damage metadata
 * the server already sends for the bot's own inventory, and replacement
 * planning only considers inventory contents + known crafting recipes.
 */

import * as mc from '../../utils/mcdata.js';
import * as world from './world.js';

/** Default remaining-fraction below which a tool is considered worn out. */
export const DEFAULT_REPLACE_THRESHOLD = 0.15;

/** Item-name suffixes treated as tools for digging/harvesting purposes. */
const TOOL_SUFFIXES = ['pickaxe', 'axe', 'shovel', 'hoe', 'sword', 'shears'];

export function isTool(itemName) {
    if (!itemName) return false;
    return TOOL_SUFFIXES.some(s => itemName.endsWith(s));
}

/**
 * Durability condition of one item.
 * @returns {{name, slot, count, durabilityUsed, maxDurability, remaining, pct, worn, broken}}
 *   or null for items without durability.
 */
export function toolCondition(item) {
    if (!item || !item.name) return null;
    const max = item.maxDurability ?? null;
    if (!max) return null;
    let used = 0;
    try { used = item.durabilityUsed ?? 0; } catch { used = 0; }
    const remaining = Math.max(0, max - used);
    return {
        name: item.name,
        slot: item.slot ?? null,
        count: item.count ?? 1,
        durabilityUsed: used,
        maxDurability: max,
        remaining,
        pct: remaining / max,
        worn: false,      // caller sets against a threshold
        broken: remaining <= 0
    };
}

/** Condition report for every tool in the bot's inventory. */
export function listTools(bot, threshold = DEFAULT_REPLACE_THRESHOLD) {
    const slots = bot?.inventory?.slots ?? [];
    const out = [];
    for (const item of slots) {
        if (!item || !isTool(item.name)) continue;
        const cond = toolCondition(item);
        if (!cond) continue;
        cond.worn = cond.pct < threshold;
        out.push(cond);
    }
    out.sort((a, b) => b.remaining - a.remaining);
    return out;
}

/** Tools of a given name (e.g. 'stone_pickaxe'), best remaining first. */
export function sparesOf(bot, toolName, threshold = DEFAULT_REPLACE_THRESHOLD) {
    return listTools(bot, threshold).filter(t => t.name === toolName && t.remaining > 0);
}

/**
 * Pick the best available item for harvesting a block, preferring tools
 * with more remaining durability (unlike raw bestHarvestTool, which is
 * slot-order biased). Returns the Item or null.
 */
export function bestToolForBlock(bot, block) {
    if (!block || typeof block.canHarvest !== 'function') return null;
    const candidates = [];
    for (const item of bot?.inventory?.slots ?? []) {
        if (!item) continue;
        try {
            if (!block.canHarvest(item.type)) continue;
        } catch { continue; }
        const max = item.maxDurability ?? null;
        if (!max) continue; // non-durables (hands, weird items) skipped
        let used = 0;
        try { used = item.durabilityUsed ?? 0; } catch { used = 0; }
        candidates.push({ item, remaining: Math.max(0, max - used) });
    }
    if (!candidates.length) return null;
    candidates.sort((a, b) => b.remaining - a.remaining);
    return candidates[0].item;
}

/**
 * Make sure a block will be harvested with a tool that still has life left.
 * If the currently held tool cannot harvest the block, is worn past the
 * threshold, or is broken, swap in the healthiest harvestable tool.
 * (Slot-order-biased equippers like bestHarvestTool may hold a nearly-dead
 * tool while a fresh one sits in the inventory — this fixes that.)
 */
export async function ensureUsableTool(bot, block, { threshold = DEFAULT_REPLACE_THRESHOLD } = {}) {
    if (!block || typeof block.canHarvest !== 'function') return { equipped: false, reason: 'no-block' };

    const held = bot?.heldItem ?? null;
    let heldHarvests = false;
    if (held) {
        try { heldHarvests = !!block.canHarvest(held.type); } catch { heldHarvests = false; }
    }
    if (heldHarvests) {
        const cond = toolCondition(held);
        if (!cond || cond.pct >= threshold) return { equipped: false, item: held.name, reason: 'ok' };
    }

    const best = bestToolForBlock(bot, block);
    if (!best) return { equipped: false, reason: heldHarvests ? 'worn-no-better' : 'no-tool' };
    if (held && best.slot === held.slot) return { equipped: false, item: held.name, reason: 'worn-no-better' };
    try {
        await bot.equip(best, 'hand');
        return { equipped: true, item: best.name, reason: heldHarvests ? 'swapped-worn' : 'equipped' };
    } catch (e) {
        return { equipped: false, reason: `equip-failed: ${e.message}` };
    }
}

/**
 * Replacement plan for a worn tool.
 * @param {object} [opts]
 * @param {function} [opts.getRecipes] - recipe provider injection for tests
 *   (defaults to mc.getItemCraftingRecipes; returns [[{material:count}, meta], ...])
 * @param {function} [opts.getHave] - inventory counts injection for tests
 * @returns {{status:'no_recipe'|'craftable'|'missing', tool, missing?:Object}}
 */
export function replacementPlan(bot, toolName, { getRecipes = null, getHave = null, getItemId = null } = {}) {
    const plan = { tool: toolName };
    let recipes = null;
    try {
        recipes = getRecipes ? getRecipes(toolName) : mc.getItemCraftingRecipes(toolName);
    } catch { recipes = null; }
    if (!recipes || recipes.length === 0) return { ...plan, status: 'no_recipe' };

    let itemId = null;
    try { itemId = getItemId ? getItemId(toolName) : mc.getItemId(toolName); } catch { itemId = null; }
    let craftable = [];
    if (itemId != null) {
        try { craftable = bot.recipesFor?.(itemId, null, 1, true) ?? []; } catch { craftable = []; }
    }
    if (craftable.length > 0) return { ...plan, status: 'craftable' };

    // diff the first known recipe against the inventory
    const first = recipes[0];
    const need = Array.isArray(first) ? (first[0] ?? {}) : first;
    const have = getHave ? getHave(bot) : world.getInventoryCounts(bot);
    const missing = {};
    for (const [mat, count] of Object.entries(need ?? {})) {
        const deficit = count - (have[mat] ?? 0);
        if (deficit > 0) missing[mat] = deficit;
    }
    if (Object.keys(missing).length === 0) return { ...plan, status: 'craftable' };
    return { ...plan, status: 'missing', missing };
}

/** Human-readable tools report for !tools. */
export function toolsReport(bot, threshold = DEFAULT_REPLACE_THRESHOLD) {
    const tools = listTools(bot, threshold);
    if (!tools.length) return 'No tools in inventory.';
    const lines = [`TOOLS (${tools.length} in inventory, replace below ${Math.round(threshold * 100)}%):`];
    for (const t of tools) {
        const bar = `${t.remaining}/${t.maxDurability}`;
        const state = t.broken ? 'BROKEN' : t.worn ? 'WORN' : 'ok';
        lines.push(`- ${t.name} [slot ${t.slot ?? '?'}] ${bar} (${Math.round(t.pct * 100)}%) ${state}`);
    }
    const worn = tools.filter(t => t.worn);
    if (worn.length) {
        lines.push('');
        lines.push('Worn tools needing replacement:');
        for (const t of worn) {
            const plan = replacementPlan(bot, t.name, { threshold });
            if (plan.status === 'craftable') lines.push(`- ${t.name}: craftable now (!replaceTool ${t.name})`);
            else if (plan.status === 'missing') lines.push(`- ${t.name}: missing ${Object.entries(plan.missing).map(([m, c]) => `${c}x ${m}`).join(', ')}`);
            else lines.push(`- ${t.name}: no known recipe`);
        }
    }
    return lines.join('\n');
}

/**
 * Replace a tool: prefer the healthiest spare in inventory, else craft one.
 * @param {object} [opts] - { craftFn(bot,name,n)=>bool, getRecipes, getHave }
 * Returns a summary string.
 */
export async function replaceTool(bot, toolName, { craftFn = null, getRecipes = null, getHave = null, getItemId = null } = {}) {
    const spares = sparesOf(bot, toolName);
    if (spares.length > 0) {
        const best = spares[0];
        const item = (bot.inventory?.slots ?? [])[best.slot];
        if (item) {
            try {
                await bot.equip(item, 'hand');
                return `Equipped best spare ${toolName} (${best.remaining}/${best.maxDurability} durability left).`;
            } catch (e) {
                return `Could not equip spare ${toolName}: ${e.message}`;
            }
        }
    }

    const plan = replacementPlan(bot, toolName, { getRecipes, getHave, getItemId });
    if (plan.status === 'no_recipe') return `No crafting recipe known for ${toolName}; get one from chests or trading.`;
    if (plan.status === 'missing') {
        return `Cannot craft ${toolName} yet — missing ${Object.entries(plan.missing).map(([m, c]) => `${c}x ${m}`).join(', ')}.`;
    }

    if (typeof craftFn !== 'function') return `${toolName} is craftable but no crafting skill was provided.`;
    const ok = await craftFn(bot, toolName, 1);
    if (!ok) return `Crafting ${toolName} failed (missing table or materials changed).`;
    const fresh = sparesOf(bot, toolName)[0];
    if (fresh) {
        const item = (bot.inventory?.slots ?? [])[fresh.slot];
        if (item) {
            try {
                await bot.equip(item, 'hand');
                return `Crafted and equipped a fresh ${toolName}.`;
            } catch { /* report crafted anyway */ }
        }
    }
    return `Crafted a fresh ${toolName}.`;
}

/** Task families -> tool suffixes, most-preferred first. */
const TASK_TOOLS = {
    mine: ['pickaxe'],
    mining: ['pickaxe'],
    dig: ['shovel'],
    digging: ['shovel'],
    wood: ['axe'],
    chop: ['axe'],
    logging: ['axe'],
    build: ['axe', 'shovel'],
    fight: ['sword'],
    combat: ['sword'],
    harvest: ['hoe', 'axe']
};

/**
 * Contextual tool choice (GO list): pick the best carried tool for a named
 * task, preferring healthy durability over raw slot order. Pure-ish: reads
 * inventory only. Returns { tool, pct } or null when nothing fits.
 */
export function chooseToolForTask(bot, taskName) {
    try {
        const suffixes = TASK_TOOLS[String(taskName ?? '').toLowerCase().trim()] ?? null;
        if (!suffixes) return null;
        let best = null;
        for (const item of bot?.inventory?.slots ?? []) {
            if (!item?.name) continue;
            if (!suffixes.some(s => item.name.endsWith(`_${s}`) || item.name === s)) continue;
            const cond = toolCondition(item);
            const pct = cond?.pct ?? 1;
            if (pct <= 0.05) continue; // nearly broken — never pick
            if (!best || pct > best.pct) best = { tool: item.name, pct };
        }
        return best;
    } catch { return null; }
}
