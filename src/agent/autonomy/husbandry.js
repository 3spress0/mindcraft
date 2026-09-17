/**
 * husbandry.js — animal feeding & breeding at the base (GO list: Farming >
 * animal feeding / breeding).
 *
 * Minecraft has one real "feed" interaction: right-clicking two adult animals
 * of the same species with their breeding food. So this module closes the
 * food loop on the animal side — the bot carries breeding food, finds adult
 * animals nearby, and pairs them up, bounded per run and interrupt-aware.
 *
 * Legit by construction: only server-visible entities (bot.entities) and the
 * same approach/equip/interact calls a player makes.
 */

import * as world from '../library/world.js';

/** Species the bot can breed, with the foods that trigger love mode. */
export const BREEDABLES = {
    cow: { foods: ['wheat'] },
    mooshroom: { foods: ['wheat'] },
    sheep: { foods: ['wheat'] },
    pig: { foods: ['carrot'] },
    chicken: { foods: ['wheat_seeds', 'beetroot_seeds'] }
};

export const BREEDABLE_NAMES = Object.keys(BREEDABLES);

/** True when the entity is readable as a baby (ageable metadata bit). */
export function isBaby(entity) {
    try {
        const v = entity?.metadata?.[16];
        if (typeof v === 'boolean') return v;
    } catch { /* unreadable -> assume adult */ }
    return false;
}

/**
 * Scan for adult breedable animals within radius.
 * @returns {Array<{entity, name, dist}>} nearest first
 */
export function scanAnimals(bot, { radius = 16 } = {}) {
    const out = [];
    const self = bot?.entity?.position;
    if (!self || typeof self.distanceTo !== 'function') return out;
    for (const entity of Object.values(bot?.entities ?? {})) {
        if (!entity?.name || !BREEDABLE_NAMES.includes(entity.name)) continue;
        if (!entity.position) continue;
        if (isBaby(entity)) continue;
        const dist = self.distanceTo(entity.position);
        if (dist > radius) continue;
        out.push({ entity, name: entity.name, dist });
    }
    out.sort((a, b) => a.dist - b.dist);
    return out;
}

/**
 * Which breeding runs are possible right now: for each species with >=2
 * adults nearby, how many pairs the carried food allows.
 * @returns {Array<{species, food, animals, pairs, foodCount}>}
 */
export function planBreeding(bot, { radius = 16 } = {}) {
    const counts = world.getInventoryCounts(bot);
    const animals = scanAnimals(bot, { radius });
    const plans = [];
    for (const [species, def] of Object.entries(BREEDABLES)) {
        const group = animals.filter(a => a.name === species);
        if (group.length < 2) continue;
        let food = null;
        let foodCount = 0;
        for (const f of def.foods) {
            if ((counts[f] ?? 0) > foodCount) { food = f; foodCount = counts[f]; }
        }
        if (!food || foodCount < 2) continue;
        const pairs = Math.min(Math.floor(group.length / 2), Math.floor(foodCount / 2));
        if (pairs < 1) continue;
        plans.push({ species, food, animals: group, pairs, foodCount });
    }
    // most pairs first — the biggest payoff for the walk
    plans.sort((a, b) => b.pairs - a.pairs);
    return plans;
}

/**
 * Execute breeding runs (bounded, interrupt-aware).
 * @returns {Promise<number>} pairs actually fed
 */
export async function executeBreeding(bot, { radius = 16, maxPairs = 2 } = {}) {
    const plans = planBreeding(bot, { radius });
    if (!plans.length) return 0;
    const skills = await import('../library/skills.js');

    let bred = 0;
    for (const plan of plans) {
        if (bred >= maxPairs || bot.interrupt_code) break;
        try {
            const ok = await skills.equip(bot, plan.food);
            if (!ok) continue;
        } catch { continue; }
        const animals = plan.animals;
        // walk pairs: animal[0]+animal[1], then animal[2]+animal[3], ...
        for (let i = 0; i + 1 < animals.length && bred < maxPairs; i += 2) {
            if (bot.interrupt_code) break;
            try {
                const a = animals[i];
                const b = animals[i + 1];
                await skills.goToPosition(bot, a.entity.position.x, a.entity.position.y, a.entity.position.z, 2);
                if (bot.interrupt_code) break;
                await bot.activateEntity(a.entity);
                await skills.goToPosition(bot, b.entity.position.x, b.entity.position.y, b.entity.position.z, 2);
                if (bot.interrupt_code) break;
                await bot.activateEntity(b.entity);
                bred++;
            } catch { /* these two failed; try the next pair */ }
        }
    }
    return bred;
}

/**
 * Husbandry executor for the autonomy loop.
 */
export async function executeHusbandry(agent, need, cfg = {}) {
    const bot = agent?.bot;
    if (!bot) return 'husbandry: no bot';
    const radius = Math.max(8, Math.min(32, cfg.breed_radius ?? 16));
    const maxPairs = Math.max(1, Math.min(8, cfg.max_breed_pairs ?? 2));
    try {
        const plans = planBreeding(bot, { radius });
        if (!plans.length) return 'husbandry: no breedable pairs right now';
        const bred = await executeBreeding(bot, { radius, maxPairs });
        const species = [...new Set(plans.map(p => p.species))].join(', ');
        return bred > 0
            ? `husbandry: bred ${bred} pair(s) of ${species}`
            : `husbandry: could not feed the ${species}`;
    } catch (e) {
        return `husbandry failed: ${e.message}`;
    }
}
