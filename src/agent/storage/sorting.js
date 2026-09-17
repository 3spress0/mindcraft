/**
 * sorting.js — full slot-order chest sorting (GO list: sorting).
 *
 * Rearranges a chest into a deterministic order: category groups (tools,
 * armor, food, resources, blocks, misc), then item name, then count desc;
 * empty slots last. Executed with ordinary window clicks —
 * container.moveSlotItem swaps — the same operations a player would do.
 */

import { categorize } from './tidying.js';

/** Category sort weight; lower sorts first. */
const CATEGORY_RANK = { tools: 0, armor: 1, food: 2, resources: 3, blocks: 4, misc: 5 };

/** Sort key for one slot item: [categoryRank, name, -count]. */
export function sortKey(item) {
    if (!item?.name) return null; // empties go last
    return {
        cat: CATEGORY_RANK[categorize(item.name)] ?? 5,
        name: item.name,
        count: item.count ?? 1
    };
}

function compareKeys(a, b) {
    if (a.cat !== b.cat) return a.cat - b.cat;
    if (a.name !== b.name) return a.name < b.name ? -1 : 1;
    return b.count - a.count; // bigger stacks first within a type
}

/**
 * Compute the target arrangement for a chest's slots.
 * @param {Array<object|null>} slots  slot-indexed items (null = empty)
 * @returns {{target: Array<object|null>, moves: Array<{from, to}>}}
 *          moves are swaps to apply in order (selection sort over swaps)
 */
export function computeSortPlan(slots) {
    const items = (slots ?? []).map(s => s ?? null);
    const filled = items.filter(it => it && it.name).map(it => ({ ...it }));
    filled.sort((a, b) => compareKeys(sortKey(a), sortKey(b)));

    const target = new Array(items.length).fill(null);
    for (let i = 0; i < filled.length; i++) target[i] = filled[i];

    // selection sort via swaps: at each position, swap in the right item
    const working = items.map(it => (it ? { ...it } : null));
    const moves = [];
    for (let i = 0; i < target.length; i++) {
        const want = target[i]?.name ?? null;
        const have = working[i]?.name ?? null;
        if (want === have && want === null) continue;
        if (want != null && have === want && working[i]?.count === target[i].count) continue;
        // find the slot holding what belongs here
        let j = -1;
        for (let k = i + 1; k < working.length; k++) {
            const cand = working[k];
            if (want == null) { if (!cand) { j = k; break; } }
            else if (cand?.name === want && cand.count === target[i].count) { j = k; break; }
        }
        if (j === -1) {
            // closest match: any slot with the wanted name (count may differ)
            for (let k = i + 1; k < working.length; k++) {
                if (want != null && working[k]?.name === want) { j = k; break; }
            }
        }
        if (j === -1) continue; // already effectively in place
        moves.push({ from: j, to: i });
        const tmp = working[i];
        working[i] = working[j];
        working[j] = tmp;
    }
    return { target, moves };
}

/** True when a chest already matches its sorted arrangement. */
export function isSorted(slots) {
    return computeSortPlan(slots).moves.length === 0;
}

/**
 * Sort a chest in-world using window-click swaps.
 * @returns {Promise<string>} human-readable result
 */
export async function executeSort(bot, chestBlock, { force = false } = {}) {
    if (!bot || !chestBlock?.position) return 'sort: no chest to sort';
    const skills = await import('../library/skills.js');

    let container;
    try {
        await skills.goToPosition(bot, chestBlock.position.x, chestBlock.position.y, chestBlock.position.z, 2);
        container = await bot.openContainer(chestBlock);
    } catch (e) {
        return `sort failed: ${e.message}`;
    }

    try {
        const slots = container.slots ?? [];
        // Avoid unnecessary inventory rearrangement (GO list): only shuffle
        // when the chest is genuinely scattered, unless forced.
        if (!force) {
            try {
                const { sortWarranted } = await import('../humanlike/reactions.js');
                const check = sortWarranted(slots);
                if (!check.warranted) return `sort: chest is tidy enough already (${check.runs} runs) — use force to sort anyway`;
            } catch { /* guard is advisory */ }
        }
        const { moves } = computeSortPlan(slots);
        if (!moves.length) return 'sort: chest is already sorted';
        for (const mv of moves) {
            if (bot.interrupt_code) break;
            try { await container.moveSlotItem(mv.from, mv.to); } catch { /* skip failed click */ }
        }
        return `sort: arranged chest in ${moves.length} move(s)`;
    } finally {
        try { await container.close(); } catch { /* already closed */ }
    }
}
