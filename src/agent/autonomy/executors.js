/**
 * executors.js — turn a scored need into a concrete, interruptible action.
 * Each executor returns a short human-readable result string that the task
 * loop records in its history. Executors must never throw into the loop —
 * they catch and report instead.
 */

import * as durability from '../library/durability.js';
import { explore } from '../navigation/exploration.js';
import { autonomyDefaults } from './needs.js';

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

export const EXECUTORS = {
    tool_replace: executeToolReplacement,
    explore: executeExploration
    // inventory_full is advisory only until an unload executor exists
};
