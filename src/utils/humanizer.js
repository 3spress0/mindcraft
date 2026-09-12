/**
 * humanizer.js
 *
 * Humanlike-locomotion plugin layered on top of mineflayer-pathfinder (the
 * mineflayer equivalent of the Baritone mod — Baritone itself is a Java mod
 * and cannot be embedded in mineflayer, see FAQ.md).
 *
 * Raw pathfinder movement has several obvious machine tells:
 *   1. The head snaps to the exact travel heading every tick and the pitch is
 *      hard-locked to 0 (a perfectly level, unblinking stare).
 *   2. It sprints 100% of the time at perfectly constant pace.
 *   3. It starts moving with zero reaction time and never hesitates.
 *   4. It stands completely frozen when idle.
 *
 * This plugin softens all four:
 *   - rate-limited, eased gaze with occasional overshoot/flick correction,
 *     micro-jitter and a natural vertical gaze wander while walking;
 *   - randomized walk/sprint pacing (only ever on flat, safe ground — jumps,
 *     gaps, water and edge-work are left exactly as pathfinder planned them);
 *   - a small jittered startup reaction delay and rare mid-route "thinking"
 *     pauses;
 *   - occasional slow glances around while standing still.
 *
 * It is deliberately a locomotion-only layer: digging, block placement, PvP
 * aiming, combat, eating and every explicit `bot.look`/`bot.lookAt` call made
 * by skills bypass the smoothing untouched.
 */

import { performance } from 'perf_hooks';
import { Vec3 } from 'vec3';
import settings from '../agent/settings.js';

export const TICK_MS = 50;
const TAU = Math.PI * 2;
const DEG = Math.PI / 180;

/**
 * @typedef {Object} HumanlikeConfig
 * @property {boolean} enabled            master switch
 * @property {boolean} smooth_gaze        rate-limit/ease head turns while traveling
 * @property {number}  max_turn_rate_deg  max yaw change per game tick (20 ticks/s)
 * @property {number}  gaze_turn_gain     fraction of heading error closed per tick (0..1)
 * @property {number}  gaze_jitter_deg    random gaze noise per tick, in degrees
 * @property {number}  gaze_pitch_var     radians of vertical gaze wander while walking
 * @property {boolean} varied_pace        mix walking and sprinting
 * @property {number}  sprint_ratio       approx share of travel time spent sprinting (0..1)
 * @property {number}  reaction_delay_ms  max startup reaction delay (jittered from 0)
 * @property {boolean} hesitations        allow brief mid-route pauses
 * @property {number}  hesitation_min_s   min seconds between hesitation pauses
 * @property {number}  hesitation_max_s   max seconds between hesitation pauses
 * @property {boolean} idle_glances       look around naturally while standing still
 * @property {number}  idle_min_s         min seconds between idle glances
 * @property {number}  idle_max_s         max seconds between idle glances
 * @property {boolean} idle_arm_swing     occasionally swing the arm while idle
 * @property {number}  external_look_hold_ms  suppress idle glances this long after a scripted look
 */
const DEFAULTS = {
    enabled: true,
    smooth_gaze: true,
    max_turn_rate_deg: 17,
    gaze_turn_gain: 0.42,
    gaze_jitter_deg: 0.7,
    gaze_pitch_var: 0.13,
    varied_pace: true,
    sprint_ratio: 0.72,
    reaction_delay_ms: 220,
    hesitations: true,
    hesitation_min_s: 6,
    hesitation_max_s: 20,
    idle_glances: true,
    idle_min_s: 3,
    idle_max_s: 10,
    idle_arm_swing: false,
    external_look_hold_ms: 2500,
};

export function getConfig() {
    return { ...DEFAULTS, ...(settings.humanlike || {}) };
}

export function wrapAngle(a) {
    let r = a % TAU;
    if (r > Math.PI) r -= TAU;
    if (r < -Math.PI) r += TAU;
    return r;
}

export function angleDelta(target, current) {
    return wrapAngle(target - current);
}

function rand(min, max) {
    return min + Math.random() * (max - min);
}

