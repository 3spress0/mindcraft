/**
 * needs.js — pure, deterministic needs evaluation for the autonomous task
 * loop (GO list: long-term autonomy). Given a snapshot of the bot's state,
 * it returns scored needs sorted by urgency. No bot access here — callers
 * build the snapshot, which keeps this fully testable.
 */

export const NEED_KINDS = ['tool_replace', 'inventory_full', 'restock_food', 'restock_torches', 'farm', 'rest', 'maintain_base', 'husbandry', 'gather_resource', 'patrol', 'explore'];

/**
 * Formal priority classes (GO list: task priorities). Needs in a higher
 * class always outrank lower classes regardless of urgency nuance; within a
 * class, urgency breaks ties. survival > upkeep > production > curiosity.
 */
export const PRIORITY_CLASS = { survival: 3, upkeep: 2, production: 1, curiosity: 0 };
export const NEED_PRIORITY = {
    tool_replace: 'survival',
    inventory_full: 'survival',
    rest: 'survival',
    restock_torches: 'upkeep',
    restock_food: 'upkeep',
    maintain_base: 'upkeep',
    farm: 'production',
    husbandry: 'production',
    gather_resource: 'production',
    patrol: 'curiosity',
    explore: 'curiosity'
};
export function priorityValue(kind) {
    return PRIORITY_CLASS[NEED_PRIORITY[kind] ?? 'curiosity'] ?? 0;
}

export function autonomyDefaults() {
    return {
        tool_replace_threshold: 0.15,
        explore_when_idle: true,
        explore_idle_s: 60,
        explore_legs: 2,
        free_slot_alert: 2,
        min_torches: 8,
        min_food: 5,
        max_unload_types: 8,
        farm_radius: 16,
        max_harvest: 16,
        max_plants: 24,
        max_till: 4,
        farm_expand: true,
        breed_radius: 16,
        max_breed_pairs: 2,
        gather_min_logs: 12,
        gather_batch: 8
    };
}

/**
 * Evaluate needs from a state snapshot.
 * @param {object} ctx
 * @param {Array}  [ctx.tools]        toolCondition rows (from durability.listTools)
 * @param {number} [ctx.freeSlots]    free main-inventory slots
 * @param {number} [ctx.idleForMs]    ms since last activity change
 * @param {boolean} [ctx.isNight]
 * @param {boolean} [ctx.hasPendingResume] FSM remembers an interrupted task
 * @param {object} [ctx.inventoryCounts] item name -> count map
 * @param {number} [ctx.foodCount]    total edible items carried
 * @param {object} [cfg] overrides of autonomyDefaults()
 * @returns {Array<{kind, urgency, detail, advisory}>} sorted by urgency desc
 */
