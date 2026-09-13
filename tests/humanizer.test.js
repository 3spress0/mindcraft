import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { Vec3 } from 'vec3';
import settings from '../src/agent/settings.js';
import humanizer, { wrapAngle, angleDelta, terrainFlatAhead } from '../src/utils/humanizer.js';

const DEG = Math.PI / 180;

// Deterministic LCG so humanlike randomness is testable.
let seed = 12345;
const origRandom = Math.random;
function srand() {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296;
}

const AIR = { boundingBox: 'empty', name: 'air' };
const STONE = { boundingBox: 'block', name: 'stone' };

function flatWorld(gap = []) {
    const blocks = new Map();
    for (let x = -3; x <= 5; x++) {
        for (let z = -3; z <= 6; z++) {
            if (gap.some(([gx, gz]) => gx === x && gz === z)) continue;
            blocks.set(`${x},63,${z}`, STONE);
        }
    }
    return blocks;
}

class FakeBot {
    constructor(blocks = flatWorld()) {
        this._listeners = new Map();
        this.isAlive = true;
        this.vehicle = null;
        this.entity = {
            yaw: 0,
            pitch: 0,
            position: new Vec3(0.5, 64, 0.5),
            velocity: new Vec3(0, 0, 0),
            onGround: true,
            isInWater: false,
            isInLava: false,
            vehicle: null,
        };
        this.control = {
            forward: false, back: false, left: false, right: false,
            jump: false, sprint: false, sneak: false,
        };
        this.targetDigBlock = null;
        this.pvp = null;
        this.blocks = blocks;
        this.lookCalls = [];
        this.swings = 0;
        this.now = 0;
        this._humanizerNow = () => this.now;
        this.pathfinder = {
            moving: false, mining: false, building: false,
            isMoving() { return this.moving; },
            isMining() { return this.mining; },
            isBuilding() { return this.building; },
        };
        // Native mineflayer look: rotation applies immediately.
        this.look = async (yaw, pitch) => {
            this.lookCalls.push([yaw, pitch]);
            this.entity.yaw = yaw;
            this.entity.pitch = pitch;
        };
    }

    on(event, fn) {
        if (!this._listeners.has(event)) this._listeners.set(event, []);
        this._listeners.get(event).push(fn);
    }

    emit(event, ...args) {
        for (const fn of this._listeners.get(event) || []) fn(...args);
    }

    setControlState(c, s) { this.control[c] = s; }
    getControlState(c) { return !!this.control[c]; }
    clearControlStates() {
        for (const k of Object.keys(this.control)) this.control[k] = false;
    }

    swingArm() { this.swings++; }

    blockAt(v) {
        return this.blocks.get(`${v.x},${v.y},${v.z}`) || AIR;
    }
}

function makeBot(config = {}, blocks) {
    settings.humanlike = {
        smooth_gaze: true,
        varied_pace: true,
        hesitations: true,
        idle_glances: true,
        reaction_delay_ms: 0,
        external_look_hold_ms: 500,
        ...config,
    };
    const bot = new FakeBot(blocks);
    humanizer(bot);
    // De-randomize the personality unless a test wants it.
    Object.assign(bot.humanizer.traits, {
        sprintRatio: 0.5, turnGain: 1, flickChance: 0,
        glanceRate: 1, pauseRate: 1,
    });
    return bot;
}

// Emulate one pathfinder physics tick: controls set first, then look,
// then the post-pathfinder humanizer listener runs.
function travelTick(bot, opts = {}) {
    const { yaw = Math.PI, sprint = true, jump = false, sneak = false, dt = 50 } = opts;
    bot.pathfinder.moving = true;
    bot.control.forward = true;
    bot.control.sprint = sprint;
    bot.control.jump = jump;
    bot.control.sneak = sneak;
    void bot.look(yaw, 0);
    bot.now += dt;
    bot.emit('physicsTick');
}

function stopTravel(bot) {
    bot.pathfinder.moving = false;
    bot.clearControlStates();
    bot.now += 50;
    bot.emit('physicsTick');
}

beforeEach(() => {
    Math.random = srand;
    seed = 987654321;
});

afterEach(() => {
    Math.random = origRandom;
    delete settings.humanlike;
});

test('angle math wraps correctly', () => {
    assert.ok(Math.abs(angleDelta(Math.PI * 1.5, 0) - wrapAngle(-Math.PI / 2)) < 1e-9);
    assert.ok(Math.abs(angleDelta(0.1, 0) - 0.1) < 1e-9);
    assert.ok(Math.abs(angleDelta(0, 0.1) + 0.1) < 1e-9);
    assert.equal(wrapAngle(3 * Math.PI), Math.PI);
});