function randInt(min, max) {
    return Math.floor(rand(min, max + 1));
}

function clamp(v, min, max) {
    return Math.max(min, Math.min(max, v));
}

function blockAt(bot, x, y, z) {
    return bot.blockAt(new Vec3(Math.floor(x), Math.floor(y), Math.floor(z)));
}

function isSolid(b) {
    return !!b && b.boundingBox === 'block';
}

function isPassable(b) {
    return !b || b.boundingBox !== 'block';
}

/**
 * True only when the next two blocks of travel are flat floor with full
 * headroom. Sprint-jumps across gaps, ledges, steps and doors fail this probe,
 * so the pacing governor never weakens movement that pathfinder tuned.
 */
export function terrainFlatAhead(bot, headingYaw) {
    const e = bot.entity;
    const p = e.position;
    const fy = Math.floor(p.y);

    const groundHere = blockAt(bot, p.x, fy - 1, p.z);
    if (!isSolid(groundHere)) return false;

    const sin = Math.sin(headingYaw);
    const cos = Math.cos(headingYaw);
    for (const dist of [1, 2]) {
        // Minecraft travel convention: dx = -sin(yaw)*d, dz = -cos(yaw)*d
        const gx = p.x - sin * dist;
        const gz = p.z - cos * dist;
        const ground = blockAt(bot, gx, fy - 1, gz);
        const feet = blockAt(bot, gx, fy, gz);
        const head = blockAt(bot, gx, fy + 1, gz);
        if (!isSolid(ground)) return false;
        if (!isPassable(feet) || !isPassable(head)) return false;
    }
    return true;
}

