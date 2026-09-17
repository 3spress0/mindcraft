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
import settings from '../../../settings.js';
import * as world from '../library/world.js';
import * as goals from './goals.js';
import { applyProfile, getProfileName, profileAvoidsHazards } from './settings.js';
import * as humanlike from '../humanlike/interaction.js';
import { hardenMovements } from '../navigation/hazards.js';
import { ensureUsableTool } from '../library/durability.js';

/**
 * Ore prioritization (GO list: ore prioritization / resource priorities):
 * when several target types compete, dig the higher-priority one first.
 * Priority list comes from settings.resources.priority; earlier = better.
 */
export function orePriorityList() {
    const list = settings.resources?.priority;
    return Array.isArray(list) && list.length
        ? list.map(String)
        : ['ancient_debris', 'diamond_ore', 'deepslate_diamond_ore', 'emerald_ore', 'deepslate_emerald_ore',
            'gold_ore', 'deepslate_gold_ore', 'nether_gold_ore', 'iron_ore', 'deepslate_iron_ore',
            'redstone_ore', 'deepslate_redstone_ore', 'lapis_ore', 'deepslate_lapis_ore',
            'copper_ore', 'deepslate_copper_ore', 'coal_ore', 'deepslate_coal_ore'];
}

/** Lower number = higher priority; unknown ores sink to the end. */
export function orePriorityRank(blockType) {
    const idx = orePriorityList().indexOf(String(blockType));
    return idx < 0 ? 999 : idx;
}

/**
 * Safe mining probe (GO list: safe mining / lava awareness): is it safe to
 * dig this block right now? Checks the block and its six neighbors for lava
 * (hard stop) so we don't tunnel into a lava pocket.
 * @returns {{safe: boolean, reason: string|null}}
 */
