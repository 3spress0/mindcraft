/**
 * observer.js — world observation for the planning loop.
 *
 * Every significant executor step is wrapped in a before/after capture. The
 * observer then verifies the step's declared expected outcome deterministically
 * where possible (inventory gain, proximity, block/entity presence, health),
 * and always produces a structured state diff for the LLM critic to judge the
 * "freeform" cases. This turns action results from "no exception = success"
 * into "expected world change actually happened = success".
 */

import * as world from '../library/world.js';

/**
 * Capture the verifiable parts of world state. Cheap on purpose: counts and
 * nearby scans the bot already maintains.
 */
export function captureState(agent) {
    const bot = agent?.bot;
    if (!bot || !bot.entity) return null;
    const pos = bot.entity.position;
    let nearbyEntities = [];
    let nearbyBlocks = [];
    try {
        nearbyEntities = world.getNearbyEntities(bot, 32).map((e) => ({
            name: e.name || e.mobType || 'unknown',
            type: e.type || null,
            x: e.position ? Number(e.position.x.toFixed(1)) : null,
            y: e.position ? Number(e.position.y.toFixed(1)) : null,
            z: e.position ? Number(e.position.z.toFixed(1)) : null,
        }));
    } catch { /* chunk/entity scan can race during disconnect */ }
    try {
        nearbyBlocks = world.getNearbyBlockTypes(bot, 24);
    } catch { /* ignore */ }

    return {
        at: Date.now(),
        position: { x: Number(pos.x.toFixed(2)), y: Number(pos.y.toFixed(2)), z: Number(pos.z.toFixed(2)) },
        health: Math.round(bot.health),
        food: Math.round(bot.food),
        dimension: bot.game?.dimension || null,
        inventory: world.getInventoryCounts(bot),
        nearbyEntities,
        nearbyBlockTypes: nearbyBlocks,
    };
}

export function stateDiff(before, after) {
    const changes = [];
    if (!before || !after) return { text: '(no observation available)', inventoryGained: {}, inventoryLost: {}, moved: 0, healthDelta: 0 };

    const gained = {};
    const lost = {};
    const items = new Set([...Object.keys(before.inventory), ...Object.keys(after.inventory)]);
    for (const item of items) {
        const delta = (after.inventory[item] || 0) - (before.inventory[item] || 0);
        if (delta > 0) gained[item] = delta;
        else if (delta < 0) lost[item] = -delta;
    }
    const moved = distance(before.position, after.position);
    const healthDelta = after.health - before.health;
    const foodDelta = after.food - before.food;

    if (Object.keys(gained).length) changes.push('inventory gained: ' + describeCounts(gained, '+'));
    if (Object.keys(lost).length) changes.push('inventory lost: ' + describeCounts(lost, '-'));
    if (moved >= 0.5) changes.push(`moved ${moved.toFixed(1)} blocks to ${fmtPos(after.position)}`);
    if (healthDelta !== 0) changes.push(`health ${before.health} -> ${after.health}`);
    if (foodDelta !== 0) changes.push(`hunger ${before.food} -> ${after.food}`);
    const beforeSet = new Set(before.nearbyBlockTypes);
    const afterSet = new Set(after.nearbyBlockTypes);
    const newBlocks = [...afterSet].filter((b) => !beforeSet.has(b)).slice(0, 12);
    const goneBlocks = [...beforeSet].filter((b) => !afterSet.has(b)).slice(0, 12);
    if (newBlocks.length) changes.push('new nearby blocks: ' + newBlocks.join(', '));
    if (goneBlocks.length) changes.push('gone nearby blocks: ' + goneBlocks.join(', '));
    const entityInfo = countEntities(after.nearbyEntities);
    if (entityInfo) changes.push('nearby entities: ' + entityInfo);

    return {
        text: changes.length ? changes.join('\n') : 'no observable change',
        inventoryGained: gained,
        inventoryLost: lost,
        moved,
        healthDelta,
        foodDelta,
        before,
        after,
    };
}

function describeCounts(counts, sign) {
    return Object.entries(counts).map(([k, v]) => `${k} ${sign}${v}`).join(', ');
}

function countEntities(entities) {
    const counts = {};
    for (const e of entities) {
        if (!e.name || e.name === 'player') continue;
        counts[e.name] = (counts[e.name] || 0) + 1;
    }
    return Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 10)
        .map(([name, n]) => `${name} x${n}`).join(', ');
}

export function distance(a, b) {
    if (!a || !b) return 0;
    return Math.sqrt((a.x - b.x) ** 2 + (a.y - b.y) ** 2 + (a.z - b.z) ** 2);
}

function fmtPos(p) {
    return `(${Math.round(p.x)}, ${Math.round(p.y)}, ${Math.round(p.z)})`;
}

/**
 * Deterministically verify one expectation against a before/after pair.
 * Returns { decidable: true, satisfied, evidence } or { decidable:false } for
 * freeform expectations (the LLM critic judges those from stateDiff text).
 */
