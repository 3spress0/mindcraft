/**
 * baritone.js — the Baritone-flavored movement controller.
 *
 * Thin layer over mineflayer-pathfinder that gives mindcraft the Baritone
 * workflow pieces it was missing:
 *
 *   - profile-aware navigation (settings.js presets),
 *   - dry-run path previews (#calc / #render equivalent: cost + node count
 *     without actually walking),
 *   - #mine style mining: locate nearest matching block, path next to it
 *     (GoalGetToBlock), equip the best tool, dig, repeat,
 *   - a status line describing the current goal.
 *
 * Nothing here listens to events or mutates the agent loop; callers (skills
 * and the !commands) decide when to invoke it.
 */

import pf from 'mineflayer-pathfinder';
import * as world from '../library/world.js';
import * as goals from './goals.js';
import { applyProfile, getProfileName } from './settings.js';

/** Build a Movements instance with the bot's active (or given) profile. */
export function buildMovements(bot, profile = null) {
    const movements = new pf.Movements(bot);
    applyProfile(movements, profile || getProfileName(bot));
    return movements;
}

/**
 * Dry-run a path to a goal without moving (Baritone #calc).
 * @returns {Object} { ok, status, nodes, cost, visitedNodes, timeMs, profile, goal }
 */
export function previewPath(bot, goal, { profile = null, timeout = 1000 } = {}) {
    const activeProfile = profile || getProfileName(bot);
    const movements = buildMovements(bot, activeProfile);
    const start = Date.now();
    let result = null;
    try {
        result = bot.pathfinder.getPathTo(movements, goal, timeout);
    } catch (err) {
        return {
            ok: false,
            status: 'error',
            error: err.message,
            profile: activeProfile,
            goal: goal.describe ? goal.describe() : String(goal),
        };
    }
    const path = result?.path || [];
    return {
        ok: result?.status === 'success',
        status: result?.status || 'noPath',
        nodes: path.length,
        cost: result?.cost ?? null,
        visitedNodes: result?.visitedNodes ?? null,
        timeMs: Date.now() - start,
        profile: activeProfile,
        goal: goal.describe ? goal.describe() : String(goal),
    };
}

/**
 * Navigate to a goal using the active profile. Resolves true when the
 * pathfinder reports arrival; rejects on pathfinder failure (like
 * skills.goToGoal callers expect).
 */
export async function gotoGoal(bot, goal, { profile = null } = {}) {
    bot.pathfinder.setMovements(buildMovements(bot, profile));
    await bot.pathfinder.goto(goal);
    return true;
}

/** Status line for the current movement, Baritone #status style. */
export function status(bot) {
    const goal = bot.pathfinder?.goal;
    const moving = !!bot.pathfinder?.isMoving?.();
    const profile = getProfileName(bot);
    const goalText = goal
        ? (goal.describe ? goal.describe() : goal.constructor?.name || 'goal')
        : 'none';
    return `profile=${profile}, moving=${moving ? 'yes' : 'no'}, goal=${goalText}`;
}

/**
 * Baritone-style #mine: repeatedly find the nearest matching block, path to
 * an adjacent spot and dig it with the best available tool.
 *
 * @param {Object} bot        mineflayer bot
 * @param {string} blockType  block name, e.g. 'iron_ore'
 * @param {number} count      how many blocks to mine
 * @param {Object} opts       { range, profile, onProgress }
 * @returns {Object} { mined, requested, reason }
 */
export async function mineBlocks(bot, blockType, count = 1, opts = {}) {
    const range = Math.max(16, Math.min(256, opts.range || 64));
    let mined = 0;
    let reason = 'completed';

    for (let i = 0; i < count; i++) {
        if (bot.interrupt_code) {
            reason = 'interrupted';
            break;
        }
        const block = world.getNearestBlock(bot, blockType, range);
        if (!block) {
            reason = mined > 0 ? `no more ${blockType} within ${range} blocks` : `no ${blockType} found within ${range} blocks`;
            break;
        }

        const goal = new goals.GoalGetToBlock(block.position.x, block.position.y, block.position.z);
        try {
            await gotoGoal(bot, goal, { profile: opts.profile });
        } catch (err) {
            reason = `could not reach ${blockType}: ${err.message}`;
            break;
        }
        if (bot.interrupt_code) {
            reason = 'interrupted';
            break;
        }

        // The block may have been taken by someone/something while walking.
        const current = bot.blockAt(block.position);
        if (!current || current.name !== blockType) {
            continue; // recount without digging air
        }

        // Equip the best harvest tool, mirroring Baritone's tool selection.
        try {
            const bestTool = bot.pathfinder?.bestHarvestTool?.(current);
            if (bestTool) await bot.equip(bestTool, 'hand');
        } catch { /* keep whatever is in hand */ }

        try {
            await bot.dig(current);
            mined++;
            if (opts.onProgress) opts.onProgress(mined, count);
        } catch (err) {
            reason = `failed to dig ${blockType}: ${err.message}`;
            break;
        }
    }

    return { mined, requested: count, reason };
}
