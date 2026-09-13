/**
 * queries.js — goal/recovery-oriented questions over the WorldModel.
 *
 * world_model.js answers generic "nearest fact / last seen fact" questions.
 * The recovery layer needs slightly richer, situation-shaped answers:
 *   - where is the nearest NOT-depleted deposit of the item we need?
 *   - are there fresh threats between here and the next action?
 *   - where can the bot retreat to?
 *
 * Pure functions over a WorldModel: no mineflayer, no agent, no side effects.
 */

import { CATEGORY, distance } from './world_model.js';

/** All resource deposits for an item name fragment, nearest first. */
export function knownDeposits(model, itemName, pos, { includeDepleted = false, now = Date.now() } = {}) {
    if (!model) return [];
    const needle = String(itemName || '').toLowerCase();
    return model.find(CATEGORY.RESOURCE, (f) => {
        if (!f.isFresh(now)) return false;
        if (f.kind !== 'deposit' && f.kind !== 'ground_item') return false;
        if (!includeDepleted && f.detail?.depleted) return false;
        if (!f.pos || !pos) return false;
        return !needle || f.name.toLowerCase().includes(needle) ||
            String(f.detail?.item || '').toLowerCase().includes(needle);
    }).map((f) => ({ fact: f, distance: distance(f.pos, pos) }))
        .sort((a, b) => a.distance - b.distance);
}

/** Nearest usable (non-depleted) deposit, plus the nearest depleted one for evidence. */
export function nearestDeposit(model, itemName, pos) {
    const usable = knownDeposits(model, itemName, pos, { includeDepleted: false });
    const depleted = knownDeposits(model, itemName, pos, { includeDepleted: true })
        .filter((h) => h.fact.detail?.depleted);
    return { alternative: usable[0] || null, depleted: depleted[0] || null };
}

/** Fresh threats within radius, nearest first. */
export function threatsNear(model, pos, radius = 16) {
    if (!model || !pos) return [];
    const now = Date.now();
    return model.find(CATEGORY.THREAT, (f) => f.isFresh(now) && f.pos)
        .map((f) => ({ fact: f, distance: distance(f.pos, pos) }))
        .filter((h) => h.distance <= radius)
        .sort((a, b) => a.distance - b.distance);
}

/** Nearest known structure matching a block/item name (crafting table, chest...). */
export function nearestStructure(model, nameFragment, pos) {
    if (!model) return null;
    const needle = String(nameFragment || '').toLowerCase();
    const hits = model.find(CATEGORY.STRUCTURE, (f) => f.pos &&
        (f.name.toLowerCase().includes(needle) || (f.kind || '').toLowerCase().includes(needle)))
        .map((f) => ({ fact: f, distance: distance(f.pos, pos) }))
        .sort((a, b) => a.distance - b.distance);
    return hits[0] || null;
}

/** Nearest previously seen entity of a kind (e.g. villager), with age check. */
export function nearestEntityFact(model, kindFragment, pos, { maxAgeMs = 600_000 } = {}) {
    if (!model) return null;
    const now = Date.now();
    const needle = String(kindFragment || '').toLowerCase();
    const hits = model.find(CATEGORY.ENTITY, (f) => f.pos && f.lastSeen > now - maxAgeMs &&
        (f.name.toLowerCase().includes(needle) || (f.kind || '').toLowerCase().includes(needle)))
        .map((f) => ({ fact: f, distance: distance(f.pos, pos) }))
        .sort((a, b) => a.distance - b.distance);
    return hits[0] || null;
}

const SAFE_LOCATION_KINDS = /base|home|shelter|house|bed|portal|shrine|camp/;

/**
 * Pick a retreat point: a known safe-ish named location nearest to the bot.
 * Falls back to a point directly away from the nearest threat.
 */
