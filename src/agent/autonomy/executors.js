/**
 * executors.js — turn a scored need into a concrete, interruptible action.
 * Each executor returns a short human-readable result string that the task
 * loop records in its history. Executors must never throw into the loop —
 * they catch and report instead.
 */

import * as durability from '../library/durability.js';
import { explore } from '../navigation/exploration.js';
import { autonomyDefaults } from './needs.js';
import { executeInventoryUnload } from './unload.js';
import { executeFarming } from './farming.js';
import { executeBaseMaintenance } from './base.js';

/** Replace the worn/broken tool named in the need. */
export async function executeToolReplacement(agent, need, cfg = {}) {
    const toolName = need?.detail;
    if (!toolName) return 'tool_replace: no tool specified';
    try {
        // import here to avoid a circular import at module load
        const skills = await import('../library/skills.js');
        const msg = await durability.replaceTool(agent.bot, toolName, { craftFn: skills.craftRecipe });
        return `tool_replace: ${msg}`;
    } catch (e) {
        return `tool_replace failed: ${e.message}`;
    }
}

/** Frontier exploration for a bounded number of legs. */
export async function executeExploration(agent, need, cfg = {}) {
    const legs = Math.max(1, Math.min(8, cfg.explore_legs ?? autonomyDefaults().explore_legs));
    try {
        const summary = await explore(agent, { legs });
        return `explore: ${summary}`;
    } catch (e) {
        return `explore failed: ${e.message}`;
    }
}

/** Craft reserve items (torches / bread) to top up self-maintained stocks. */
export async function executeRestock(agent, need, cfg = {}) {
    const itemName = need?.detail;
    if (!itemName) return 'restock: nothing specified';
    try {
        const skills = await import('../library/skills.js');
        const num = itemName === 'torch' ? Math.max(1, Math.min(16, cfg.min_torches ?? 8)) : 3;
        const ok = await skills.craftRecipe(agent.bot, itemName, num);
        return ok
            ? `restock: crafted ${num}x ${itemName}`
            : `restock: could not craft ${itemName} (materials or table missing)`;
    } catch (e) {
        return `restock failed: ${e.message}`;
    }
}

/** Sleep until morning in the nearest bed (only sensible at night). */
export async function executeRest(agent, need, cfg = {}) {
    const bot = agent?.bot;
    if (!bot) return 'rest: no bot';
    try {
        const skills = await import('../library/skills.js');
        const ok = await skills.goToBed(bot);
        return ok ? 'rest: slept until morning' : 'rest: no bed reachable right now';
    } catch (e) {
        return `rest failed: ${e.message}`;
    }
}

export const EXECUTORS = {
    tool_replace: executeToolReplacement,
    explore: executeExploration,
    inventory_full: executeInventoryUnload,
    restock_torches: executeRestock,
    restock_food: executeRestock,
    farm: executeFarming,
    rest: executeRest,
    maintain_base: executeBaseMaintenance
};
