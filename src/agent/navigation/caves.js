/**
 * caves.js — cave awareness (GO list: Navigation > cave awareness).
 *
 * Caves are found the legit way: the server already tells the bot where
 * air and darkness are. This module detects dark surface openings nearby,
 * remembers them as 'cave' POIs in the mental map (so the LLM can read them
 * back with !pois/!memory), and knows when the bot itself is underground.
 */

import { Vec3 } from 'vec3';
import * as world from '../library/world.js';

/** Light level at or below which an opening counts as "dark inside". */
export const DARK_THRESHOLD = 4;

/** Light provider with a safe fallback (server-reported light). */
export function lightLevelAt(bot, pos) {
    try { return bot?.lightAt?.(pos) ?? 15; } catch { return 15; }
}

/**
 * Whether the bot is standing underground: no skylight over its head and
 * solid ground above that. Cheap, server-reported only.
 */
export function isUnderground(bot) {
    try {
        const pos = bot?.entity?.position;
        if (!pos) return false;
        const head = new Vec3(Math.floor(pos.x), Math.floor(pos.y) + 2, Math.floor(pos.z));
        const block = bot.blockAt?.(head);
        const sky = block?.skyLight;
        if (typeof sky === 'number') return sky <= 0;
        // fallback: total light + a roof overhead implies underground
        return lightLevelAt(bot, head) <= 3 && !!block && block.name !== 'air';
    } catch { return false; }
}

/**
 * Scan for dark cave openings near the bot: an air block with solid ground
 * beneath, open above, and darkness inside. Deterministic given the world.
 * @returns {Array<{x, y, z, light}>} nearest first, bounded
 */
export function scanCaveOpenings(bot, { radius = 24, maxOpenings = 8 } = {}) {
    const out = [];
    const self = bot?.entity?.position;
    if (!self) return out;
    let airs = [];
    try { airs = bot.findBlocks?.({ matching: (id) => id === 0, maxDistance: radius, count: 512 }) ?? []; }
    catch { return out; }
    for (const pos of airs) {
        if (out.length >= maxOpenings) break;
        try {
            const below = bot.blockAt?.(new Vec3(pos.x, pos.y - 1, pos.z));
            if (!below || below.name === 'air' || below.name === 'lava' || below.name === 'water') continue;
            const above = bot.blockAt?.(new Vec3(pos.x, pos.y + 1, pos.z));
            if (!above || above.name !== 'air') continue; // want a walk-in opening
            const light = lightLevelAt(bot, pos);
            if (light > DARK_THRESHOLD) continue;
            out.push({ x: pos.x, y: pos.y, z: pos.z, light });
        } catch { /* unreadable column */ }
    }
    out.sort((a, b) => {
        const da = (a.x - self.x) ** 2 + (a.z - self.z) ** 2;
        const db = (b.x - self.x) ** 2 + (b.z - self.z) ** 2;
        return da - db;
    });
    return out;
}

function caveName(pos) {
    return `cave-${Math.round(pos.x)}-${Math.round(pos.z)}`;
}

/**
 * Remember any cave openings nearby as mental-map POIs (+ world-model
 * location facts). Returns how many NEW caves were noted this call.
 */
export function noteCavesIfNear(agent, { radius = 24, maxOpenings = 4 } = {}) {
    const bot = agent?.bot;
    if (!bot) return 0;
    const openings = scanCaveOpenings(bot, { radius, maxOpenings });
    let noted = 0;
    for (const o of openings) {
        try {
            const res = agent._mental_map?.note?.(
                { x: o.x, y: o.y, z: o.z },
                { name: caveName(o), type: 'cave', source: 'observed', notes: `dark opening (light ${o.light})` }
            );
            if (res?.created) noted++;
        } catch { /* mental map optional */ }
        try {
            agent.world_model?.record?.('location', {
                key: `cave:${Math.round(o.x)},${Math.round(o.z)}`,
                name: caveName(o),
                kind: 'cave',
                pos: { x: Math.round(o.x), y: Math.round(o.y), z: Math.round(o.z) },
                source: 'observed',
            });
        } catch { /* world model optional */ }
    }
    return noted;
}

