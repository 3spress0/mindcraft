/**
 * exploration.js — frontier-style autonomous exploration (GO list:
 * Navigation > exploration, Humanlike > exploration patterns groundwork).
 *
 * The bot keeps a persistent record of chunks it has stood in, then picks
 * frontier goals on an expanding ring around its origin, preferring
 * directions with no recorded visits. Direction choices come from the
 * seeded humanlike rng, so exploration is varied but reproducible.
 */

import fs from 'fs';
import path from 'path';
import pf from 'mineflayer-pathfinder';
import settings from '../../../settings.js';
import { createRng } from '../humanlike/rng.js';
import { gotoGoal } from '../baritone/baritone.js';
import { scanHazards } from './hazards.js';
import { avoidZonesFromHazards, inAvoidZone } from './route_choice.js';
import { noteCavesIfNear } from './caves.js';
import { notePortalsIfNear } from './portals.js';
import { noteNotableBlocks } from '../sensors/notables.js';
import * as world from '../library/world.js';

export const CHUNK_SIZE = 16;
export const MAX_VISITED = 2048;
export const MAX_RING = 12;

export function chunkKey(x, z) {
    return `${Math.floor(x / CHUNK_SIZE)},${Math.floor(z / CHUNK_SIZE)}`;
}

export const MAX_CHUNK_NOTES = 512;

export class ExplorationState {
    constructor({ origin = null, visited = new Map(), legs = 0, ring = 1, notes = new Map() } = {}) {
        this.origin = origin;
        this.visited = visited; // chunkKey -> lastSeen timestamp
        this.legs = legs;
        this.ring = ring;
        // Persistent chunk knowledge (GO list): small per-chunk notes
        // (biome, remarks) recorded while standing in them.
        this.notes = notes;
    }

    /** Note something about the chunk at (x, z), e.g. its biome. */
    setChunkNote(x, z, note) {
        if (!note) return;
        this.notes.set(chunkKey(x, z), String(note).slice(0, 48));
        if (this.notes.size > MAX_CHUNK_NOTES) {
            // drop oldest-inserted
            const first = this.notes.keys().next().value;
            this.notes.delete(first);
        }
    }

    chunkNote(x, z) {
        return this.notes.get(chunkKey(x, z)) ?? null;
    }

    get visitedCount() { return this.visited.size; }

    markVisited(pos, now = Date.now()) {
        if (!pos || typeof pos.x !== 'number') return;
        this.visited.set(chunkKey(pos.x, pos.z), now);
        this.prune();
    }

    isVisited(x, z) {
        return this.visited.has(chunkKey(x, z));
    }

    prune(cap = MAX_VISITED) {
        if (this.visited.size <= cap) return;
        const ordered = [...this.visited.entries()].sort((a, b) => a[1] - b[1]);
        for (let i = 0; i < this.visited.size - cap; i++) this.visited.delete(ordered[i][0]);
    }

    toJSON() {
        return {
            version: 1,
            origin: this.origin,
            legs: this.legs,
            ring: this.ring,
            visited: Object.fromEntries(this.visited),
            notes: Object.fromEntries(this.notes)
        };
    }

    static fromJSON(data) {
        const visited = new Map(Object.entries(data?.visited ?? {}));
        const notes = new Map(Object.entries(data?.notes ?? {}));
        return new ExplorationState({
            origin: data?.origin ?? null,
            visited,
            legs: data?.legs ?? 0,
            ring: Math.max(1, Math.min(MAX_RING, data?.ring ?? 1)),
            notes
        });
    }

    static filePath(botName, dir = './bots') {
        return path.join(dir, botName, 'exploration.json');
    }

    static load(botName, dir = './bots') {
        try {
            const fp = ExplorationState.filePath(botName, dir);
            if (fs.existsSync(fp)) return ExplorationState.fromJSON(JSON.parse(fs.readFileSync(fp, 'utf8')));
        } catch (err) {
            console.error(`[exploration] load failed: ${err.message}`);
        }
        return new ExplorationState();
    }

