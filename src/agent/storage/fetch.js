/**
 * fetch.js — storage-aware planning (GO list: storage-aware planning).
 * The bot knows where it stored things (storage index); this module plans
 * and executes "go get N of item X" by routing to the containers believed to
 * hold it, nearest first, and withdrawing until satisfied.
 */

import { getStorageIndex } from './index.js';
import * as world from '../library/world.js';

/**
 * Plan a fetch from the storage index without moving.
 * @returns {{itemName, want, targets: Array<{x,y,z,type,count}>, total, covered}}
 */
export function planFetch(agent, itemName, want = -1) {
    const index = getStorageIndex(agent);
    const name = String(itemName ?? '').toLowerCase();
    let hits = [];
    try { hits = index.findItem(name) ?? []; } catch { hits = []; }
    const targets = hits.map(h => ({ x: h.x, y: h.y, z: h.z, type: h.type, count: h.count }));
    const total = targets.reduce((n, t) => n + t.count, 0);
    const needed = want === -1 ? total : Math.min(want, total);
    return { itemName: name, want: want === -1 ? total : want, targets, total, covered: total >= (want === -1 ? 1 : want) };
}

/**
 * Execute a fetch plan: walk to each container and withdraw until the wanted
 * amount is collected. Bounded, interrupt-aware.
 * @returns {Promise<string>} human-readable result
 */
export async function executeFetch(agent, itemName, want = -1) {
    const bot = agent?.bot;
    if (!bot) return 'fetch: no bot';
    const plan = planFetch(agent, itemName, want);
    if (!plan.targets.length) {
        return `fetch: no stored ${plan.itemName} on record — view chests (!viewChest) to build the index.`;
    }

    let skills;
    try { skills = await import('../library/skills.js'); }
    catch (e) { return `fetch failed: ${e.message}`; }
    const worldMod = await import('../library/world.js');

    let remaining = plan.want;
    let taken = 0;
    const visited = [];
    for (const target of plan.targets) {
        if (bot.interrupt_code) break;
        if (want !== -1 && remaining <= 0) break;
        try {
            await skills.goToPosition(bot, target.x, target.y, target.z, 2);
            if (bot.interrupt_code) break;
            const block = bot.blockAt?.({ x: target.x, y: target.y, z: target.z }) ?? null;
            if (!block || block.name !== 'chest') {
                // index stale? rescan nearby and try the closest real chest
                const found = worldMod.getNearestBlock?.(bot, 'chest', 8);
                if (!found) continue;
                const ok = await skills.takeFromChestAt(bot, found, plan.itemName, remaining);
                if (ok) { visited.push(`${found.position.x},${found.position.z}`); }
                continue;
            }
            const before = countItem(bot, plan.itemName);
            const ok = await skills.takeFromChestAt(bot, block, plan.itemName, remaining);
            if (ok) {
                const after = countItem(bot, plan.itemName);
                const got = Math.max(0, after - before);
                taken += got;
                if (want !== -1) remaining -= got;
                visited.push(`${target.x},${target.z}`);
            }
        } catch { /* this container failed; try the next */ }
    }

    if (!taken) return `fetch: reached storage but found no ${plan.itemName} to take (index may be stale).`;
    return `fetch: took ${taken}x ${plan.itemName} from ${visited.length} chest(s) (${visited.join('; ')}).`;
}

function countItem(bot, itemName) {
    try {
        return world.getInventoryCounts(bot)[itemName] ?? 0;
    } catch { return 0; }
}
