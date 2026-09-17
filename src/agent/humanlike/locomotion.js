// humanlike/locomotion.js — humanlike movement texture layered on top of
// baritone/pathfinder (GO list: natural acceleration/deceleration, humanlike
// strafing, stop sprinting near obstacles, humanlike swimming/climbing).
//
// Design rule: we CONFIGURE the pathfinder (sprint gating, pacing pauses,
// goal jitter), we never reimplement 3D pathfinding. All randomness comes
// from the seeded rng layer and is hard-bounded, so behavior stays
// deterministic per personality seed.

import { scanHazards } from '../navigation/hazards.js';

const CLIMBABLE = new Set(['ladder', 'vine', 'twisting_vines', 'weeping_vines', 'scaffolding']);

/**
 * Should the bot hold sprint right now, given where it is on its current
 * path? Encodes natural accel/decel: no sprint for the first few blocks of a
 * run, none for the last few, and none near hazards (GO list: stop sprinting
 * near obstacles).
 * @param {object} ctx - { distFromStart, distToGoal, hazardsNear, baseSprint }
 * @returns {boolean}
 */
export function sprintDecision(ctx = {}) {
    const {
        distFromStart = Infinity,
        distToGoal = Infinity,
        hazardsNear = 0,
        baseSprint = true,
        rampBlocks = 4,
        glideBlocks = 3
    } = ctx;
    if (!baseSprint) return false;
    if (hazardsNear > 0) return false; // obstacles ahead: walk, never sprint
    if (distFromStart < rampBlocks) return false; // accelerating out of the start
    if (distToGoal < glideBlocks) return false; // decelerating into the goal
    return true;
}

/**
 * Count hard/soft hazards near a position (for sprint gating). Never throws.
 */
export function hazardsNearCount(bot, pos, { radius = 3 } = {}) {
    try {
        const found = scanHazards(bot, { center: pos, radius, includeSoft: true });
        return Array.isArray(found) ? found.length : 0;
    } catch { return 0; }
}

/**
 * Humanlike strafing: with a seeded chance, offset the goal laterally by one
 * block so the bot doesn't trace an identical line forever. Pure + bounded.
 * @param {{x:number,z:number}} goal
 * @param {object} rng - seeded rng (reactions/rng.js shape)
 * @param {object} [opts] - { chance, maxOffset, headingDeg }
 * @returns {{x:number,z:number,offset:boolean}}
 */
export function strafeGoal(goal, rng, { chance = 0.2, maxOffset = 1 } = {}) {
    if (!goal || typeof goal.x !== 'number' || !rng) return { ...goal, offset: false };
    const roll = typeof rng.chance === 'function' ? rng.chance(chance) : (rng.float?.() ?? 0) < chance;
    if (!roll) return { x: goal.x, z: goal.z, offset: false };
    const dir = (typeof rng.range === 'function' ? Math.round(rng.range(-1, 1)) : (rng.float?.() < 0.5 ? -1 : 1)) || 1;
    const mag = Math.min(maxOffset, 1);
    // lateral offset perpendicular-ish to travel axis (cheap: pick x or z)
    const axis = typeof rng.chance === 'function' ? (rng.chance(0.5) ? 'x' : 'z') : (rng.float?.() < 0.5 ? 'x' : 'z');
    const out = { x: goal.x, z: goal.z, offset: true };
    out[axis] += dir * mag;
    return out;
}

/**
 * Swim assist decision: when the bot's head is underwater and its air is
 * getting low, it should ride upward (hold jump) toward the surface.
 * Pure — takes plain facts so it is trivially testable.
 * @param {object} ctx - { headInWater, air, maxAir }
 * @returns {{rise:boolean, reason?:string}}
 */
export function swimDecision(ctx = {}) {
    const { headInWater = false, air = 300, maxAir = 300 } = ctx;
    if (!headInWater) return { rise: false, reason: 'not submerged' };
    if (air <= maxAir * 0.5) return { rise: true, reason: 'air low' };
    return { rise: false, reason: 'air fine' };
}

/**
 * Climb pacing decision: on ladders/vines the bot occasionally pauses
 * mid-climb like a player adjusting their grip. Pure + bounded.
 * @param {object} ctx - { onClimbable, climbTicks, pauseChance }
 * @param {object} rng
 */
export function climbDecision(ctx = {}, rng = null) {
    const { onClimbable = false, climbTicks = 0, pauseChance = 0.06, minTicks = 12 } = ctx;
    if (!onClimbable || climbTicks < minTicks) return { pause: false };
    const roll = rng ? (typeof rng.chance === 'function' ? rng.chance(pauseChance) : (rng.float?.() ?? 1) < pauseChance) : false;
    return { pause: !!roll, reason: roll ? 'grip adjust' : null };
}