    persist(botName, dir = './bots') {
        try {
            const fp = ExplorationState.filePath(botName, dir);
            fs.mkdirSync(path.dirname(fp), { recursive: true });
            const tmp = `${fp}.${process.pid}.tmp`;
            fs.writeFileSync(tmp, JSON.stringify(this.toJSON()));
            fs.renameSync(tmp, fp);
            return true;
        } catch (err) {
            console.error(`[exploration] persist failed: ${err.message}`);
            return false;
        }
    }
}

/**
 * Choose the next frontier goal: sample 8 jittered directions on the current
 * ring (ring * 16 blocks out) and take the first pointing at unvisited
 * chunks; expand the ring when the current one is exhausted.
 * Pure given (state, rng) — no bot access, fully testable.
 * @returns {{x:number, z:number, ring:number, angleDeg:number}}
 */
export function nextFrontierGoal(state, { rng, ringOverride = null, avoid = [] } = {}) {
    const _rng = rng || createRng('frontier');
    const origin = state.origin ?? { x: 0, z: 0 };
    const candidates = 8;
    let ring = ringOverride ?? state.ring;
    let avoidedFallback = null; // best unvisited candidate that sits in an avoid-zone

    for (let expand = 0; expand < MAX_RING; expand++) {
        const r = Math.min(MAX_RING, ring + expand) * CHUNK_SIZE;
        for (let i = 0; i < candidates; i++) {
            const angleDeg = i * (360 / candidates) + _rng.range(-14, 14);
            const angle = angleDeg * Math.PI / 180;
            const x = Math.round(origin.x + Math.cos(angle) * r);
            const z = Math.round(origin.z + Math.sin(angle) * r);
            if (state.isVisited(x, z)) continue;
            const goal = { x, z, ring: Math.min(MAX_RING, ring + expand), angleDeg };
            // risk-aware: steer around avoid-zones when any safe option exists
            if (avoid?.length && inAvoidZone(x, z, avoid)) {
                avoidedFallback ??= goal;
                continue;
            }
            if (ringOverride == null && ring + expand !== state.ring) state.ring = Math.min(MAX_RING, ring + expand);
            return goal;
        }
        // every candidate on this ring was visited -> expand
        if (ringOverride != null) break;
    }

    // everything reachable is either visited or avoided: take the avoided
    // candidate rather than giving up exploration entirely
    if (avoidedFallback) {
        if (ringOverride == null && avoidedFallback.ring !== state.ring) state.ring = avoidedFallback.ring;
        return avoidedFallback;
    }

    // fully explored fallback: a random bearing at max ring
    const angleDeg = _rng.range(0, 360);
    const angle = angleDeg * Math.PI / 180;
    const r = MAX_RING * CHUNK_SIZE;
    return {
        x: Math.round(origin.x + Math.cos(angle) * r),
        z: Math.round(origin.z + Math.sin(angle) * r),
        ring: MAX_RING,
        angleDeg
    };
}

/**
 * Exploration profiles (GO list: exploration profiles / conservative vs
 * aggressive exploration): how far and how boldly the bot ranges out.
 */
export const EXPLORATION_PROFILES = {
    cautious: { legMultiplier: 0.6, ringCap: 4, hazardRadius: 20, pauseChance: 0.35 },
    standard: { legMultiplier: 1.0, ringCap: MAX_RING, hazardRadius: 16, pauseChance: 0.2 },
    bold: { legMultiplier: 1.5, ringCap: MAX_RING, hazardRadius: 12, pauseChance: 0.1 }
};

export function explorationSettings() {
    const block = settings.navigation?.exploration ?? {};
    const preset = EXPLORATION_PROFILES[block.exploration_profile] ?? EXPLORATION_PROFILES.standard;
    return {
        defaultLegs: Math.max(1, Math.min(8, Math.round((block.default_legs ?? 3) * preset.legMultiplier))),
        maxRing: Math.max(1, Math.min(preset.ringCap, block.max_ring ?? preset.ringCap)),
        profile: block.profile ?? 'legit',
        explorationProfile: block.exploration_profile ?? 'standard',
        hazardRadius: preset.hazardRadius,
        pauseChance: preset.pauseChance
    };
}