export function checkExpectation(agent, expected, before, after) {
    if (!after) return { decidable: true, satisfied: false, evidence: 'no post-action state (bot disconnected?)' };

    switch (expected.kind) {
        case 'inventory': {
            const item = expected.item;
            const have = after.inventory[item] || 0;
            if (expected.gained != null) {
                const gainedN = (after.inventory[item] || 0) - (before?.inventory?.[item] || 0);
                const need = Number(expected.gained);
                return verdict(gainedN >= need,
                    `gained ${gainedN} ${item} (expected >= ${need}); now have ${have}`);
            }
            const need = Number(expected.atLeast ?? 1);
            return verdict(have >= need, `have ${have} ${item} (expected >= ${need})`);
        }
        case 'near': {
            const target = { x: Number(expected.x), y: Number(expected.y), z: Number(expected.z) };
            const radius = Number(expected.radius ?? 4);
            const d = distance(after.position, target);
            return verdict(d <= radius, `${d.toFixed(1)} blocks from (${target.x}, ${target.y}, ${target.z}) (within ${radius})`);
        }
        case 'block_near': {
            const radius = Number(expected.radius ?? 8);
            const name = String(expected.block);
            const atLeast = Number(expected.atLeast ?? 1);
            const blocks = scanBlocks(agent, name, radius);
            return verdict(blocks >= atLeast,
                `found ${blocks} "${name}" block(s) within ${radius} blocks (expected >= ${atLeast})`);
        }
        case 'entity_near': {
            const radius = Number(expected.radius ?? 16);
            const atLeast = Number(expected.atLeast ?? 1);
            const wanted = String(expected.entity);
            let entities = [];
            try {
                entities = world.getNearbyEntities(agent.bot, radius);
            } catch { /* ignore */ }
            const n = entities.filter((e) => entityMatches(e, wanted)).length;
            return verdict(n >= atLeast, `found ${n} "${wanted}" within ${radius} blocks (expected >= ${atLeast})`);
        }
        case 'health_above': {
            const level = Number(expected.level ?? 10);
            return verdict(after.health >= level, `health ${after.health} (expected >= ${level})`);
        }
        case 'construction': {
            try {
                const registry = agent?.construction_registry || agent?.construction_snapshots;
                let snapshot = expected.snapshot || null;
                if (!snapshot && expected.snapshotId && registry) {
                    snapshot = typeof registry.get === 'function' ? registry.get(expected.snapshotId) : registry[expected.snapshotId];
                }
                if (!snapshot) {
                    if (Array.isArray(expected.expectedList)) {
                        snapshot = { id: expected.snapshotId || 'inline', name: expected.name || 'construction', totalExpected: expected.expectedList.length, expectedList: expected.expectedList };
                    } else {
                        return { decidable: false, satisfied: false, evidence: expected.description || 'construction check (no snapshot)' };
                    }
                }
                const tolerance = expected.tolerance ?? 0.05;
                const threshold = expected.threshold ?? tolerance;
                let matched = 0;
                let mismatched = 0;
                const missing = [];
                const wrong = [];
                const bot = agent?.bot;
                if (!bot || typeof bot.blockAt !== 'function') {
                    return { decidable: false, satisfied: false, evidence: 'no bot for construction check' };
                }
                for (const entry of snapshot.expectedList || []) {
                    let actual = 'air';
                    try {
                        const b = bot.blockAt({ x: entry.x, y: entry.y, z: entry.z });
                        actual = b ? b.name : 'air';
                    } catch { actual = 'air'; }
                    const exp = entry.expected;
                    const ok = exp === actual || (exp === 'farmland' && (actual === 'farmland' || actual === 'dirt' || actual === 'grass_block')) || actual.includes(exp) || exp.includes(actual);
                    if (ok) matched++;
                    else {
                        mismatched++;
                        if (actual === 'air') missing.push(entry);
                        else wrong.push({ ...entry, actual });
                    }
                }
                const total = snapshot.totalExpected || snapshot.expectedList.length;
                const ratio = total ? mismatched / total : 0;
                const damaged = ratio > threshold;
                const evidence = damaged ?
                    `construction damaged: expected ${total} blocks, ${matched} matched, ${mismatched} mismatched (${Math.round(ratio * 100)}% damaged)` +
                    (missing.length ? `; ${missing.length} missing` : '') +
                    (wrong.length ? `; ${wrong.length} wrong` : '') :
                    `construction intact: ${matched}/${total} blocks matched`;
                return verdict(!damaged, evidence);
            } catch (err) {
                return { decidable: false, satisfied: false, evidence: `construction check error: ${err.message}` };
            }
        }
        case 'freeform':
        default:
            return { decidable: false, satisfied: false, evidence: expected.description || expected.kind };
    }
}

function verdict(satisfied, evidence) {
    return { decidable: true, satisfied, evidence };
}

function entityMatches(entity, wanted) {
    wanted = wanted.toLowerCase();
    const name = String(entity.name || entity.mobType || '').toLowerCase();
    if (name === wanted) return true;
    // e.g. "cow" matches "baby_cow"/"cow"-like names, "villager" matches variants.
    return name.includes(wanted);
}

function scanBlocks(agent, name, radius) {
    // Direct cube scan via blockAt (version-independent, no numeric ids needed).
    const bot = agent.bot;
    const center = bot.entity.position.floored();
    const r = Math.min(Number(radius) || 8, 24);
    let count = 0;
    for (let dx = -r; dx <= r && count < 2000; dx++) {
        for (let dy = -r; dy <= Math.min(r, 8) && count < 2000; dy++) {
            for (let dz = -r; dz <= r && count < 2000; dz++) {
                const b = bot.blockAt(center.offset(dx, dy, dz));
                if (b && (b.name === name || b.displayName === name)) count += 1;
            }
        }
    }
    return count;
}
