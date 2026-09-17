/**
 * expedition.js — preparation before leaving base.
 * (GO list: bring appropriate tools before leaving, equipment preparation,
 * environmental survival planner.)
 *
 * Before a trip (mining, exploring, generic errand) the bot checks a
 * checklist against what it actually carries, tops up what it can craft
 * (torches), and reports what is missing. The environment planner layers
 * biome/weather/night context on top so advice is situational, not canned.
 *
 * Everything reads server-reported inventory/environment; never throws.
 */

import * as world from '../library/world.js';

/** Checklist tiers: what a trip of a given kind should carry. */
export const EXPEDITION_KITS = {
    generic: [
        { item: 'food_any', need: 6 },
        { item: 'torch', need: 8 },
        { item: 'pickaxe_any', need: 1 },
        { item: 'sword_any', need: 1 }
    ],
    mining: [
        { item: 'food_any', need: 8 },
        { item: 'torch', need: 16 },
        { item: 'pickaxe_any', need: 2 },
        { item: 'sword_any', need: 1 },
        { item: 'cobblestone', need: 16 },
        { item: 'ladder', need: 8 }
    ],
    exploring: [
        { item: 'food_any', need: 10 },
        { item: 'torch', need: 12 },
        { item: 'sword_any', need: 1 },
        { item: 'shield', need: 1 }
    ],
    caving: [
        { item: 'food_any', need: 8 },
        { item: 'torch', need: 24 },
        { item: 'pickaxe_any', need: 2 },
        { item: 'sword_any', need: 1 },
        { item: 'cobblestone', need: 32 },
        { item: 'water_bucket', need: 1 }
    ]
};

const PICKAXES = ['wooden_pickaxe', 'stone_pickaxe', 'iron_pickaxe', 'golden_pickaxe', 'diamond_pickaxe', 'netherite_pickaxe'];
const SWORDS = ['wooden_sword', 'stone_sword', 'iron_sword', 'golden_sword', 'diamond_sword', 'netherite_sword'];
const FOODS = ['bread', 'cooked_beef', 'cooked_porkchop', 'cooked_chicken', 'cooked_mutton', 'cooked_cod', 'cooked_salmon',
    'golden_carrot', 'baked_potato', 'apple', 'golden_apple', 'carrot', 'potato', 'melon_slice', 'sweet_berries',
    'mushroom_stew', 'beetroot_soup', 'rabbit_stew', 'cookie', 'pumpkin_pie', 'dried_kelp', 'honey_bottle'];

/** Count a checklist item against inventory counts. */
export function kitCount(counts, item) {
    if (item === 'food_any') return FOODS.reduce((n, f) => n + (counts[f] ?? 0), 0);
    if (item === 'pickaxe_any') return PICKAXES.reduce((n, f) => n + (counts[f] ?? 0), 0);
    if (item === 'sword_any') return SWORDS.reduce((n, f) => n + (counts[f] ?? 0), 0);
    return counts[item] ?? 0;
}

/**
 * Compute the expedition checklist vs. what is carried.
 * @returns {Array<{item, need, have, missing}>}
 */
export function expeditionChecklist(bot, { kind = 'generic' } = {}) {
    const kit = EXPEDITION_KITS[kind] ?? EXPEDITION_KITS.generic;
    let counts = {};
    try { counts = world.getInventoryCounts(bot); } catch { counts = {}; }
    return kit.map(({ item, need }) => {
        const have = kitCount(counts, item);
        return { item, need, have, missing: Math.max(0, need - have) };
    });
}

/**
 * Prepare for an expedition: craft what we can (torches), equip a pickaxe
 * for mining trips, and report the rest. Never throws.
 * @returns {Promise<string>} human-readable summary
 */