/** Attach (or create) the per-agent exploration state. */
export function getExplorationState(agent) {
    if (agent._exploration_state) return agent._exploration_state;
    const name = agent?.bot?.username || agent?.name || 'bot';
    const state = ExplorationState.load(name);
    if (!state.origin && agent?.bot?.entity?.position) {
        const p = agent.bot.entity.position;
        state.origin = { x: Math.round(p.x), z: Math.round(p.z) };
    }
    agent._exploration_state = state;
    return state;
}

/**
 * Explore for `legs` legs: each leg walks to a frontier goal with the legit
 * (or given) profile and records the chunks reached. Stops cleanly on
 * interruption. Returns a human-readable summary.
 */
export async function explore(agent, opts = {}) {
    const bot = agent?.bot;
    const pos = bot?.entity?.position;
    if (!pos) return 'Cannot explore: position unknown.';

    const cfg = explorationSettings();
    const legs = Math.max(1, Math.min(8, opts.legs ?? cfg.defaultLegs));
    const state = getExplorationState(agent);
    state.markVisited(pos);
    const rng = agent.personality?.rng ?? createRng(bot.username || 'explorer');

    const chunksBefore = state.visitedCount;
    let completed = 0;
    let failed = null;

    // risk-aware exploration: steer frontier goals around local hazards
    let avoid = [];
    if (opts.avoidHazards !== false) {
        try { avoid = avoidZonesFromHazards(scanHazards(bot, { radius: cfg.hazardRadius })); }
        catch { avoid = []; }
    }

    for (let i = 0; i < legs; i++) {
        if (bot.interrupt_code) break;
        const target = nextFrontierGoal(state, { rng, ringOverride: opts.ring ?? null, avoid });
        const here = bot.entity.position;
        const goal = new pf.goals.GoalNear(target.x, Math.round(here.y), target.z, 4);
        try {
            await gotoGoal(bot, goal, { profile: opts.profile ?? cfg.profile });
        } catch (err) {
            failed = `leg ${i + 1}: ${err.message}`;
            break;
        }
        if (bot.interrupt_code) { state.markVisited(bot.entity.position); completed++; break; }
        state.markVisited(bot.entity.position);
        state.legs += 1;
        completed += 1;
        state.persist(bot.username || agent?.name || 'bot');
        // what did this leg pass? remember cave openings and portals (cheap,
        // best-effort — the mental map deduplicates by name/proximity)
        try { noteCavesIfNear(agent, { radius: 16, maxOpenings: 2 }); } catch { /* optional */ }
        try { notePortalsIfNear(agent, { radius: 16 }); } catch { /* optional */ }
        // persistent block knowledge: note ores/stations we passed
        try { noteNotableBlocks(agent, { radius: 14 }); } catch { /* optional */ }
        // persistent chunk knowledge: remember this chunk's biome
        try {
            const biome = world.getBiomeName(bot);
            if (biome && biome !== 'unknown') {
                const p = bot.entity.position;
                state.setChunkNote(p.x, p.z, biome);
            }
        } catch { /* optional */ }
    }

    const newChunks = state.visitedCount - chunksBefore;
    let summary = `Explored ${completed}/${legs} leg(s); ${newChunks} new chunk(s) recorded (total ${state.visitedCount}); frontier ring ${state.ring}.`;
    if (failed) summary += ` Stopped: ${failed}.`;
    else if (bot.interrupt_code) summary += ' Interrupted.';
    return summary;
}

