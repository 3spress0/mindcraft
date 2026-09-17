// Context-dependent idle behavior.
// chooseIdleAction() is pure and deterministic given the personality rng state
// and context; runIdleAction() executes the choice against the bot.

import pf from 'mineflayer-pathfinder';
import { glance } from './attention.js';
import { sleep } from './rng.js';
import settings from '../../../settings.js';

export const IDLE_ACTIONS = ['glance', 'wander', 'inspect', 'scan', 'pause'];

export function getIdleConfig() {
    const block = settings.humanlike?.idle ?? {};
    return {
        enabled: settings.humanlike?.enabled !== false && block.enabled !== false,
        wander: block.wander !== false,
        inspect: block.inspect !== false,
        min_idle_ms: block.min_idle_ms ?? 5000,       // don't idle-act right after finishing work
        wander_after_ms: block.wander_after_ms ?? 12000,
        radius: Math.max(1, Math.min(8, block.radius ?? 4))
    };
}

/**
 * Pick an idle action deterministically from context + personality.
 * @param {object} ctx
 * @param {number} ctx.idleForMs - ms since the bot finished its last activity
 * @param {string} [ctx.state] - behavior FSM state
 * @param {boolean} [ctx.recentDanger] - damage/threat within the last few seconds
 * @param {Array} [ctx.novelSights] - fresh attention sightings [{pos, kind, dist}]
 * @param {object} personality
 * @returns {{action:string, target?:object, reason:string}}
 */
export function chooseIdleAction(ctx, personality) {
    const cfg = getIdleConfig();
    const t = personality?.traits ?? {};
    const rng = personality?.rng;

    // Threats win: hold still and stay aware.
    if (ctx.recentDanger || ctx.state === 'react' || ctx.state === 'interrupted' || ctx.state === 'recover')
        return { action: 'pause', reason: 'danger' };

    // Fresh interesting sighting -> look at it (curiosity gates it).
    if (ctx.novelSights?.length && rng) {
        const sight = ctx.novelSights[0];
        const p = 0.35 + (t.curiosity ?? 0.5) * 0.6 + (sight.kind === 'player' ? (t.sociability ?? 0.5) * 0.25 : 0);
        if (rng.chance(Math.min(0.95, p)))
            return { action: 'glance', target: sight.pos, reason: `noticed ${sight.kind}` };
    }

    // Just finished working -> a beat of stillness before idling.
    if ((ctx.idleForMs ?? 0) < cfg.min_idle_ms)
        return { action: 'pause', reason: 'settling' };

    const weights = [];
    weights.push(['glance', 1.0 + (t.curiosity ?? 0.5)]);
    weights.push(['scan', 0.5]);
    weights.push(['pause', 0.3 + (t.caution ?? 0.4) * 0.3]);
    if (cfg.inspect) weights.push(['inspect', 0.2 + (t.caution ?? 0.4) * 0.4]);
    if (cfg.wander && (ctx.idleForMs ?? 0) > cfg.wander_after_ms)
        weights.push(['wander', (t.restlessness ?? 0.25) * 2]);

    if (!rng) return { action: 'glance', reason: 'no-rng fallback' };

    const total = weights.reduce((s, w) => s + w[1], 0);
    let roll = rng.next() * total;
    for (const [action, w] of weights) {
        roll -= w;
        if (roll <= 0) return { action, reason: 'weighted' };
    }
    return { action: weights[weights.length - 1][0], reason: 'weighted' };
}

/** Look down at "the bag", hold briefly, look back. Purely visual, no state changes. */
export async function inspectInventory(bot, personality) {
    const start = { yaw: bot.entity?.yaw ?? 0, pitch: bot.entity?.pitch ?? 0 };
    await bot.look(start.yaw, Math.min(1.35, Math.PI / 2 - 0.15), false);
    const ms = personality ? personality.delay(400, 1200) : 700;
    await sleep(ms, bot);
    await bot.look(start.yaw, start.pitch, false);
    return ms;
}

