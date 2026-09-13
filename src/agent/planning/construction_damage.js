/**
 * construction_damage.js — deterministic construction-damage detection.
 *
 * Snapshots expected structure state from a schematic/build plan and compares
 * later observations against it. Produces a normal recovery failure
 * (construction_damaged) that feeds into the existing recovery engine.
 *
 * No separate repair system: damage is just another failure class that the
 * policy table maps to replan/retry/gather.
 */

import { FAILURE } from './critic.js';

// Re-implement rotateXZ to avoid circular deps (same logic as npc/utils.js)
function rotateXZ(x, z, orientation, sizex, sizez) {
    if (orientation === 0) return [x, z];
    if (orientation === 1) return [z, sizex - x - 1];
    if (orientation === 2) return [sizex - x - 1, sizez - z - 1];
    if (orientation === 3) return [sizez - z - 1, x];
    return [x, z];
}

function blockSatisfied(targetName, actualName) {
    if (!targetName || targetName === '' || targetName === 'air') return true; // air expected = don't care for damage
    if (!actualName) return false;
    if (targetName === 'dirt') return actualName === 'dirt' || actualName === 'grass_block' || actualName === 'farmland';
    if (targetName.endsWith('_sign')) {
        const wood = targetName.split('_sign')[0];
        return actualName === `${wood}_sign` || actualName === `${wood}_wall_sign` ||
            actualName === `${wood}_hanging_sign` || actualName === `${wood}_wall_hanging_sign`;
    }
    if (targetName === 'torch') return actualName.includes('torch');
    return actualName === targetName || actualName.endsWith(targetName) || targetName.endsWith(actualName);
}

/**
 * Snapshot expected structure state from a construction blueprint.
 *
 * @param {string} name - identifier for this structure (e.g. "wheat_farm")
 * @param {object} construction - { blocks: [y][z][x], offset: number }
 * @param {object} position - world corner {x,y,z}
 * @param {number} orientation - 0..3
 * @returns {object} snapshot
 */
export function createExpectedSnapshot(name, construction, position, orientation = 0) {
    if (!construction || !Array.isArray(construction.blocks)) {
        throw new Error('construction must have blocks[y][z][x]');
    }
    const blocks = construction.blocks;
    const offset = construction.offset || 0;
    const sizey = blocks.length;
    const sizez = blocks[0]?.length || 0;
    const sizex = blocks[0]?.[0]?.length || 0;

    const expectedList = [];
    for (let y = offset; y < sizey + offset; y++) {
        for (let z = 0; z < sizez; z++) {
            for (let x = 0; x < sizex; x++) {
                const ry = y - offset;
                const [rx, rz] = rotateXZ(x, z, orientation, sizex, sizez);
                if (ry < 0 || ry >= sizey) continue;
                if (rz < 0 || rz >= sizez) continue;
                if (rx < 0 || rx >= sizex) continue;
                const blockName = blocks[ry]?.[rz]?.[rx];
                if (!blockName || blockName === '' || blockName === 'air') continue; // skip air/empty
                const wx = Math.floor(position.x + x);
                const wy = Math.floor(position.y + y);
                const wz = Math.floor(position.z + z);
                expectedList.push({
                    x: wx, y: wy, z: wz,
                    expected: String(blockName),
                    local: { x, y, z },
                    rotated: { x: rx, z: rz },
                });
            }
        }
    }

    return {
        id: `${name}@${position.x},${position.y},${position.z}#${orientation}`,
        name,
        position: { x: Math.floor(position.x), y: Math.floor(position.y), z: Math.floor(position.z) },
        orientation,
        constructionName: name,
        totalExpected: expectedList.length,
        expectedList,
        createdAt: Date.now(),
        size: { x: sizex, y: sizey, z: sizez },
    };
}

/**
 * Compare expected snapshot against live world (bot.blockAt).
 *
 * @param {object} snapshot - from createExpectedSnapshot
 * @param {object} bot - mineflayer bot (needs blockAt)
 * @param {object} opts - { tolerance: number 0..1, maxScan: number }
 * @returns {object} comparison result
 */