export function digIsSafe(bot, block) {
    try {
        if (!block?.position) return { safe: true, reason: null };
        const p = block.position;
        const offsets = [[0, 0, 0], [1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
        for (const [dx, dy, dz] of offsets) {
            const neighbor = bot.blockAt?.({ x: p.x + dx, y: p.y + dy, z: p.z + dz }, false);
            if (neighbor && (neighbor.name === 'lava' || neighbor.name === 'flowing_lava')) {
                return { safe: false, reason: `lava adjacent at offset (${dx}, ${dy}, ${dz})` };
            }
        }
        return { safe: true, reason: null };
    } catch {
        return { safe: true, reason: null }; // probing must never block mining
    }
}

/** Inventory-full check for mining runs (GO list: inventory-full handling). */
export function inventoryNearlyFull(bot, { minFree = 1 } = {}) {
    try {
        const slots = bot?.inventory?.slots ?? [];
        let free = 0;
        for (let i = 9; i < 45 && i < slots.length; i++) { // main + hotbar, skip armor/offhand
            if (!slots[i]) free++;
        }
        return free < minFree;
    } catch {
        return false;
    }
}

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
export function previewPath(bot, goal, { profile = null, timeout = 1000, ...opts } = {}) {
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
    const out = {
        ok: result?.status === 'success',
        status: result?.status || 'noPath',
        nodes: path.length,
        cost: result?.cost ?? null,
        visitedNodes: result?.visitedNodes ?? null,
        timeMs: Date.now() - start,
        profile: activeProfile,
        goal: goal.describe ? goal.describe() : String(goal),
    };
    // Path visualization support: include the waypoint list when asked
    // (bounded, downsampled to every 2nd node to stay cheap).
    if (opts.includeWaypoints === true && path.length) {
        const sampled = [];
        for (let i = 0; i < path.length; i += 2) sampled.push(path[i]);
        if (sampled[sampled.length - 1] !== path[path.length - 1]) sampled.push(path[path.length - 1]);
        out.waypoints = sampled.slice(0, 512).map(n => ({ x: n.x, y: n.y, z: n.z }));
    }
    return out;
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
    const skippedUnsafe = new Set(); // positions refused by the lava probe
    let mined = 0;
    let reason = 'completed';
    // mine entrance management: remember where this run started so we can
    // find our way out again (GO list: mine entrance management / return path)
    try {
        const here = bot.entity?.position;
        if (here) bot._mine_entrance = { x: Math.round(here.x), y: Math.round(here.y), z: Math.round(here.z) };
    } catch { /* optional */ }
    const types = Array.isArray(opts.types) && opts.types.length ? opts.types.map(String) : [String(blockType)];
    // Resume awareness: note when this run continues an interrupted one.
    let resumed = false;
    try {
        const { loadMineInterrupt } = await import('./mine_state.js');
        const prev = loadMineInterrupt(bot.username ?? bot._autonomy?.agent?.name ?? 'bot');
        resumed = !!prev?.types?.some(t => types.includes(t));
    } catch { /* advisory */ }

    while (mined < count) {
        if (bot.interrupt_code) {
            reason = 'interrupted';
            break;
        }

        // Inventory-full handling: stop before we're stuck with no space.
        if (mined > 0 && mined % 4 === 0 && inventoryNearlyFull(bot)) {
            reason = 'inventory_full';
            break;
        }

        // Vein leftovers first, then the next nearest occurrence.
        let target = veinQueue.shift() || null;
        if (!target) {
            if (types.length === 1) {
                target = world.getNearestBlock(bot, types[0], range);
            } else {
                // Ore prioritization: nearest of each type, dig the
                // highest-priority one first.
                let best = null;
                let bestRank = Infinity;
                for (const t of types) {
                    const b = world.getNearestBlock(bot, t, range);
                    if (!b) continue;
                    const rank = orePriorityRank(t);
                    if (rank < bestRank) { bestRank = rank; best = b; }
                }
                target = best;
            }
            if (!target) {
                const label = types.length === 1 ? types[0] : types.join('/');
                reason = mined > 0
                    ? `no more ${label} within ${range} blocks`
                    : `no ${label} found within ${range} blocks`;
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
        if (!current || !types.includes(current.name)) {
            continue; // skip stale targets without digging air
        }

        // Safe mining: refuse blocks with lava right behind/around them.
        const probe = digIsSafe(bot, current);
        if (!probe.safe) {
            skippedUnsafe.add(posKey(current.position));
            if (opts.onSkippedUnsafe) opts.onSkippedUnsafe(current, probe.reason);
            if (skippedUnsafe.size >= (opts.maxUnsafeSkips || 8)) {
                reason = `too many unsafe blocks skipped (${probe.reason})`;
                break;
            }
            continue;
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
            reason = `failed to dig ${current.name}: ${err.message}`;
            break;
        }

        if (veinEnabled && mined < count) {
            for (const member of findVein(bot, current, current.name, { cap: opts.veinCap || 32, seen: veinSeen })) {
                veinQueue.push(member);
            }
        }
    }

    // Return path: walk back to the entrance we started from, if asked.
    if (opts.returnToEntrance && bot._mine_entrance && !bot.interrupt_code) {
        try {
            const e = bot._mine_entrance;
            const goal = new goals.GoalNear(e.x, e.y, e.z, 2);
            await gotoGoal(bot, goal, { profile: opts.profile });
            reason += ' [returned to entrance]';
        } catch { /* returning is best-effort */ }
    }

    // Mining interruption recovery (GO list): persist what's left so the
    // next run resumes instead of starting blind; clear on completion.
    try {
        const { recordMineInterrupt, clearMineInterrupt, loadMineInterrupt } = await import('./mine_state.js');
        const botName = bot.username ?? bot._autonomy?.agent?.name ?? 'bot';
        if (reason === 'completed') {
            clearMineInterrupt(botName);
        } else {
            const was = loadMineInterrupt(botName) ?? {};
            recordMineInterrupt(botName, {
                types,
                remaining: Math.max(0, count - mined),
                entrance: bot._mine_entrance ?? was.entrance ?? null,
                reason
            });
        }
    } catch { /* interrupt bookkeeping is advisory */ }

    return { mined, requested: count, reason, unsafeSkipped: skippedUnsafe.size, resumed };
}
