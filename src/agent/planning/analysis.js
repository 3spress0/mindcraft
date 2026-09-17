/**
 * analysis.js — plan introspection utilities.
 * (GO list: dependency graphs, resource-aware planning, time-aware
 * planning, action confidence, task summaries, priority handling support.)
 *
 * Pure functions over Project/PlanStep data: the planner stays focused on
 * producing plans, this module answers questions *about* them — what
 * depends on what, which resources the plan mentions but we lack, how long
 * it should take, and how confident we are in each step.
 */

import { STEP } from './plan.js';

/** Priority weights: urgent steps run before normal, normal before background. */
export const PRIORITY_WEIGHT = { urgent: 0, normal: 1, background: 2 };

/**
 * Explicit dependency graph of a project.
 * @returns {{nodes, edges, levels, valid, cycles}}
 */
export function dependencyGraph(project) {
    const steps = project?.steps ?? [];
    const ids = new Set(steps.map(s => s.id));
    const nodes = steps.map(s => ({ id: s.id, title: s.title, status: s.status, priority: s.priority ?? 'normal' }));
    const edges = [];
    let valid = true;
    for (const s of steps) {
        for (const dep of s.dependsOn ?? []) {
            if (!ids.has(dep)) { valid = false; continue; }
            edges.push({ from: dep, to: s.id });
        }
    }
    // topological levels (Kahn); leftover nodes mean a cycle
    const indeg = new Map(nodes.map(n => [n.id, 0]));
    for (const e of edges) indeg.set(e.to, (indeg.get(e.to) ?? 0) + 1);
    const levels = {};
    let frontier = nodes.filter(n => (indeg.get(n.id) ?? 0) === 0).map(n => n.id);
    let level = 0;
    const seen = new Set();
    while (frontier.length) {
        const next = [];
        for (const id of frontier) {
            if (seen.has(id)) continue;
            seen.add(id);
            levels[id] = level;
            for (const e of edges) {
                if (e.from !== id) continue;
                indeg.set(e.to, indeg.get(e.to) - 1);
                if (indeg.get(e.to) <= 0) next.push(e.to);
            }
        }
        frontier = next;
        level++;
    }
    const cycles = nodes.filter(n => !seen.has(n.id)).map(n => n.id);
    if (cycles.length) valid = false;
    return { nodes, edges, levels, valid, cycles };
}

/** Common survival items the resource-gap scanner knows even when not carried. */
export const COMMON_ITEMS = [
    'cobblestone', 'dirt', 'oak_planks', 'oak_log', 'torch', 'coal', 'iron_ingot',
    'iron_ore', 'gold_ingot', 'diamond', 'stick', 'bread', 'wheat', 'wheat_seeds',
    'string', 'leather', 'glass', 'sand', 'gravel', 'stone', 'crafting_table',
    'furnace', 'chest', 'ladder', 'bucket', 'water_bucket', 'bed', 'wool'
];

/**
 * Resource-aware planning: which item names does the plan mention, and do we
 * have them? Advisory — the scanner only recognizes whole lowercase tokens.
 * @param {object} project
 * @param {object} inventoryCounts - { itemName: count }
 * @returns {Array<{item, mentions, have}>} items mentioned but short
 */
export function resourceGaps(project, inventoryCounts = {}) {
    const vocab = new Set([...Object.keys(inventoryCounts ?? {}), ...COMMON_ITEMS]);
    const mentioned = new Map();
    for (const step of project?.steps ?? []) {
        const text = `${step.title ?? ''} ${step.instruction ?? ''}`.toLowerCase();
        for (const token of text.split(/[^a-z0-9_]+/)) {
            if (token.length < 3 || !vocab.has(token)) continue;
            mentioned.set(token, (mentioned.get(token) ?? 0) + 1);
        }
    }
    const gaps = [];
    for (const [item, mentions] of mentioned) {
        const have = inventoryCounts[item] ?? 0;
        if (have <= 0) gaps.push({ item, mentions, have });
    }
    gaps.sort((a, b) => b.mentions - a.mentions);
    return gaps;
}

/**
 * Time-aware planning: rough duration estimate from remaining steps and how
 * long finished steps actually took, plus whether completion is likely to
 * cross into night.
 * @param {object} project
 * @param {object} opts { timeOfDay (0..24000), fallbackStepS, nightAt }
 */
export function timeAwareness(project, { timeOfDay = null, fallbackStepS = 45, nightAt = 13000 } = {}) {
    const steps = project?.steps ?? [];
    const doneSteps = steps.filter(s => s.status === STEP.DONE && s.startedAt && s.finishedAt);
    const remaining = steps.filter(s => s.isOpen());
    let avgS = fallbackStepS;
    if (doneSteps.length) {
        const total = doneSteps.reduce((n, s) => n + (s.finishedAt - s.startedAt), 0);
        avgS = Math.max(10, Math.min(600, total / doneSteps.length / 1000));
    }
    const estimateS = Math.round(remaining.length * avgS);
    let crossesNight = null;
    if (typeof timeOfDay === 'number') {
        // 24000 mc ticks per day ≈ 20 real minutes → 1s real = 20 ticks
        const ticksUntilNight = ((nightAt - timeOfDay) % 24000 + 24000) % 24000;
        const secondsUntilNight = ticksUntilNight / 20;
        crossesNight = estimateS > secondsUntilNight;
    }
    return {
        remainingSteps: remaining.length,
        estimateS,
        avgStepS: Math.round(avgS),
        crossesNight,
        note: crossesNight
            ? `Plan likely runs into night (~${Math.round(estimateS / 60)} min estimated) — expect hostiles.`
            : null
    };
}

/**
 * Action confidence per step: a bounded heuristic from attempts and critic
 * notes. Fresh single-attempt steps are confident; repeatedly retried or
 * criticized steps are not.
 * @returns {number} 0..1
 */
export function stepConfidence(step) {
    let c = 0.9;
    const attempts = Math.max(1, step?.attempts ?? 1);
    c -= 0.15 * (attempts - 1);
    const note = String(step?.criticNote ?? '').toLowerCase();
    if (/fail|wrong|missing|problem|broken/.test(note)) c -= 0.2;
    if (step?.status === STEP.DONE) c = Math.max(c, 0.95); // verified done steps are certain
    return Math.round(Math.max(0.2, Math.min(1, c)) * 100) / 100;
}

/**
 * Natural-language task summary (GO list: task summaries).
 * @param {object} project
 * @returns {string}
 */
export function summarizeProject(project) {
    if (!project) return 'No active plan.';
    const steps = project.steps ?? [];
    const done = steps.filter(s => s.status === STEP.DONE).length;
    const failed = steps.filter(s => s.status === STEP.FAILED).length;
    const active = steps.find(s => s.status === STEP.ACTIVE);
    const next = steps.find(s => s.isOpen() && s !== active);
    const total = steps.length || 1;
    const pct = Math.round((done / total) * 100);
    const parts = [`Goal: "${project.goal}" — ${done}/${steps.length} steps done (${pct}%).`];
    if (active) parts.push(`Right now: "${active.title}" (attempt ${active.attempts}, confidence ${stepConfidence(active)}).`);
    else if (next) parts.push(`Next up: "${next.title}".`);
    if (failed) parts.push(`${failed} step(s) failed and need attention.`);
    const gaps = (() => {
        try { return resourceGaps(project, {}); } catch { return []; }
    })();
    if (gaps.length) parts.push(`Watch out for missing: ${gaps.slice(0, 3).map(g => g.item).join(', ')}.`);
    return parts.join(' ');
}