export function compareSnapshot(snapshot, bot, { tolerance = 0, maxScan = 10000 } = {}) {
    if (!snapshot || !snapshot.expectedList) throw new Error('invalid snapshot');
    if (!bot || typeof bot.blockAt !== 'function') throw new Error('bot.blockAt required');

    const mismatches = [];
    const missing = [];
    const wrong = [];
    let matched = 0;
    let scanned = 0;

    for (const entry of snapshot.expectedList) {
        if (scanned >= maxScan) break;
        scanned++;
        const { x, y, z, expected } = entry;
        let actual = null;
        try {
            const block = bot.blockAt({ x, y, z });
            actual = block ? block.name : 'air';
        } catch {
            actual = 'unknown';
        }
        if (blockSatisfied(expected, actual)) {
            matched++;
        } else {
            const isMissing = actual === 'air' || actual === null || actual === 'unknown';
            const mismatch = { ...entry, actual: actual || 'air', isMissing };
            mismatches.push(mismatch);
            if (isMissing) missing.push(mismatch);
            else wrong.push(mismatch);
        }
    }

    const total = snapshot.totalExpected;
    const damagedCount = mismatches.length;
    const damageRatio = total > 0 ? damagedCount / total : 0;
    const damaged = damageRatio > tolerance;

    const evidenceParts = [];
    if (damaged) {
        evidenceParts.push(`construction damaged: expected ${total} blocks, ${matched} matched, ${damagedCount} mismatched (${Math.round(damageRatio * 100)}% damaged)`);
        if (missing.length) evidenceParts.push(`${missing.length} missing (e.g. ${missing.slice(0, 3).map(m => `${m.expected} at (${m.x},${m.y},${m.z}) expected but found air`).join('; ')})`);
        if (wrong.length) evidenceParts.push(`${wrong.length} wrong (e.g. ${wrong.slice(0, 3).map(m => `${m.expected} at (${m.x},${m.y},${m.z}) but found ${m.actual}`).join('; ')})`);
    }

    return {
        snapshotId: snapshot.id,
        name: snapshot.name,
        totalExpected: total,
        matched,
        mismatched: damagedCount,
        missing,
        wrong,
        mismatches,
        damaged,
        damageRatio,
        evidence: evidenceParts.join('; ') || `structure intact: ${matched}/${total} blocks matched`,
        scanned,
    };
}

/**
 * Classify comparison result into a critic failure.
 *
 * @param {object} comparison - from compareSnapshot
 * @returns {{ failureClass: string, outcome: string, reasoning: string }}
 */
export function classifyConstructionDamage(comparison, { threshold = 0.05 } = {}) {
    if (!comparison.damaged || comparison.damageRatio <= threshold) {
        return {
            failureClass: FAILURE.NONE,
            outcome: 'success',
            reasoning: comparison.evidence,
        };
    }
    // Dedicated classification that maps to recovery policies.
    return {
        failureClass: FAILURE.CONSTRUCTION_DAMAGED || 'construction_damaged',
        outcome: 'failed',
        reasoning: `construction damaged: ${comparison.evidence}`,
    };
}

/**
 * Observer integration: check a construction expectation.
 *
 * Expected format: { kind: 'construction', snapshotId, name, ... } or
 * { kind: 'construction', snapshot: {...} }
 * The bot is expected to have a ConstructionDamageRegistry attached.
 */
export function checkConstructionExpectation(agent, expected, before, after) {
    // This is called from observer.js checkExpectation if we add a new kind.
    // For now, we support it via a separate helper used by critic.
    if (!expected || expected.kind !== 'construction') {
        return { decidable: false };
    }
    const snapshot = expected.snapshot || (agent?.construction_snapshots?.get(expected.snapshotId));
    if (!snapshot) {
        return { decidable: false, satisfied: false, evidence: `no snapshot ${expected.snapshotId} found` };
    }
    const bot = agent?.bot;
    if (!bot) return { decidable: true, satisfied: false, evidence: 'no bot for construction check' };

    const comparison = compareSnapshot(snapshot, bot, { tolerance: expected.tolerance ?? 0.05 });
    const classification = classifyConstructionDamage(comparison, { threshold: expected.threshold ?? 0.05 });

    return {
        decidable: true,
        satisfied: !comparison.damaged,
        evidence: comparison.evidence,
        comparison,
        classification,
    };
}

/**
 * Simple in-memory registry for active construction snapshots.
 */
export class ConstructionRegistry {
    constructor() {
        this.snapshots = new Map(); // id -> snapshot
    }

    add(snapshot) {
        this.snapshots.set(snapshot.id, snapshot);
        return snapshot;
    }

    get(id) {
        return this.snapshots.get(id) || null;
    }

    has(id) {
        return this.snapshots.has(id);
    }

    remove(id) {
        return this.snapshots.delete(id);
    }

    all() {
        return [...this.snapshots.values()];
    }

    clear() {
        this.snapshots.clear();
    }

    toJSON() {
        return this.all().map(s => ({
            id: s.id,
            name: s.name,
            position: s.position,
            orientation: s.orientation,
            totalExpected: s.totalExpected,
            createdAt: s.createdAt,
        }));
    }
}

/**
 * Helper to snapshot from a project step that carries construction data.
 * Used by the benchmark harness when a construction step verifies.
 */
export function snapshotFromStep(step, position, orientation = 0) {
    if (!step || !step.construction) return null;
    const name = step.constructionName || step.title || 'structure';
    return createExpectedSnapshot(name, step.construction, position, orientation);
}