export function humanizer(bot) {
    const clock = () => (typeof bot._humanizerNow === 'function' ? bot._humanizerNow() : performance.now());

    // Per-spawn personality so two bots don't move in lockstep.
    const traits = {
        sprintRatio: clamp(getConfig().sprint_ratio + rand(-0.08, 0.08), 0.45, 0.92),
        turnGain: rand(0.9, 1.15),
        flickChance: rand(0.25, 0.55),
        glanceRate: rand(0.7, 1.3),
        pauseRate: rand(0.7, 1.3),
    };

    let manualDisable = false;

    const gaze = {
        active: false,
        yaw: 0,
        pitch: 0,
        desiredYaw: 0,
        hasInput: false,
        overshoot: 0,
        pitchSeed: rand(0, TAU),
    };

    const drive = {
        active: false,
        startedAt: 0,
        holdTicks: 0,
    };

    const pace = {
        mode: 'sprint', // 'sprint' | 'walk'
        until: 0,
    };

    const hesitation = {
        nextAt: 0,
        ticksLeft: 0,
    };

    const idle = {
        nextGlanceAt: 0,
        phase: 'hold', // 'hold' | 'turn' | 'return'
        baseYaw: 0,
        targetYaw: 0,
        targetPitch: 0,
        holdUntil: 0,
        nextSwingAt: 0,
    };

    let lastExternalLookAt = 0;

    function isBusyElsewhere() {
        const pf = bot.pathfinder;
        if (pf && (pf.isMining() || pf.isBuilding())) return true;
        if (bot.pvp && bot.pvp.target) return true;
        if (bot.targetDigBlock) return true;
        if (bot.vehicle != null || (bot.entity && bot.entity.vehicle != null)) return true;
        return false;
    }

    function isDriving() {
        const pf = bot.pathfinder;
        const e = bot.entity;
        if (!pf || !e || !bot.isAlive) return false;
        if (!pf.isMoving()) return false;
        if (isBusyElsewhere()) return false;
        return true;
    }

    function startDrive(c) {
        const now = clock();
        drive.active = true;
        drive.startedAt = now;
        drive.holdTicks = c.reaction_delay_ms > 0 ? randInt(0, Math.round(c.reaction_delay_ms / TICK_MS)) : 0;

        gaze.active = !!c.smooth_gaze;
        gaze.yaw = bot.entity.yaw;
        gaze.pitch = bot.entity.pitch;
        gaze.hasInput = false;
        gaze.overshoot = 0;
        gaze.pitchSeed = rand(0, TAU);

        pace.mode = 'sprint';
        pace.until = now + rand(2500, 7000);
        hesitation.ticksLeft = 0;
        hesitation.nextAt = now + rand(c.hesitation_min_s, c.hesitation_max_s) * 1000 * traits.pauseRate;
    }

    function endDrive() {
        drive.active = false;
        gaze.active = false;
        gaze.hasInput = false;
        pace.mode = 'sprint';
        hesitation.ticksLeft = 0;
        // Let scripted behavior own the camera immediately on arrival.
        lastExternalLookAt = clock();
        idle.phase = 'hold';
        idle.nextGlanceAt = clock() + rand(1500, 4000);
    }

    /**
     * Ease the current gaze toward the pathfinder's requested heading.
     */
    function tickTravelGaze(c, now) {
        if (!c.smooth_gaze || !gaze.hasInput) return;

        const maxStep = c.max_turn_rate_deg * DEG;
        const gain = c.gaze_turn_gain * traits.turnGain;
        let err = angleDelta(gaze.desiredYaw + gaze.overshoot, gaze.yaw);

        // Occasionally commit a small flick past the heading and correct back,
        // like a human overshooting a mouse turn.
        if (gaze.overshoot === 0 && Math.abs(angleDelta(gaze.desiredYaw, gaze.yaw)) > 25 * DEG &&
            Math.random() < traits.flickChance * 0.15) {
            gaze.overshoot = (err >= 0 ? 1 : -1) * rand(1.5, 4.5) * DEG;
            err = angleDelta(gaze.desiredYaw + gaze.overshoot, gaze.yaw);
        }
        if (gaze.overshoot !== 0 && Math.abs(angleDelta(gaze.desiredYaw, gaze.yaw)) < 2 * DEG) {
            gaze.overshoot = 0;
        }

        let step = err * gain;
        step = clamp(step, -maxStep, maxStep);
        step += rand(-1, 1) * c.gaze_jitter_deg * DEG;
        if (Math.abs(err) < Math.max(0.008, c.gaze_jitter_deg * DEG)) {
            gaze.yaw = gaze.desiredYaw + gaze.overshoot;
        } else {
            gaze.yaw = wrapAngle(gaze.yaw + step);
        }

        // Humans don't walk with their gaze nailed to the horizon: slow,
        // bounded vertical wander biased slightly toward the ground.
        const t = now / 1000;
        const wander = (Math.sin(t * 0.9 + gaze.pitchSeed) * 0.6 +
            Math.sin(t * 0.37 + gaze.pitchSeed * 2) * 0.4) * c.gaze_pitch_var;
        const pitchTarget = clamp(0.045 + wander, -c.gaze_pitch_var, c.gaze_pitch_var + 0.12);
        const pitchErr = pitchTarget - gaze.pitch;
        gaze.pitch += clamp(pitchErr * 0.08, -0.022, 0.022);
        gaze.pitch = clamp(gaze.pitch, -0.5, 0.6);

        void nativeLook(gaze.yaw, gaze.pitch, true);
    }

    function paceGatesOpen() {
        const e = bot.entity;
        if (drive.holdTicks > 0 || hesitation.ticksLeft > 0) return false;
        if (!e.onGround || e.isInWater || e.isInLava) return false;
        if (bot.getControlState('jump') || bot.getControlState('sneak') || bot.getControlState('back')) return false;
        if (!bot.getControlState('forward') || !bot.getControlState('sprint')) return false;
        if (isBusyElsewhere()) return false;
        return terrainFlatAhead(bot, gaze.hasInput ? gaze.desiredYaw : e.yaw);
    }

    function tickPacing(c, now) {
        if (c.varied_pace) {
            if (pace.mode === 'sprint' && now >= pace.until) {
                pace.mode = 'walk';
                const walkDur = rand(700, 2400);
                const ratio = traits.sprintRatio / (1 - traits.sprintRatio);
                const sprintDur = walkDur * ratio * rand(0.75, 1.25);
                pace.until = now + walkDur;
                pace.pairedSprintDur = sprintDur;
            } else if (pace.mode === 'walk' && now >= pace.until) {
                pace.mode = 'sprint';
                pace.until = now + (pace.pairedSprintDur || rand(2500, 7000));
            }

            if (pace.mode === 'walk' && paceGatesOpen()) {
                bot.setControlState('sprint', false);
            }
        }

        if (c.hesitations) {
            if (hesitation.ticksLeft > 0) {
                hesitation.ticksLeft -= 1;
                bot.setControlState('forward', false);
                bot.setControlState('sprint', false);
            } else if (now >= hesitation.nextAt && now - drive.startedAt > 1500 && paceGatesOpen()) {
                // This tick is already a pause tick; 0-2 more keep the total at
                // 1-3 ticks (50-150 ms, far under pathfinder's 3.5s stuck timeout).
                hesitation.ticksLeft = randInt(0, 2);
                // Cooldown starts only once this pause has fully elapsed, so
                // tightly tuned intervals can never tile into a long stop.
                hesitation.nextAt = now + (hesitation.ticksLeft + 1) * TICK_MS +
                    rand(c.hesitation_min_s, c.hesitation_max_s) * 1000 * traits.pauseRate;
                bot.setControlState('forward', false);
                bot.setControlState('sprint', false);
            }
        }
    }

    function tickDriving(c, now) {
        if (drive.holdTicks > 0) {
            // Jittered "reaction time" before setting off.
            drive.holdTicks -= 1;
            bot.setControlState('forward', false);
            bot.setControlState('sprint', false);
        }

        tickTravelGaze(c, now);

        if (drive.holdTicks === 0) {
            tickPacing(c, now);
        }
    }

    function idleAllowed(now) {
        const pf = bot.pathfinder;
        const e = bot.entity;
        if (!e || !bot.isAlive) return false;
        if (!e.onGround || e.isInWater || e.isInLava) return false;
        if (bot.getControlState('forward') || bot.getControlState('back') ||
            bot.getControlState('jump') || bot.getControlState('sneak')) return false;
        if (Math.abs(e.velocity.x) > 0.03 || Math.abs(e.velocity.z) > 0.03) return false;
        if (pf && (pf.isMoving() || pf.isMining() || pf.isBuilding())) return false;
        if (isBusyElsewhere()) return false;
        if (now - lastExternalLookAt < getConfig().external_look_hold_ms) return false;
        return true;
    }

    function stepToward(current, target, rate) {
        const err = angleDelta(target, current);
        if (Math.abs(err) <= rate) return target;
        return wrapAngle(current + Math.sign(err) * rate);
    }

    function tickIdle(c, now) {
        if (!c.idle_glances) return;

        if (idle.phase === 'hold') {
            if (!idleAllowed(now)) {
                idle.nextGlanceAt = Math.max(idle.nextGlanceAt, now + 500);
                return;
            }
            if (c.idle_arm_swing && bot.swingArm && now >= idle.nextSwingAt) {
                bot.swingArm('right');
                idle.nextSwingAt = now + rand(8000, 30000);
            }
            if (now < idle.nextGlanceAt) return;

            // Begin a glance: mostly small, occasionally broad.
            idle.baseYaw = bot.entity.yaw;
            let offset = (Math.random() + Math.random() + Math.random() - 1.5) * 0.45 * traits.glanceRate;
            offset = clamp(offset, -1.05, 1.05);
            idle.targetYaw = wrapAngle(bot.entity.yaw + offset);
            idle.targetPitch = clamp(bot.entity.pitch + rand(-0.28, 0.18), -0.6, 0.55);
            idle.phase = 'turn';
        }

        if (idle.phase === 'turn') {
            if (!idleAllowed(now)) {
                idle.phase = 'hold';
                idle.nextGlanceAt = now + rand(c.idle_min_s, c.idle_max_s) * 1000;
                return;
            }
            const nextYaw = stepToward(bot.entity.yaw, idle.targetYaw, rand(0.02, 0.055));
            const nextPitch = stepToward(bot.entity.pitch, idle.targetPitch, 0.02);
            void nativeLook(nextYaw, nextPitch, true);
            if (nextYaw === idle.targetYaw && Math.abs(idle.targetPitch - bot.entity.pitch) < 0.02) {
                idle.holdUntil = now + rand(700, 2600);
                idle.phase = 'dwell';
            }
            return;
        }

        if (idle.phase === 'dwell') {
            if (!idleAllowed(now)) {
                idle.phase = 'hold';
                idle.nextGlanceAt = now + rand(c.idle_min_s, c.idle_max_s) * 1000;
                return;
            }
            // Tiny breathing-style micro motion.
            void nativeLook(
                wrapAngle(bot.entity.yaw + rand(-0.0025, 0.0025)),
                clamp(bot.entity.pitch + rand(-0.002, 0.002), -0.6, 0.55),
                true
            );
            if (now < idle.holdUntil) return;
            if (Math.random() < 0.62) {
                idle.targetYaw = idle.baseYaw;
                idle.targetPitch = 0;
                idle.phase = 'return';
            } else {
                idle.phase = 'hold';
                idle.nextGlanceAt = now + rand(c.idle_min_s, c.idle_max_s) * 1000;
            }
            return;
        }

        if (idle.phase === 'return') {
            if (!idleAllowed(now)) {
                idle.phase = 'hold';
                idle.nextGlanceAt = now + rand(c.idle_min_s, c.idle_max_s) * 1000;
                return;
            }
            const nextYaw = stepToward(bot.entity.yaw, idle.targetYaw, rand(0.015, 0.04));
            const nextPitch = stepToward(bot.entity.pitch, idle.targetPitch, 0.015);
            void nativeLook(nextYaw, nextPitch, true);
            if (nextYaw === idle.targetYaw) {
                idle.phase = 'hold';
                idle.nextGlanceAt = now + rand(c.idle_min_s, c.idle_max_s) * 1000;
            }
            return;
        }
    }

    // --- mineflayer wiring -------------------------------------------------

    const nativeLook = bot.look.bind(bot);
    bot.look = (yaw, pitch, force) => {
        lastExternalLookAt = clock();
        const c = getConfig();
        const on = c.enabled && !manualDisable;
        // Arm the drive on the very first pathfinder look of a trip, one tick
        // before our physicsTick handler would notice isMoving().
        if (on && !drive.active && bot.pathfinder && bot.pathfinder.isMoving() &&
            !bot.pathfinder.isMining() && !bot.pathfinder.isBuilding() && !isBusyElsewhere()) {
            startDrive(c);
        }
        if (on && gaze.active && drive.active && !isBusyElsewhere()) {
            // Pathfinder's per-tick travel heading: feed it to the gaze
            // controller instead of snapping the head instantly.
            gaze.desiredYaw = yaw;
            gaze.hasInput = true;
            return Promise.resolve();
        }
        return nativeLook(yaw, pitch, force);
    };

    bot.on('physicsTick', () => {
        const c = getConfig();
        if (!c.enabled || manualDisable || !bot.entity) return;

        const driving = isDriving();
        if (driving && !drive.active) startDrive(c);
        if (!driving && drive.active) endDrive();

        if (driving) tickDriving(c, clock());
        else tickIdle(c, clock());
    });

    // Teleports / dimension changes move the body without us driving.
    const resetGaze = () => {
        gaze.yaw = bot.entity ? bot.entity.yaw : 0;
        gaze.pitch = bot.entity ? bot.entity.pitch : 0;
        gaze.overshoot = 0;
        idle.phase = 'hold';
    };
    bot.on('forcedMove', resetGaze);
    bot.on('respawn', resetGaze);

    bot.humanizer = {
        isEnabled: () => !manualDisable && getConfig().enabled,
        setEnabled: (on) => {
            manualDisable = !on;
            if (!on) {
                if (drive.active) endDrive();
                idle.phase = 'hold';
            }
        },
        traits,
        // Exposed for tests and diagnostics.
        _state: { gaze, drive, pace, hesitation, idle },
    };
}

export default humanizer;