export function safeRetreat(model, pos, { threat = null, spacing = 12 } = {}) {
    if (!model || !pos) return null;
    const locations = model.find(CATEGORY.LOCATION, (f) => f.pos &&
        f.kind !== 'death' && SAFE_LOCATION_KINDS.test(`${f.name} ${f.kind}`))
        .map((f) => ({ fact: f, distance: distance(f.pos, pos) }))
        .sort((a, b) => a.distance - b.distance);
    if (locations.length) {
        const pick = locations[0];
        return { pos: pick.fact.pos, name: pick.fact.name, distance: pick.distance, kind: 'known_location' };
    }
    const nearestThreat = threat?.pos ||
        threatsNear(model, pos, 24)[0]?.fact?.pos || null;
    if (nearestThreat) {
        const dx = pos.x - nearestThreat.x;
        const dz = pos.z - nearestThreat.z;
        const len = Math.hypot(dx, dz) || 1;
        return {
            pos: {
                x: Math.round(pos.x + (dx / len) * spacing),
                y: pos.y,
                z: Math.round(pos.z + (dz / len) * spacing),
            },
            name: 'open ground away from the threat',
            distance: spacing,
            kind: 'away_from_threat',
        };
    }
    return null;
}

/**
 * Extract the concrete items a step's verification contract requires.
 * @returns [{item, need, source: 'gain'|'cost'}]
 */
export function requiredItems(step) {
    const out = [];
    const seen = new Set();
    const push = (item, need, source) => {
        if (!item || seen.has(`${item}:${source}`)) return;
        seen.add(`${item}:${source}`);
        out.push({ item: String(item), need: Number(need) || 1, source });
    };
    const expected = step?.expected || {};
    if (expected.kind === 'inventory' && expected.item) {
        push(expected.item, expected.gained ?? expected.atLeast ?? 1, 'gain');
    }
    for (const d of step?.expectedDelta || []) {
        if (!d.path?.startsWith('inventory.')) continue;
        const item = d.path.slice('inventory.'.length);
        if (d.delta > 0) push(item, d.delta, 'gain');
        else if (d.delta < 0) push(item, -d.delta, 'cost');
    }
    return out;
}

/** What the step is primarily looking for, by expectation kind. */
export function stepTarget(step) {
    const e = step?.expected || {};
    if (e.kind === 'block_near') return { type: 'block', name: e.block };
    if (e.kind === 'entity_near') return { type: 'entity', name: e.entity };
    if (e.kind === 'near') return { type: 'location', pos: { x: e.x, y: e.y, z: e.z }, radius: e.radius };
    if (e.kind === 'inventory') return { type: 'resource', name: e.item };
    return null;
}

/**
 * Full recovery-oriented world picture for one failed step.
 */
export function recoveryContext(model, step, pos, { threatRadius = 16 } = {}) {
    const needed = requiredItems(step);
    const gains = needed.filter((r) => r.source === 'gain');
    const costs = needed.filter((r) => r.source === 'cost');
    const target = stepTarget(step);

    // For block_near/entity_near, also treat target name as a resource query so depleted handling works
    const extraGains = [];
    if (target?.type === 'block' || target?.type === 'entity') {
        const name = target.name;
        if (name && !gains.some(g => g.item === name)) {
            extraGains.push({ item: name, need: 1, source: 'gain' });
        }
    }

    const allGains = [...gains, ...extraGains];

    const itemQueries = allGains.map((r) => {
        const { alternative, depleted } = nearestDeposit(model, r.item, pos);
        return { ...r, alternative, depleted };
    });
    const costQueries = costs.map((r) => {
        const { alternative } = nearestDeposit(model, r.item, pos);
        return { ...r, alternative };
    });

    let knownTarget = null;
    if (target?.type === 'entity') knownTarget = nearestEntityFact(model, target.name, pos);
    else if (target?.type === 'block') {
        knownTarget = nearestStructure(model, target.name, pos);
        // Fallback: if no structure, check deposits as known target
        if (!knownTarget) {
            const dep = nearestDeposit(model, target.name, pos);
            if (dep.alternative) {
                knownTarget = { fact: dep.alternative.fact, distance: dep.alternative.distance };
            }
        }
    }

    const threats = threatsNear(model, pos, threatRadius);
    return {
        needed: gains,
        costs,
        itemQueries,
        costQueries,
        target,
        knownTarget,
        threats,
        health: model?.player?.health ?? null,
        retreat: safeRetreat(model, pos, { threat: threats[0]?.fact }),
    };
}
