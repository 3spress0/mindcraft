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

/**
 * Formal precondition model (GO list: preconditions). A step's preconditions
 * are the items it mentions needing (from the shared vocab) plus any explicit
 * `requires` array. Each precondition resolves to satisfied / missing.
 * @param {object} step
 * @param {object} inventoryCounts - { itemName: count }
 * @returns {Array<{item, need, have, ok}>}
 */
export function stepPreconditions(step, inventoryCounts = {}) {
    const counts = inventoryCounts ?? {};
    const wanted = new Map();
    for (const req of step?.requires ?? []) {
        if (req && typeof req === 'string') wanted.set(req.toLowerCase(), 1);
        else if (req && typeof req === 'object' && req.item) wanted.set(String(req.item).toLowerCase(), Number(req.count ?? 1));
    }
    const text = `${step?.title ?? ''} ${step?.instruction ?? ''}`.toLowerCase();
    for (const token of text.split(/[^a-z0-9_]+/)) {
        if (token.length >= 3 && COMMON_ITEMS.includes(token) && !wanted.has(token)) wanted.set(token, 1);
    }
    return [...wanted.entries()].map(([item, need]) => ({
        item,
        need,
        have: counts[item] ?? 0,
        ok: (counts[item] ?? 0) >= need
    }));
}

/**
 * Check all remaining steps' preconditions against the current inventory.
 * (GO list: preconditions / self-check before actions.)
 * @returns {{ok:boolean, missing:Array<{step, item}>}}
 */
export function checkPreconditions(project, inventoryCounts = {}) {
    const missing = [];
    for (const step of project?.steps ?? []) {
        try {
            if (step.status === STEP.DONE || step.status === STEP.FAILED) continue;
            for (const pre of stepPreconditions(step, inventoryCounts)) {
                if (!pre.ok) missing.push({ step: step.title, item: pre.item });
            }
        } catch { /* per-step advisory */ }
    }
    return { ok: missing.length === 0, missing };
}

/**
 * Action confidence + uncertainty handling (GO list: action confidence,
 * uncertainty handling, explicit uncertainty). Before executing a step we
 * produce a bounded confidence plus the concrete reasons for doubt, so the
 * runner (and the LLM) can say *why* they are unsure instead of guessing.
 * @param {object} step
 * @param {object} ctx - { inventoryCounts, isNight, riskLevel }
 * @returns {{confidence:number, uncertain:Array<string>}}
 */
export function actionConfidence(step, ctx = {}) {
    const uncertain = [];
    let c = 0.9;
    try {
        c = stepConfidence(step);
        const pres = stepPreconditions(step, ctx.inventoryCounts ?? {});
        for (const pre of pres) {
            if (!pre.ok) {
                c -= 0.15;
                uncertain.push(`missing ${pre.item}`);
            }
        }
        if ((step?.attempts ?? 0) >= 2) {
            c -= 0.1;
            uncertain.push(`already attempted ${step.attempts} times`);
        }
        if (ctx.riskLevel === 'high') {
            c -= 0.1;
            uncertain.push('local risk is high');
        }
        if (ctx.isNight && /build|place|construct/i.test(`${step?.title ?? ''}`)) {
            c -= 0.05;
            uncertain.push('building in the dark');
        }
    } catch { /* confidence must never throw */ }
    return { confidence: Math.round(Math.max(0.05, Math.min(1, c)) * 100) / 100, uncertain };
}

/**
 * Per-action self-check (GO list: self-check before actions). A tiny guard
 * the runner can call right before executing: returns warnings the actor
 * should surface instead of silently plowing ahead. Never throws.
 * @param {object} step
 * @param {object} ctx - { inventoryCounts, isNight, riskLevel, botHealthy }
 * @returns {{go:boolean, warnings:Array<string>}}
 */
export function preActionCheck(step, ctx = {}) {
    const warnings = [];
    try {
        const { confidence, uncertain } = actionConfidence(step, ctx);
        warnings.push(...uncertain);
        if (ctx.botHealthy === false) warnings.push('bot is not healthy');
        return { go: confidence >= 0.45 && ctx.botHealthy !== false, warnings };
    } catch { return { go: true, warnings }; }
}
