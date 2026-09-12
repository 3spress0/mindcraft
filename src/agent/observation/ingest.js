/**
 * ingest.js — turns verified plan-step results into WorldModel facts.
 *
 * The runner calls one function here after every step. It contains the
 * "what does a verified outcome mean for long-term memory" rules so that
 * logic never leaks into runner.js:
 *
 *   - every observed nearby mob/npc/threat is recorded (with TTLs)
 *   - a verified block placement -> durable structure fact
 *   - a verified multi-villager sighting -> inferred "village" location
 *   - materials gained while gathering -> resource deposit location
 *   - simultaneous material consumption + item creation -> recipe learned
 *   - a failed gather at a known deposit marks it depleted
 *   - the active project snapshot is mirrored for restarts/planning
 *
 * Pure data: reads observer captures (planning/observer.js shape), never the
 * bot directly.
 */

import settings from '../settings.js';
import { CATEGORY, SOURCE } from '../world_model/world_model.js';
import { classifyEntityLike } from './classify.js';
import { OUTCOME } from '../planning/critic.js';

function cfg() {
    return {
        threat_ttl_ms: 120_000,
        entity_ttl_ms: 600_000,
        village_radius: 48,
        ...(settings.world_model || {}),
    };
}

export function syncProject(model, project) {
    if (!model) return;
    if (project) model.setProject(project);
}

/**
 * @returns {{recorded: Array<{category:string,name:string}>, depleted: string[]}}
 */
export function ingestVerifiedStep(model, { step, before, after, critique } = {}) {
    const result = { recorded: [], depleted: [] };
    if (!model || !after) return result;
    const c = cfg();

    model.recordPlayer({
        position: after.position,
        health: after.health,
        food: after.food,
        dimension: after.dimension,
    });

    // 1) Nearby entities -> entity / threat facts (regardless of step outcome).
    const seen = { villagers: [], others: [] };
    for (const e of after.nearbyEntities || []) {
        const cls = classifyEntityLike(e.name, e.type);
        const pos = { x: e.x, y: e.y, z: e.z };
        if (cls.category === 'threat') {
            recordOnce(result, model, CATEGORY.THREAT, {
                name: e.name, kind: cls.kind, pos, dimension: after.dimension, source: SOURCE.OBSERVED,
            }, { expiresIn: c.threat_ttl_ms });
        } else if (cls.category === 'entity') {
            recordOnce(result, model, CATEGORY.ENTITY, {
                name: friendlyName(e.name, cls.kind), kind: cls.kind, pos, dimension: after.dimension, source: SOURCE.OBSERVED,
            }, { expiresIn: c.entity_ttl_ms });
            if (cls.kind === 'villager') seen.villagers.push(pos);
            else seen.others.push({ name: e.name, pos });
        }
    }

    const succeeded = critique?.outcome === OUTCOME.SUCCESS || critique?.outcome === OUTCOME.PARTIAL;
    const expected = step?.expected || {};

    if (succeeded) {
        // 2) Verified block placement -> structure at the build site.
        if (expected.kind === 'block_near' && (critique.evidence?.includes('OK') || critique.evidence?.includes('found'))) {
            recordOnce(result, model, CATEGORY.STRUCTURE, {
                name: titleToName(step.title, expected.block),
                kind: String(expected.block || 'structure'),
                pos: after.position,
                dimension: after.dimension,
                detail: { block: expected.block, step: step.title },
                confidence: 0.9,
                source: SOURCE.VERIFIED,
            });
        }

        // 3) Two+ villagers near the bot -> an inferred village location.
        if (seen.villagers.length >= 2 ||
            (expected.kind === 'entity_near' && String(expected.entity || '').includes('villager'))) {
            const center = centroid(seen.villagers.length ? seen.villagers : [{ ...after.position }]);
            const key = `village@${Math.floor(center.x / c.village_radius)},${Math.floor(center.z / c.village_radius)}`;
            recordOnce(result, model, CATEGORY.LOCATION, {
                key,
                name: 'village',
                kind: 'village',
                pos: center,
                dimension: after.dimension,
                detail: { villagers: Math.max(seen.villagers.length, Number(expected.atLeast) || 1) },
                confidence: 0.6,
                source: SOURCE.INFERRED,
            });
        }

        // 4) Gained materials during a gather-style step -> resource deposit.
        const gained = critiqueGains(before, after);
        const lost = critiqueLosses(before, after);
        const stepText = `${step.title} ${step.instruction}`.toLowerCase();
        const gathering = /\b(gather|collect|mine|chop|harvest|farm|pick up|pickup|quarry|dig)\b/.test(stepText);
        if (gathering) {
            for (const [item, n] of Object.entries(gained)) {
                recordOnce(result, model, CATEGORY.RESOURCE, {
                    name: item,
                    kind: 'deposit',
                    pos: after.position,
                    dimension: after.dimension,
                    detail: { gained: n, activity: firstVerb(stepText) },
                    confidence: 0.6,
                    source: SOURCE.INFERRED,
                });
            }
        }

        // 5) Materials in + products out within one step -> a recipe was proven.
        const crafted = /\b(craft|make|smelt|brew|build with|assemble)\b/.test(stepText);
        const deltaTracksCraft = (step.expectedDelta || []).some((e) => e.path.startsWith('inventory.') && e.delta > 0) &&
            (Object.keys(lost).length > 0 || (step.expectedDelta || []).some((e) => e.delta < 0));
        if ((crafted || deltaTracksCraft) && Object.keys(gained).length > 0 &&
            (Object.keys(lost).length > 0 || deltaTracksCraft)) {
            for (const item of Object.keys(gained)) {
                recordOnce(result, model, CATEGORY.RECIPE, {
                    name: item, kind: 'recipe', pos: null, confidence: 0.95, source: SOURCE.VERIFIED,
                });
            }
        }
    } else {
        // 6) A gather-type failure at a recorded deposit (within ~16 blocks)
        //    marks it depleted so the planner routes elsewhere.
        const wanted = expected.item || expected.entity || null;
        if (wanted) {
            const hit = model.nearest(CATEGORY.RESOURCE, after.position, { name: String(wanted), maxDistance: 24 });
            if (hit) {
                hit.fact.detail.depleted = true;
                hit.fact.detail.depletedAt = Date.now();
                hit.fact.confidence = Math.min(hit.fact.confidence, 0.2);
                result.depleted.push(hit.fact.key);
            }
        }
    }

    return result;
}