test('terrainFlatAhead detects gaps', () => {
    const flat = makeBot();
    // heading PI => travelling toward +z
    assert.equal(terrainFlatAhead(flat, Math.PI), true);

    const gapBlocks = flatWorld();
    gapBlocks.delete('0,63,1');
    gapBlocks.delete('0,63,2');
    const gap = makeBot({}, gapBlocks);
    assert.equal(terrainFlatAhead(gap, Math.PI), false);
});

test('travel gaze eases toward heading at a bounded rate instead of snapping', () => {
    const bot = makeBot({ varied_pace: false, hesitations: false, idle_glances: false });
    const target = Math.PI / 2;

    let prev = bot.entity.yaw;
    let maxStep = 0;
    for (let i = 0; i < 40; i++) {
        travelTick(bot, { yaw: target });
        const d = Math.abs(angleDelta(bot.entity.yaw, prev));
        maxStep = Math.max(maxStep, d);
        prev = bot.entity.yaw;
    }

    // 17 deg/tick cap + up to 0.7 deg jitter allowance
    assert.ok(maxStep <= 17 * DEG + 1.5 * 0.7 * DEG + 1e-6,
        `turn step ${maxStep} exceeded cap`);
    // First tick must be a smooth step, not the full 90 deg snap.
    assert.ok(Math.abs(bot.lookCalls[0][0] - target) > 0.5);
    // Converges near the requested heading.
    assert.ok(Math.abs(angleDelta(target, bot.entity.yaw)) < 0.06,
        `final yaw ${bot.entity.yaw} did not converge`);
    // Pitch comes off the robotic zero lock but stays bounded.
    assert.ok(Math.abs(bot.entity.pitch) <= 0.3);
    const pitches = new Set(bot.lookCalls.slice(0, 10).map(c => Math.round(c[1] * 1000)));
    assert.ok(pitches.size > 1, 'pitch should wander while walking');
});

test('varied pace walks some of the time on flat ground', () => {
    const bot = makeBot({ hesitations: false, idle_glances: false });
    let walkTicks = 0;
    let forwardTicks = 0;
    for (let i = 0; i < 3000; i++) { // 150 s of travel
        travelTick(bot, { yaw: Math.PI });
        if (!bot.control.sprint) walkTicks++;
        if (bot.control.forward) forwardTicks++;
    }
    assert.ok(walkTicks > 20, `expected walk segments, got ${walkTicks} walk ticks`);
    assert.ok(forwardTicks > 2900, `forward should stay held, got ${forwardTicks}`);
    // Majority at the configured ~50% trait... sanity bound: sprint sometimes too.
    assert.ok(walkTicks < 2000, 'bot should still sprint a good share of the route');
});

test('pacing never weakens sprint during jumps, over gaps, or in water', () => {
    // Sprint-jump
    const jumper = makeBot({ hesitations: false, idle_glances: false });
    for (let i = 0; i < 300; i++) {
        travelTick(jumper, { yaw: Math.PI, jump: true });
        assert.equal(jumper.control.sprint, true, 'sprint must stay on while jump is held');
    }

    // Gap ahead (blocks at z+1/z+2 removed)
    const gapBlocks = flatWorld();
    gapBlocks.delete('0,63,1');
    gapBlocks.delete('0,63,2');
    const gapBot = makeBot({ hesitations: false, idle_glances: false }, gapBlocks);
    for (let i = 0; i < 300; i++) {
        travelTick(gapBot, { yaw: Math.PI });
        assert.equal(gapBot.control.sprint, true, 'sprint must stay on approaching a gap');
    }

    // In water
    const swimmer = makeBot({ hesitations: false, idle_glances: false });
    swimmer.entity.isInWater = true;
    swimmer.entity.onGround = false;
    for (let i = 0; i < 100; i++) {
        swimmer.pathfinder.moving = true;
        swimmer.control.forward = true;
        swimmer.control.jump = true; // pathfinder swims with jump
        swimmer.control.sprint = false;
        void swimmer.look(Math.PI, 0);
        swimmer.now += 50;
        swimmer.emit('physicsTick');
        assert.equal(swimmer.control.sprint, false);
    }
});

test('hesitation pauses are short (1-3 ticks) and release forward', () => {
    const bot = makeBot({
        varied_pace: false, idle_glances: false,
        hesitation_min_s: 0.2, hesitation_max_s: 0.2,
    });
    let pauses = 0;
    let maxPause = 0;
    let run = 0;
    let wasForward = true;
    for (let i = 0; i < 2000; i++) {
        travelTick(bot, { yaw: Math.PI });
        if (!bot.control.forward) {
            if (wasForward) { pauses++; run = 0; }
            run++;
            maxPause = Math.max(maxPause, run);
            assert.equal(bot.control.sprint, false);
        }
        wasForward = bot.control.forward;
    }
    assert.ok(pauses >= 1, 'expected at least one hesitation');
    assert.ok(maxPause <= 3, `pause lasted ${maxPause} ticks (max 3)`);
});

