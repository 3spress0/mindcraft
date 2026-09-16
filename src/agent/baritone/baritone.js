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
import { applyProfile, getProfileName, profileAvoidsHazards } from './settings.js';
import * as humanlike from '../humanlike/interaction.js';
import { hardenMovements } from '../navigation/hazards.js';
import { ensureUsableTool } from '../library/durability.js';

/** Build a Movements instance with the bot's active (or given) profile. */
export function buildMovements(bot, profile = null) {
    const movements = new pf.Movements(bot);
    const active = profile || getProfileName(bot);
    applyProfile(movements, active);
    if (profileAvoidsHazards(active)) hardenMovements(movements, bot);
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

const FACE_OFFSETS = [
    [1, 0, 0], [-1, 0, 0],
    [0, 1, 0], [0, -1, 0],
    [0, 0, 1], [0, 0, -1],
];

function posKey(p) {
    return `${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`;
}

/**
 * Vein-aware mining helper: breadth-first scan from a freshly mined block for
 * face-connected blocks of the same type (ore veins, gravel pockets...).
 * Returns up to `cap` blocks, not including the starting one.
 */
export function findVein(bot, startBlock, blockType, { cap = 32, seen = new Set() } = {}) {
    const found = [];
    const queue = [startBlock.position];
    seen.add(posKey(startBlock.position));
    while (queue.length > 0 && found.length < cap) {
        const pos = queue.shift();
        for (const [dx, dy, dz] of FACE_OFFSETS) {
            if (found.length >= cap) break;
            const next = { x: pos.x + dx, y: pos.y + dy, z: pos.z + dz };
            const key = posKey(next);
            if (seen.has(key)) continue;
            seen.add(key);
            let block = null;
            try {
                block = bot.blockAt(next, false);
            } catch {
                block = null;
            }
            if (!block || block.name !== blockType) continue;
            found.push(block);
            queue.push(next);
        }
    }
    return found;
}

/**
 * Baritone-style #mine: repeatedly find the nearest matching block, path to
 * an adjacent spot and dig it with the best available tool. Vein-aware: after
 * each dig, face-connected blocks of the same type are mined first before the
 * next nearest-search (like Baritone's vein mining), unless `vein: false`.
 *
 * @param {Object} bot        mineflayer bot
 * @param {string} blockType  block name, e.g. 'iron_ore'
 * @param {number} count      how many blocks to mine
 * @param {Object} opts       { range, profile, onProgress, vein, veinCap }
 * @returns {Object} { mined, requested, reason }
 */
export async function mineBlocks(bot, blockType, count = 1, opts = {}) {
    const range = Math.max(16, Math.min(256, opts.range || 64));
    const veinEnabled = opts.vein !== false;
    const veinSeen = new Set();
    const veinQueue = [];
    let mined = 0;
    let reason = 'completed';

    while (mined < count) {
        if (bot.interrupt_code) {
            reason = 'interrupted';
            break;
        }

        // Vein leftovers first, then the next nearest occurrence.
        let target = veinQueue.shift() || null;
        if (!target) {
            target = world.getNearestBlock(bot, blockType, range);
            if (!target) {
                reason = mined > 0
                    ? `no more ${blockType} within ${range} blocks`
                    : `no ${blockType} found within ${range} blocks`;
                break;
            }
        }

        // Only re-path when the block is out of interaction reach.
        const here = bot.entity?.position;
        const farAway = !here || here.distanceTo(target.position) > 4;
        if (farAway) {
            const goal = new goals.GoalGetToBlock(target.position.x, target.position.y, target.position.z);
            try {
                await gotoGoal(bot, goal, { profile: opts.profile });
            } catch (err) {
                reason = `could not reach ${blockType}: ${err.message}`;
                break;
            }
        }
        if (bot.interrupt_code) {
            reason = 'interrupted';
            break;
        }

        // The block may have been taken by someone/something while walking.
        const current = bot.blockAt(target.position);
        if (!current || current.name !== blockType) {
            continue; // skip stale targets without digging air
        }

        // Equip the best harvest tool, mirroring Baritone's tool selection.
        try {
            const bestTool = bot.pathfinder?.bestHarvestTool?.(current);
            if (bestTool) await bot.equip(bestTool, 'hand');
        } catch { /* keep whatever is in hand */ }

        // Durability-aware swap: never dig with a nearly-dead tool when a
        // healthier one is available.
        try {
            await ensureUsableTool(bot, current);
        } catch { /* durability awareness must never break mining */ }

        // Humanlike: look at the block first, then a brief bounded pause.
        try {
            await humanlike.focusOn(bot, current.position, bot._personality, { dwell: [60, 200] });
            await humanlike.pause(bot, bot._personality, 'dig');
        } catch { /* humanization must never break mining */ }

        try {
            await bot.dig(current);
            mined++;
            if (opts.onProgress) opts.onProgress(mined, count);
        } catch (err) {
            reason = `failed to dig ${blockType}: ${err.message}`;
            break;
        }

        if (veinEnabled && mined < count) {
            for (const member of findVein(bot, current, blockType, { cap: opts.veinCap || 32, seen: veinSeen })) {
                veinQueue.push(member);
            }
        }
    }

    return { mined, requested: count, reason };
}