function recordOnce(result, model, category, fact, opts = {}) {
    const rec = model.record(category, fact, opts);
    if (!result.recorded.some((r) => r.id === rec.id)) result.recorded.push({ category, name: rec.name, id: rec.id });
    return rec;
}

function critiqueGains(before, after) {
    const out = {};
    if (!before) return out;
    for (const [item, n] of Object.entries(after.inventory || {})) {
        const delta = n - (before.inventory?.[item] || 0);
        if (delta > 0) out[item] = delta;
    }
    return out;
}

function critiqueLosses(before, after) {
    const out = {};
    if (!before) return out;
    for (const [item, n] of Object.entries(before.inventory || {})) {
        const delta = (after.inventory?.[item] || 0) - n;
        if (delta < 0) out[item] = -delta;
    }
    return out;
}

function centroid(points) {
    const n = points.length || 1;
    const sum = points.reduce((acc, p) => ({ x: acc.x + (p.x || 0), y: acc.y + (p.y || 0), z: acc.z + (p.z || 0) }), { x: 0, y: 0, z: 0 });
    return { x: Math.round(sum.x / n), y: Math.round(sum.y / n), z: Math.round(sum.z / n) };
}

function friendlyName(name, kind) {
    if (kind === 'villager') return 'villager';
    return name;
}

function titleToName(title, block) {
    const cleaned = String(title).replace(/^(step[:\s]*)?/i, '').slice(0, 48);
    return cleaned || block || 'structure';
}

function firstVerb(text) {
    const verbs = ['gather', 'collect', 'mine', 'chop', 'harvest', 'farm', 'dig', 'quarry'];
    const m = text.match(new RegExp(`\\b(${verbs.join('|')})\\b`));
    return m ? m[1] : 'gather';
}