/**
 * Wander behavior + humanlike exploration patterns (GO list: wander
 * behavior, humanlike exploration patterns). Unlike frontier exploration,
 * wandering is a local stroll: the bot keeps a heading and bends it gently
 * (angular persistence, seeded), walks short legs, occasionally pauses to
 * look around, and refuses targets with lethal fall risk. It covers ground
 * near base believably instead of beelining to frontier points.
 */
export const WANDER_LEG_MIN = 12;
export const WANDER_LEG_MAX = 28;

/**
 * Pick the next wander target given the current heading.
 * Pure given (pos, headingDeg, rng) — testable.
 * @returns {{x, z, headingDeg, paused}}
 */
export function nextWanderGoal(pos, headingDeg, rng, { legMin = WANDER_LEG_MIN, legMax = WANDER_LEG_MAX, pauseChance = 0.2 } = {}) {
    const _rng = rng || createRng('wander');
    // gentle bend: ±55°, with a small chance of a big turn ("hmm, that way")
    let turn = _rng.range(-55, 55);
    if (_rng.chance(0.15)) turn += _rng.chance(0.5) ? 120 : -120;
    const heading = ((headingDeg + turn) % 360 + 360) % 360;
    const dist = _rng.range(legMin, legMax);
    const rad = heading * Math.PI / 180;
    return {
        x: Math.round(pos.x + Math.cos(rad) * dist),
        z: Math.round(pos.z + Math.sin(rad) * dist),
        headingDeg: heading,
        paused: _rng.chance(pauseChance)
    };
}

/**
 * Wander for a few legs around the current area. Records visited chunks,
 * skips lethal-drop targets, and stops cleanly on interruption.
 * @returns {Promise<string>} summary
 */
export async function wander(agent, opts = {}) {
    const bot = agent?.bot;
    const pos = bot?.entity?.position;
    if (!pos) return 'Cannot wander: position unknown.';

    const legs = Math.max(1, Math.min(8, opts.legs ?? 3));
    const rng = agent.personality?.rng ?? createRng(`${bot.username ?? 'wanderer'}:wander`);
    const state = getExplorationState(agent);
    bot._wander_heading = bot._wander_heading ?? rng.range(0, 360);

    let completed = 0;
    let pauses = 0;
    let failed = null;
    for (let i = 0; i < legs; i++) {
        if (bot.interrupt_code) break;
        const here = bot.entity.position;
        const goal = nextWanderGoal(here, bot._wander_heading, rng);
        bot._wander_heading = goal.headingDeg;
        if (goal.paused) {
            pauses++;
            // a human pause: stand still a moment and look around
            try {
                const skills = await import('../library/skills.js');
                await new Promise(r => setTimeout(r, 400 + Math.floor(rng.range(0, 900))));
                if (typeof bot.look === 'function') {
                    await bot.look(bot.entity.yaw + rng.range(-1.2, 1.2), bot.entity.pitch, true);
                }
            } catch { /* pausing is decorative */ }
        }
        // fall-risk check: don't wander off a lethal cliff
        try {
            const { fallRiskAt } = await import('./hazards.js');
            const risk = fallRiskAt(bot, { x: goal.x, y: here.y, z: goal.z });
            if (risk.risk === 'lethal') {
                bot._wander_heading = (bot._wander_heading + 90) % 360;
                continue;
            }
        } catch { /* fall check is best-effort */ }
        const nav = new pf.goals.GoalNear(goal.x, Math.round(here.y), goal.z, 3);
        try {
            await gotoGoal(bot, nav, { profile: opts.profile ?? 'legit' });
        } catch (err) {
            failed = `leg ${i + 1}: ${err.message}`;
            break;
        }
        if (bot.interrupt_code) { completed++; break; }
        state.markVisited(bot.entity.position);
        completed++;
    }
    state.persist(bot.username || agent?.name || 'bot');
    let summary = `Wandered ${completed}/${legs} leg(s)${pauses ? `, paused ${pauses}x` : ''}.`;
    if (failed) summary += ` Stopped: ${failed}.`;
    else if (bot.interrupt_code) summary += ' Interrupted.';
    return summary;
}