/** What block is the bot climbing right now (ladder/vine family)? */
export function climbableAt(bot) {
    try {
        const pos = bot?.entity?.position;
        if (!pos) return null;
        for (const dy of [0, 1]) {
            const b = bot.blockAt?.({ x: Math.floor(pos.x), y: Math.floor(pos.y) + dy, z: Math.floor(pos.z) }, false);
            if (b && CLIMBABLE.has(b.name)) return b.name;
        }
    } catch { /* optional */ }
    return null;
}

/**
 * Attach the locomotion texture layer to a live bot. All hooks are advisory
 * and guarded — a missing pathfinder or control API degrades to no-ops.
 * Returns a handle with .detach().
 */
export function attachLocomotion(bot, { rng = null, personality = null } = {}) {
    if (!bot) return { detach() {} };
    if (bot._locomotion_attached) return bot._locomotion_handle ?? { detach() {} };

    const state = {
        pathStartPos: null,
        pathGoal: null,
        climbingTicks: 0,
        sprintWanted: null
    };

    const baseSprint = () => {
        // honor the existing humanlike sprint-ratio mixing when present
        if (personality?.sprintRatio != null) {
            return rng ? rng.chance(personality.sprintRatio) : true;
        }
        return true;
    };

    const applySprint = (on) => {
        try {
            if (state.sprintWanted === on) return;
            state.sprintWanted = on;
            bot.setControlState?.('sprint', on);
        } catch { /* control state optional */ }
    };

    const onPathUpdate = (results) => {
        try {
            if (!state.pathStartPos) state.pathStartPos = { ...bot.entity?.position };
            const goal = results?.goal ?? bot.pathfinder?.goal;
            if (goal && typeof goal.x === 'number') state.pathGoal = { x: goal.x, y: goal.y, z: goal.z };
        } catch { /* advisory */ }
    };

    const onGoalReached = () => {
        state.pathStartPos = null;
        state.pathGoal = null;
    };

    let tickCount = 0;
    const onPhysicsTick = () => {
        try {
            tickCount++;
            if (tickCount % 4 !== 0) return; // cheap: evaluate 5x/sec
            const pos = bot.entity?.position;
            if (!pos) return;

            // --- climbing pacing ---
            const climbing = climbableAt(bot);
            if (climbing) {
                state.climbingTicks += 4;
                const d = climbDecision({ onClimbable: true, climbTicks: state.climbingTicks }, rng);
                if (d.pause) {
                    try {
                        bot.setControlState?.('forward', false);
                        setTimeout(() => { try { bot.setControlState?.('forward', true); } catch { /* ok */ } }, 160);
                    } catch { /* ok */ }
                }
            } else {
                state.climbingTicks = 0;
            }

            // --- swim assist ---
            const head = bot.blockAt?.({ x: pos.x, y: pos.y + 1.6, z: pos.z }, false);
            const headInWater = !!head && (head.name === 'water' || head.name === 'bubble_column');
            if (headInWater) {
                const air = typeof bot.air === 'number' ? bot.air : (bot.oxygenLevel ?? 20) * 15;
                const d = swimDecision({ headInWater: true, air, maxAir: 300 });
                if (d.rise) {
                    try {
                        bot.setControlState?.('jump', true);
                        setTimeout(() => { try { bot.setControlState?.('jump', false); } catch { /* ok */ } }, 220);
                    } catch { /* ok */ }
                }
            }

            // --- sprint gating (accel/decel + obstacles) ---
            if (!bot.pathfinder?.isMoving?.()) { state.pathStartPos = null; return; }
            const start = state.pathStartPos ?? pos;
            const distFromStart = Math.hypot(pos.x - start.x, pos.z - start.z);
            const goal = state.pathGoal ?? bot.pathfinder?.goal;
            const distToGoal = goal && typeof goal.x === 'number'
                ? Math.hypot(pos.x - goal.x, pos.z - goal.z) : Infinity;
            const hazardsNear = hazardsNearCount(bot, pos, { radius: 3 });
            applySprint(sprintDecision({ distFromStart, distToGoal, hazardsNear, baseSprint: baseSprint() }));
        } catch { /* locomotion must never throw */ }
    };

    bot.on?.('path_update', onPathUpdate);
    bot.on?.('goal_reached', onGoalReached);
    bot.on?.('physicTick', onPhysicsTick);
    bot.on?.('physicsTick', onPhysicsTick);

    const handle = {
        state,
        detach() {
            try { bot.removeListener?.('path_update', onPathUpdate); } catch { /* ok */ }
            try { bot.removeListener?.('goal_reached', onGoalReached); } catch { /* ok */ }
            try { bot.removeListener?.('physicTick', onPhysicsTick); } catch { /* ok */ }
            try { bot.removeListener?.('physicsTick', onPhysicsTick); } catch { /* ok */ }
            bot._locomotion_attached = false;
        }
    };
    bot._locomotion_attached = true;
    bot._locomotion_handle = handle;
    return handle;
}