export function evaluateNeeds(ctx = {}, cfg = {}) {
    const c = { ...autonomyDefaults(), ...cfg };
    const needs = [];

    // 1. Broken or nearly-dead tools first — they hard-block work.
    const tools = Array.isArray(ctx.tools) ? ctx.tools : [];
    let worst = null;
    for (const t of tools) {
        if (!t || t.pct == null) continue;
        if (t.pct < c.tool_replace_threshold && (!worst || t.pct < worst.pct)) worst = t;
    }
    if (worst) {
        needs.push({
            kind: 'tool_replace',
            urgency: worst.broken ? 0.95 : 0.7,
            detail: worst.name,
            advisory: false,
            info: `${worst.name} at ${Math.round(worst.pct * 100)}% (${worst.remaining}/${worst.maxDurability})`
        });
    }

    // 2. Inventory nearly full -> unload into the nearest reachable chest.
    if (typeof ctx.freeSlots === 'number' && ctx.freeSlots <= c.free_slot_alert) {
        needs.push({
            kind: 'inventory_full',
            urgency: 0.8,
            detail: `${ctx.freeSlots} free slot(s)`,
            advisory: false,
            info: `Only ${ctx.freeSlots} inventory slot(s) left — unloading to storage.`
        });
    }

    // 3. Self-maintained reserves: torches and food, only when craftable now.
    const counts = ctx.inventoryCounts ?? {};
    const hasCoal = (counts['coal'] ?? 0) + (counts['charcoal'] ?? 0) >= 1;
    if ((counts['torch'] ?? 0) < c.min_torches && hasCoal && (counts['stick'] ?? 0) >= 1) {
        needs.push({
            kind: 'restock_torches',
            urgency: 0.35,
            detail: 'torch',
            advisory: false,
            info: `Torches: ${counts['torch'] ?? 0}/${c.min_torches}; coal + sticks available.`
        });
    }
    const foodCount = ctx.foodCount ?? 0;
    if (foodCount < c.min_food && (counts['wheat'] ?? 0) >= 3) {
        needs.push({
            kind: 'restock_food',
            urgency: 0.4,
            detail: 'bread',
            advisory: false,
            info: `Food: ${foodCount}/${c.min_food}; wheat available for bread.`
        });
    }

    // 3b. Farming: grow the food reserve when crafting can't cover it.
    const farm = ctx.farm;
    if (farm && foodCount < c.min_food && !((counts['wheat'] ?? 0) >= 3)) {
        const canHarvest = (farm.mature ?? 0) > 0;
        const canPlant = (farm.seeds ?? 0) > 0 && (farm.farmland ?? 0) > 0;
        // base-scale growth: seeds but no open farmland -> till new plots
        const canExpand = (farm.seeds ?? 0) > 0 && !!(farm.canTill) && (farm.farmland ?? 0) === 0;
        if (canHarvest || canPlant || canExpand) {
            needs.push({
                kind: 'farm',
                urgency: 0.45,
                detail: canHarvest
                    ? `harvest ${farm.mature} mature crop(s)`
                    : canPlant ? `plant seeds (${farm.seeds} carried)` : `till new plots (${farm.seeds} seeds carried)`,
                advisory: false,
                info: `Food: ${foodCount}/${c.min_food}; ${farm.mature ?? 0} mature, ${farm.seeds ?? 0} seeds, ${farm.farmland ?? 0} farmland.`
            });
        }
    }

    // 4. Bedtime: at night with a known bed, rest instead of wandering.
    //    Dangerous nights are handled by the risk gate (rest is a risky need).
    if (ctx.isNight && ctx.bedKnown && !ctx.hasPendingResume) {
        needs.push({
            kind: 'rest',
            urgency: 0.5,
            detail: 'bed known',
            advisory: false,
            info: 'It is night and a bed is known — sleeping until morning.'
        });
    }

    // 4b. Proactive base maintenance: light the dark spots around home.
    //     Beats idle exploration even by day — a lit base before wandering.
    if (ctx.homeSet && ctx.darkSpots > 0 && (counts['torch'] ?? 0) > 0) {
        needs.push({
            kind: 'maintain_base',
            urgency: ctx.isNight ? 0.45 : 0.35,
            detail: `${ctx.darkSpots} dark spot(s)`,
            advisory: false,
            info: `${ctx.darkSpots} dark spot(s) around home; torches available.`
        });
    }

    // 4b. Husbandry: breeding food in hand + adult animals nearby -> pair them
    //     up. Productive outdoor work, so it outranks aimless wandering but is
    //     a risky need (the risk gate holds it when hostiles are close).
    if ((ctx.husbandryPairs ?? 0) > 0 && !ctx.isNight && !ctx.hasPendingResume) {
        const idleMs = ctx.idleForMs ?? 0;
        if (idleMs >= c.explore_idle_s * 1000) {
            needs.push({
                kind: 'husbandry',
                urgency: 0.34,
                detail: `breed ${ctx.husbandryPairs} pair(s)`,
                advisory: false,
                info: 'Carrying breeding food with adult animals nearby.'
            });
        }
    }

    // 5. Idle long enough with nothing pending -> go see the world.
    if (c.explore_when_idle) {
        const idleMs = ctx.idleForMs ?? 0;
        if (idleMs >= c.explore_idle_s * 1000 && !ctx.hasPendingResume) {
            // a configured patrol beats aimless exploration by day; nights
            // are for staying put either way
            if (ctx.patrolReady && !ctx.isNight) {
                needs.push({
                    kind: 'patrol',
                    urgency: 0.32,
                    detail: `idle ${Math.round(idleMs / 1000)}s`,
                    advisory: false,
                    info: 'Idle long enough — walking the configured patrol round.'
                });
            } else {
                // nights are for staying put unless curiosity demands otherwise
                const urgency = ctx.isNight ? 0.15 : 0.3;
                needs.push({
                    kind: 'explore',
                    urgency,
                    detail: `idle ${Math.round(idleMs / 1000)}s`,
                    advisory: false,
                    info: `Idle ${Math.round(idleMs / 1000)}s; frontier exploration.`
                });
            }
        }
    }

    // 4d. Self-initiated resource gathering (GO list: autonomous resource
    //     gathering): when staple materials run low, the bot tops itself up
    //     without being asked — daytime only, room to carry, nothing pending.
    if (!ctx.isNight && !ctx.hasPendingResume && (ctx.freeSlots ?? 0) >= 6) {
        const logNames = ['oak_log', 'birch_log', 'spruce_log', 'jungle_log',
            'acacia_log', 'dark_oak_log', 'mangrove_log', 'cherry_log'];
        let logs = 0;
        for (const n of logNames) logs += counts[n] ?? 0;
        if (logs < (c.gather_min_logs ?? 12)) {
            needs.push({
                kind: 'gather_resource',
                urgency: 0.33,
                detail: 'log',
                advisory: false,
                info: `Logs: ${logs}/${c.gather_min_logs ?? 12}; self-initiated wood run.`
            });
        }
    }

    // Formal priority classes first, urgency within a class.
    needs.sort((a, b) => priorityValue(b.kind) - priorityValue(a.kind) || b.urgency - a.urgency);
    return needs;
}

/** Count free slots in the main inventory (slots 9-44 in mineflayer layout). */
export function countFreeSlots(bot) {
    const slots = bot?.inventory?.slots ?? [];
    let free = 0;
    for (let i = 9; i <= 44 && i < slots.length; i++) {
        if (slots[i] == null) free++;
    }
    return free;
}

/** Mineflayer timeOfDay is 0-24000; night is roughly 13000-23000. */
export function isNightTime(bot) {
    const t = bot?.time?.timeOfDay;
    if (typeof t !== 'number') return false;
    return t >= 13000 && t < 23000;
}