test('reaction delay briefly holds movement at trip start', () => {
    const bot = makeBot({
        reaction_delay_ms: 0, varied_pace: false, hesitations: false, idle_glances: false,
    });
    travelTick(bot, { yaw: Math.PI }); // arms the drive with no random hold
    assert.equal(bot.humanizer._state.drive.holdTicks, 0);

    // Inject a deterministic 3-tick hold and verify forward is released for
    // exactly 3 ticks, then normal movement resumes.
    bot.humanizer._state.drive.holdTicks = 3;
    let held = 0;
    for (let i = 0; i < 8; i++) {
        travelTick(bot, { yaw: Math.PI });
        if (!bot.control.forward) held++;
    }
    assert.equal(held, 3, `expected 3 held ticks, got ${held}`);
    assert.equal(bot.control.forward, true);
    assert.equal(bot.control.sprint, true);
});

test('idle glances happen after a quiet period and are bounded', () => {
    const bot = makeBot({
        smooth_gaze: false, varied_pace: false, hesitations: false,
        idle_min_s: 1, idle_max_s: 1, external_look_hold_ms: 200,
    });
    const startYaw = bot.entity.yaw;
    bot.lookCalls.length = 0;
    for (let i = 0; i < 400; i++) { // 20 s idle
        bot.now += 50;
        bot.emit('physicsTick');
    }
    assert.ok(bot.lookCalls.length > 0, 'expected idle glance look calls');
    const maxYaw = Math.max(...bot.lookCalls.map(c => Math.abs(angleDelta(c[0], startYaw))));
    assert.ok(maxYaw <= 1.06, `glance too wide: ${maxYaw}`);
});

test('idle glances are suppressed right after a scripted lookAt', () => {
    const bot = makeBot({
        smooth_gaze: false, varied_pace: false, hesitations: false,
        idle_glances: true, idle_min_s: 0, idle_max_s: 0, external_look_hold_ms: 1000,
    });
    void bot.look(0.4, 0); // scripted look, e.g. facing a player
    bot.lookCalls.length = 0;
    for (let i = 0; i < 10; i++) { // 500 ms, below the 1 s hold
        bot.now += 50;
        bot.emit('physicsTick');
    }
    assert.equal(bot.lookCalls.length, 0, 'idle director must not fight a scripted look');
});

test('combat and digging bypass humanization entirely', () => {
    const pvpBot = makeBot({ idle_glances: false });
    pvpBot.pvp = { target: { name: 'zombie' } };
    pvpBot.lookCalls.length = 0;
    travelTick(pvpBot, { yaw: 1.23, sprint: true });
    assert.equal(pvpBot.humanizer._state.drive.active, false);
    assert.equal(pvpBot.lookCalls.length, 1);
    assert.ok(Math.abs(pvpBot.lookCalls[0][0] - 1.23) < 1e-9);
    assert.equal(pvpBot.control.sprint, true);

    const digBot = makeBot({ idle_glances: false });
    digBot.targetDigBlock = { position: new Vec3(0, 64, 1) };
    digBot.lookCalls.length = 0;
    travelTick(digBot, { yaw: 0.5, sprint: false });
    assert.equal(digBot.humanizer._state.drive.active, false);
    assert.ok(Math.abs(digBot.lookCalls[0][0] - 0.5) < 1e-9);
});

test('master disable restores raw pathfinder behavior', () => {
    const bot = makeBot({ enabled: false, idle_glances: false });
    bot.lookCalls.length = 0;
    travelTick(bot, { yaw: 2.2, sprint: true });
    assert.equal(bot.humanizer.isEnabled(), false);
    assert.equal(bot.lookCalls.length, 1, 'raw look should pass through');
    assert.ok(Math.abs(bot.lookCalls[0][0] - 2.2) < 1e-9);
    assert.equal(bot.control.sprint, true);
    assert.equal(bot.control.forward, true);
});

test('setEnabled(false) at runtime stops an active trip humanization', () => {
    const bot = makeBot({ varied_pace: false, hesitations: false, idle_glances: false });
    travelTick(bot, { yaw: Math.PI });
    assert.equal(bot.humanizer._state.drive.active, true);
    bot.humanizer.setEnabled(false);
    assert.equal(bot.humanizer._state.drive.active, false);
    bot.lookCalls.length = 0;
    travelTick(bot, { yaw: 0.9 });
    assert.equal(bot.lookCalls.length, 1);
    assert.ok(Math.abs(bot.lookCalls[0][0] - 0.9) < 1e-9);
});

test('arrival resets drive state and schedules an idle cooldown', () => {
    const bot = makeBot();
    travelTick(bot, { yaw: Math.PI });
    assert.equal(bot.humanizer._state.drive.active, true);
    stopTravel(bot);
    assert.equal(bot.humanizer._state.drive.active, false);
    assert.equal(bot.humanizer._state.gaze.active, false);
});