/** List remembered caves (mental map first, world model as fallback). */
export function listCaves(agent) {
    const out = [];
    try {
        const pois = agent?._mental_map?.list?.({ type: 'cave' }) ?? [];
        for (const p of pois) out.push({ name: p.name, x: p.x, y: p.y, z: p.z });
    } catch { /* optional */ }
    if (out.length) return out;
    try {
        const facts = agent?.world_model?.facts?.location ?? [];
        for (const f of facts) {
            if (typeof f?.key === 'string' && f.key.startsWith('cave:') && f.pos) {
                out.push({ name: f.name ?? f.key, ...f.pos });
            }
        }
    } catch { /* optional */ }
    return out;
}

/** Blocks that make a cave mouth dangerous to walk into. */
export const CAVE_DANGERS = ['lava', 'fire', 'magma_block'];

/**
 * Safety check around a cave opening: how much lava/fire is close, and how
 * dark the mouth is. Pure given the server-reported world.
 * @returns {{lavaNear: number, dangers: string[], lightLevel: number, safe: boolean}}
 */
export function assessCaveSafety(bot, pos, { radius = 8 } = {}) {
    let dangers = [];
    try { dangers = bot.findBlocks?.({ matching: () => true, maxDistance: radius, count: 128 }) ?? []; }
    catch { dangers = []; }
    const hazards = [];
    for (const p of dangers) {
        try {
            const b = bot.blockAt?.(p);
            if (b?.name && CAVE_DANGERS.includes(b.name)) {
                const d = Math.hypot(p.x - pos.x, p.y - pos.y, p.z - pos.z);
                if (d <= radius) hazards.push(b.name);
            }
        } catch { /* skip */ }
    }
    const lightLevel = lightLevelAt(bot, pos);
    return {
        lavaNear: hazards.filter(h => h === 'lava').length,
        dangers: hazards,
        lightLevel,
        safe: hazards.length === 0
    };
}

/**
 * Guided cave entry (GO list: cave navigation groundwork): look up the cave
 * by name, check the mouth for lava/fire, drop a torch at the entrance when
 * one is carried, then walk in with the current movement profile.
 * @returns {Promise<string>} human-readable summary
 */
export async function enterCave(agent, name, { torch = true } = {}) {
    const bot = agent?.bot;
    if (!bot) return 'cave: no bot';
    const skills = await import('../library/skills.js');
    const caves = listCaves(agent);
    const clean = String(name ?? '').trim().toLowerCase();
    const cave = caves.find(c => String(c.name).toLowerCase() === clean)
        ?? caves.find(c => String(c.name).toLowerCase().includes(clean));
    if (!cave) return `cave: I don't remember a cave called "${name}". See !caves.`;

    const safety = assessCaveSafety(bot, cave, {});
    if (!safety.safe) {
        return `cave: "${cave.name}" mouth looks dangerous (${safety.dangers.join(', ')} within 8 blocks) — not entering.`;
    }

    const steps = [`safety ok (light ${safety.lightLevel})`];
    if (torch) {
        try {
            const counts = world.getInventoryCounts(bot);
            if ((counts.torch ?? 0) > 0) {
                const ok = await skills.equip(bot, 'torch');
                if (ok) {
                    const floor = bot.blockAt?.(new Vec3(Math.round(cave.x), Math.round(cave.y) - 1, Math.round(cave.z)));
                    if (floor && floor.name !== 'air') await bot.placeBlock(floor, new Vec3(0, 1, 0));
                    steps.push('torch placed at the entrance');
                }
            }
        } catch { steps.push('torch placement skipped'); }
    }
    try {
        await skills.goToPosition(bot, cave.x, cave.y, cave.z, 2);
        steps.push('at the cave mouth');
    } catch {
        return `cave: could not reach "${cave.name}" right now`;
    }
    return `cave: entered "${cave.name}" — ${steps.join(', ')}`;
}