/** Bounded look-around sweep (2-4 stops), non-forced so pathfinding keeps control. */
export async function checkSurroundings(bot, personality) {
    const stops = personality?.rng ? personality.rng.int(2, 4) : 3;
    const start = { yaw: bot.entity?.yaw ?? 0, pitch: bot.entity?.pitch ?? 0 };
    for (let i = 0; i < stops; i++) {
        const yaw = start.yaw + (personality?.rng ? personality.rng.range(-Math.PI, Math.PI) : (i * Math.PI / 2));
        const pitch = personality?.rng ? personality.rng.range(-0.4, 0.3) : 0;
        await bot.look(yaw, pitch, false);
        const ms = personality ? personality.delay(250, 800) : 400;
        await sleep(ms, bot);
        if (bot.interrupt_code) return false;
    }
    await bot.look(start.yaw, start.pitch, false);
    return true;
}

function isSafeSpot(bot, pos) {
    const ground = bot.blockAt?.(pos.offset(0, -1, 0));
    const feet = bot.blockAt?.(pos);
    const head = bot.blockAt?.(pos.offset(0, 1, 0));
    if (!ground || !feet || !head) return false;
    if (!ground.boundingBox || ground.boundingBox === 'empty') return false;
    if (feet.boundingBox !== 'empty' || head.boundingBox !== 'empty') return false;
    const hazards = ['lava', 'fire', 'cactus', 'magma_block', 'powder_snow', 'soul_sand', 'cobweb'];
    for (const b of [ground, feet, head]) if (hazards.includes(b.name)) return false;
    return true;
}

/**
 * Pick a safe nearby spot and walk to it, briefly. Best effort: returns false
 * without moving if nothing safe is found (never throws into the action loop).
 */
export async function shortWander(bot, personality, { radius = null } = {}) {
    const cfg = getIdleConfig();
    const r = radius ?? cfg.radius;
    const rng = personality?.rng;
    const self = bot.entity?.position;
    if (!self || !rng) return false;

    let target = null;
    for (let tries = 0; tries < 6 && !target; tries++) {
        const dx = rng.int(-r, r);
        const dz = rng.int(-r, r);
        if (dx === 0 && dz === 0) continue;
        const pos = self.offset(Math.round(dx), 0, Math.round(dz));
        if (isSafeSpot(bot, pos)) target = pos;
    }
    if (!target) return false;

    try {
        const goal = new pf.goals.GoalNear(target.x, target.y, target.z, 1);
        bot.pathfinder?.setGoal?.(goal);
        // wait for arrival with a bounded timeout
        const deadline = Date.now() + 6000 + (personality ? personality.delay(0, 2000) : 0);
        while (Date.now() < deadline) {
            if (bot.interrupt_code) { bot.pathfinder?.setGoal?.(null); return false; }
            if (bot.entity.position.distanceTo(target) < 1.6) break;
            await sleep(150, bot);
        }
        bot.pathfinder?.setGoal?.(null);
        const holdMs = personality ? personality.delay(500, 1500) : 800;
        await sleep(holdMs, bot);
        return true;
    } catch (e) {
        bot.pathfinder?.setGoal?.(null);
        return false;
    }
}

/** Dispatch a chosen idle action. Returns what happened (for logs/tests). */
export async function runIdleAction(bot, choice, personality, attention = null) {
    if (!choice) return { action: 'none' };
    switch (choice.action) {
        case 'glance': {
            const target = choice.target ?? bot.entity?.position?.offset(0, 0, 2);
            if (!target) return { action: 'glance', skipped: true };
            await glance(bot, target, personality, { minDwellMs: 250, maxDwellMs: 1000 });
            return { action: 'glance' };
        }
        case 'scan': {
            const ok = await checkSurroundings(bot, personality);
            if (attention) attention.scan?.(bot);
            return { action: 'scan', ok };
        }
        case 'inspect': {
            const ms = await inspectInventory(bot, personality);
            return { action: 'inspect', ms };
        }
        case 'wander': {
            const ok = await shortWander(bot, personality);
            return { action: 'wander', ok };
        }
        case 'pause':
        default: {
            const ms = personality ? personality.delay(300, 900) : 500;
            await sleep(ms, bot);
            return { action: 'pause', ms };
        }
    }
}
