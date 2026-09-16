/**
 * farming.js — autonomous crop tending (GO list: autonomous farming).
 * Closes the food-reserve loop: harvest mature crops for wheat/carrots/
 * potatoes/beetroots, and plant seeds on existing farmland so reserves can
 * be restocked without player help.
 *
 * Legit by construction: only blocks the server reports (findBlocks/blockAt)
 * and normal dig/equip/place interactions — same calls a player makes.
 */

import { Vec3 } from 'vec3';
import * as world from '../library/world.js';

/** Crop table: block name, matching seed item, maturity age. */
export const CROPS = {
    wheat: { block: 'wheat', seed: 'wheat_seeds', maxAge: 7, yield: 'wheat' },
    carrots: { block: 'carrots', seed: 'carrot', maxAge: 7, yield: 'carrot' },
    potatoes: { block: 'potatoes', seed: 'potato', maxAge: 7, yield: 'potato' },
    beetroots: { block: 'beetroots', seed: 'beetroot_seeds', maxAge: 3, yield: 'beetroot' }
};

export const CROP_BLOCKS = Object.values(CROPS).map(c => c.block);

/** Read a crop's growth age resiliently (0..maxAge), or null when unknown. */
export function cropAge(block) {
    try {
        if (typeof block?.getProperty === 'function') {
            const v = block.getProperty('age');
            if (v != null && !Number.isNaN(Number(v))) return Number(v);
        }
        const props = block?.properties ?? block?.getProperties?.() ?? null;
        if (props && props.age != null && !Number.isNaN(Number(props.age))) return Number(props.age);
    } catch { /* unreadable state -> treat as immature */ }
    return null;
}

/**
 * Scan for crops within radius.
 * @returns {{total, mature, crops: Array<{name, block, age, mature, position}>}}
 */
export function scanCrops(bot, { radius = 16, maxScan = 256 } = {}) {
    const out = { total: 0, mature: 0, crops: [] };
    let blocks = [];
    try { blocks = world.getNearestBlocks(bot, CROP_BLOCKS, radius, maxScan) ?? []; }
    catch { blocks = []; }
    for (const block of blocks) {
        const def = Object.values(CROPS).find(c => c.block === block?.name);
        if (!def) continue;
        const age = cropAge(block);
        const mature = age != null && age >= def.maxAge;
        out.total++;
        if (mature) out.mature++;
        out.crops.push({ name: def.block, block, age, mature, position: block.position });
    }
    return out;
}

/**
 * Find tilled farmland with air above (ready to receive seeds).
 * @returns {Array<{position, block}>}
 */
export function scanFarmland(bot, { radius = 16, maxScan = 256 } = {}) {
    const spots = [];
    let blocks = [];
    try { blocks = world.getNearestBlocks(bot, ['farmland'], radius, maxScan) ?? []; }
    catch { blocks = []; }
    for (const block of blocks) {
        try {
            const p = block.position;
            const above = bot.blockAt(new Vec3(p.x, p.y + 1, p.z));
            if (!above || above.name === 'air') spots.push({ position: p, block });
        } catch { /* skip unreadable column */ }
    }
    return spots;
}

/** Seed item name -> crop def (plantable on farmland). */
export function seedToCrop(seedName) {
    return Object.values(CROPS).find(c => c.seed === seedName) ?? null;
}

/** Seeds carried that could be planted right now. */
export function availableSeeds(bot) {
    const counts = world.getInventoryCounts(bot);
    const out = [];
    for (const def of Object.values(CROPS)) {
        const n = counts[def.seed] ?? 0;
        if (n > 0) out.push({ seed: def.seed, crop: def.block, count: n });
    }
    return out;
}

/**
 * Harvest mature crops (bounded, interrupt-aware).
 * @returns {Promise<number>} crops actually broken
 */
export async function harvestCrops(bot, { radius = 16, maxHarvest = 16 } = {}) {
    const skills = await import('../library/skills.js');
    const scan = scanCrops(bot, { radius });
    let harvested = 0;
    for (const crop of scan.crops) {
        if (harvested >= maxHarvest || bot.interrupt_code) break;
        if (!crop.mature || !crop.block) continue;
        try {
            const p = crop.block.position;
            await skills.goToPosition(bot, p.x, p.y, p.z, 2);
            if (bot.interrupt_code) break;
            await bot.dig(crop.block);
            harvested++;
        } catch { /* this plant failed; try the next */ }
    }
    return harvested;
}

/**
 * Plant carried seeds on open farmland (bounded, interrupt-aware).
 * @returns {Promise<number>} seeds planted
 */
export async function plantSeeds(bot, { radius = 16, maxPlants = 24 } = {}) {
    const skills = await import('../library/skills.js');
    const seeds = availableSeeds(bot);
    if (!seeds.length) return 0;
    const spots = scanFarmland(bot, { radius });
    if (!spots.length) return 0;

    let planted = 0;
    let seedIdx = 0;
    for (const spot of spots) {
        if (planted >= maxPlants || bot.interrupt_code) break;
        // advance to a seed type we still carry
        while (seedIdx < seeds.length && seeds[seedIdx].count <= 0) seedIdx++;
        if (seedIdx >= seeds.length) break;
        const seed = seeds[seedIdx];
        try {
            const ok = await skills.equip(bot, seed.seed);
            if (!ok) { seedIdx++; continue; }
            await skills.goToPosition(bot, spot.position.x, spot.position.y, spot.position.z, 3);
            if (bot.interrupt_code) break;
            await bot.placeBlock(spot.block, new Vec3(0, 1, 0));
            seed.count--;
            planted++;
        } catch { /* spot unusable; move on */ }
    }
    return planted;
}

/** Compact snapshot for needs evaluation — cheap enough for the loop. */
export function farmSnapshot(bot, { radius = 16 } = {}) {
    const scan = scanCrops(bot, { radius });
    const seeds = availableSeeds(bot);
    const seedCount = seeds.reduce((n, s) => n + s.count, 0);
    let farmland = 0;
    try { farmland = scanFarmland(bot, { radius }).length; } catch { farmland = 0; }
    return { mature: scan.mature, total: scan.total, seeds: seedCount, farmland };
}

/**
 * Farming executor for the autonomy loop.
 * Priority: harvest what is ready, then plant what can be planted.
 */
export async function executeFarming(agent, need, cfg = {}) {
    const bot = agent?.bot;
    if (!bot) return 'farm: no bot';
    const radius = Math.max(8, Math.min(32, cfg.farm_radius ?? 16));
    const maxHarvest = Math.max(1, Math.min(64, cfg.max_harvest ?? 16));
    const maxPlants = Math.max(1, Math.min(64, cfg.max_plants ?? 24));
    try {
        const scan = scanCrops(bot, { radius });
        if (scan.mature > 0) {
            const harvested = await harvestCrops(bot, { radius, maxHarvest });
            return `farm: harvested ${harvested} mature crop(s)`;
        }
        const seeds = availableSeeds(bot);
        const seedCount = seeds.reduce((n, s) => n + s.count, 0);
        if (seedCount > 0 && scanFarmland(bot, { radius }).length > 0) {
            const planted = await plantSeeds(bot, { radius, maxPlants });
            return `farm: planted ${planted} seed(s)`;
        }
        return 'farm: nothing ready to tend';
    } catch (e) {
        return `farm failed: ${e.message}`;
    }
}