export async function prepareExpedition(agent, { kind = 'generic' } = {}) {
    const bot = agent?.bot;
    if (!bot) return 'expedition: no bot';
    const checklist = expeditionChecklist(bot, { kind });
    const notes = [];
    // top up torches when materials allow — the one universally craftable gap
    const torchGap = checklist.find(c => c.item === 'torch' && c.missing > 0);
    if (torchGap) {
        try {
            const skills = await import('../library/skills.js');
            const crafted = await skills.craftRecipe(bot, 'torch', Math.min(16, torchGap.missing));
            if (crafted) notes.push(`crafted torches`);
        } catch { /* crafting is optional */ }
    }
    // mining trips: hold a pickaxe in hand when we have one
    if (kind === 'mining' || kind === 'caving') {
        try {
            const counts = world.getInventoryCounts(bot);
            const pick = [...PICKAXES].reverse().find(p => (counts[p] ?? 0) > 0);
            if (pick) {
                const slot = (bot.inventory?.slots ?? []).find(s => s && s.name === pick);
                if (slot) await bot.equip?.(slot, 'hand');
                notes.push(`holding ${pick}`);
            }
        } catch { /* equipping is optional */ }
    }
    const after = expeditionChecklist(bot, { kind });
    const missing = after.filter(c => c.missing > 0);
    let summary = `expedition (${kind}): `;
    if (!missing.length) summary += 'kit complete.';
    else summary += `missing ${missing.map(c => `${c.missing}x ${c.item}`).join(', ')}.`;
    if (notes.length) summary += ` ${notes.join('; ')}.`;
    return summary;
}

/**
 * Environmental survival planner: situational advice from biome, weather,
 * time of day, and the danger summary. Pure given inputs; testable.
 * @param {object} ctx { biome, raining, thundering, isNight, underground, light, riskLevel, dimension }
 * @returns {Array<string>} advice lines (may be empty)
 */
export function planForEnvironment(ctx = {}) {
    const advice = [];
    if (ctx.dimension === 'the_nether') advice.push('Nether: carry fire resistance if possible, watch for lava seas, keep portals noted.');
    if (ctx.isNight && !ctx.underground) advice.push('Night above ground: hostiles spawn — light up or finish up soon.');
    if (ctx.underground && (ctx.light ?? 15) <= 7) advice.push('Dark underground: place torches to stop spawns.');
    if (ctx.thundering) advice.push('Thunderstorm: lightning can start fires; avoid open high ground.');
    if (ctx.raining) advice.push('Rain: visibility is lower and water fills trenches.');
    const coldBiomes = ['snowy', 'frozen', 'ice', 'cold', 'grove', 'peaks'];
    if (ctx.biome && coldBiomes.some(b => String(ctx.biome).toLowerCase().includes(b))) {
        advice.push('Cold biome: water freezes — carry food, powder snow is a hazard.');
    }
    const desertBiomes = ['desert', 'badlands', 'savanna'];
    if (ctx.biome && desertBiomes.some(b => String(ctx.biome).toLowerCase().includes(b))) {
        advice.push('Dry biome: no rain, but husks at night and little natural food.');
    }
    if (ctx.riskLevel === 'high' || ctx.riskLevel === 'overwhelm') advice.push('Danger nearby: consider sheltering or arming up before working.');
    return advice;
}

/** Gather environment context for planForEnvironment from a live bot. */
export function environmentContext(bot) {
    const ctx = { biome: null, raining: false, thundering: false, isNight: false, underground: false, light: null, dimension: null };
    try {
        if (typeof bot.rainState === 'number') ctx.raining = bot.rainState > 0;
        if (typeof bot.thunderState === 'number') ctx.thundering = bot.thunderState > 0;
        if (typeof bot.time === 'number') ctx.isNight = bot.time >= 13000 && bot.time < 23000;
        ctx.dimension = bot.game?.dimension ?? null;
        const pos = bot.entity?.position;
        if (pos) {
            try { ctx.biome = bot.blockAt?.(pos, false) ? bot.world?.getBiome?.(pos) ?? null : null; } catch { ctx.biome = null; }
            try {
                const skyLight = bot.lightAt?.(pos);
                if (skyLight != null && typeof skyLight === 'number' && skyLight >= 14 && Math.floor(pos.y) < 63) {
                    ctx.underground = false;
                }
            } catch { /* optional */ }
            try {
                ctx.light = bot.lightLevelAt?.(Math.floor(pos.x), Math.floor(pos.y), Math.floor(pos.z)) ?? null;
            } catch { ctx.light = null; }
        }
    } catch { /* environment context is best-effort */ }
    return ctx;
}
