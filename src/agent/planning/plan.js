/**
 * plan.js — domain model for the planner → executor → critic loop.
 *
 * A Project is a hierarchical-but-mostly-flat task tree: a goal plus an
 * ordered list of Steps, each with an executable instruction for the ReAct
 * agent, a verifiable expected outcome, and explicit dependencies. Everything
 * here is pure data + deterministic transitions so the LLM only ever supplies
 * JSON and never owns control flow; the PlanRunner decides what happens next.
 *
 * Step status lifecycle:
 *
 *   pending ──► active ──► done
 *                  │
 *                  ├──► failed   (attempts remain -> retried)
 *                  └──► blocked  (needs replanning or a human)
 *
 * Verification specs (`expected`) are interpreted by observer.js:
 *   { kind: 'inventory',  item, atLeast?, gained? }
 *   { kind: 'near',       x, y, z, radius }
 *   { kind: 'block_near', block, radius?, atLeast? }
 *   { kind: 'entity_near', entity, radius?, atLeast? }
 *   { kind: 'health_above', level }
 *   { kind: 'freeform',   description }   (LLM critic judges from observation)
 */

import fs from 'fs';
import path from 'path';
import { normalizeDelta, deltaToJSON } from '../observation/transitions.js';

export const STEP = {
    PENDING: 'pending',
    ACTIVE: 'active',
    DONE: 'done',
    FAILED: 'failed',
    BLOCKED: 'blocked',
    SKIPPED: 'skipped',
};

export const PROJECT = {
    PLANNING: 'planning',
    ACTIVE: 'active',
    PAUSED: 'paused',
    DONE: 'done',
    FAILED: 'failed',
};

let stepCounter = 0;
function newStepId() {
    stepCounter = (stepCounter + 1) % 1_000_000;
    return `s${Date.now().toString(36)}_${stepCounter}`;
}

export class PlanStep {
    constructor(data = {}) {
        this.id = data.id || newStepId();
        this.title = String(data.title || 'Untitled step');
        this.instruction = String(data.instruction || data.title || '');
        this.expected = normalizeExpected(data.expected);
        this.expectedDelta = normalizeStepDelta(data.expectedDelta ?? data.expected_delta);
        this.dependsOn = Array.isArray(data.dependsOn) ? [...data.dependsOn] :
            (Array.isArray(data.depends_on) ? [...data.depends_on] : []);
        this.status = data.status || STEP.PENDING;
        this.attempts = data.attempts || 0;
        this.observation = data.observation || null;
        this.criticNote = data.criticNote || null;
        this.startedAt = data.startedAt || null;
        this.finishedAt = data.finishedAt || null;
    }

    isOpen() {
        return this.status === STEP.PENDING || this.status === STEP.FAILED;
    }

    toJSON() {
        return {
            id: this.id,
            title: this.title,
            instruction: this.instruction,
            expected: this.expected,
            expected_delta: this.expectedDelta ? deltaToJSON(this.expectedDelta) : null,
            dependsOn: this.dependsOn,
            status: this.status,
            attempts: this.attempts,
            observation: this.observation,
            criticNote: this.criticNote,
            startedAt: this.startedAt,
            finishedAt: this.finishedAt,
        };
    }
}

/** Accept normalized entry arrays, model JSON maps, or nothing. */
export function normalizeStepDelta(raw) {
    if (!raw) return null;
    const { entries, problems } = normalizeDelta(raw);
    if (problems.length) {
        for (const p of problems) {
            if (!p.includes('not verifiable')) console.warn(`[planning] ${p}`);
        }
    }
    return entries.length ? entries : null;
}

export function normalizeExpected(expected) {
    if (!expected || typeof expected !== 'object') {
        return { kind: 'freeform', description: String(expected || 'the step is completed as described') };
    }
    const e = { ...expected };
    e.kind = String(e.kind || 'freeform');
    if (e.kind === 'freeform' && !e.description) {
        e.description = 'the step is completed as described';
    }
    if (e.item) e.item = String(e.item);
    if (e.block) e.block = String(e.block);
    if (e.entity) e.entity = String(e.entity);
    return e;
}

export class Project {
    constructor(data = {}) {
        this.id = data.id || `p${Date.now().toString(36)}`;
        this.goal = String(data.goal || '');
        this.summary = data.summary || '';
        this.constraints = Array.isArray(data.constraints) ? [...data.constraints] : [];
        this.completionCriteria = data.completionCriteria || data.completion_criteria || '';
        this.steps = (data.steps || []).map((s) => new PlanStep(s));
        this.status = data.status || PROJECT.PLANNING;
        this.iteration = data.iteration || 1;
        this.createdAt = data.createdAt || Date.now();
        this.updatedAt = data.updatedAt || this.createdAt;
        this.history = Array.isArray(data.history) ? [...data.history] : [];
    }

    touch(note = null) {
        this.updatedAt = Date.now();
        if (note) this.history.push({ at: this.updatedAt, note });
    }

    getStep(id) {
        return this.steps.find((s) => s.id === id) || null;
    }

    /**
     * The next executable step: open, in plan order, with all dependencies
     * satisfied (done or skipped). Returns null when nothing is runnable.
     */
    nextStep() {
        const satisfied = new Set(this.steps.filter((s) =>
            s.status === STEP.DONE || s.status === STEP.SKIPPED).map((s) => s.id));
        return this.steps.find((s) => {
            if (!s.isOpen()) return false;
            return s.dependsOn.every((dep) => satisfied.has(dep));
        }) || null;
    }

    /** Open step whose dependencies are not all done — i.e. blocked by plan shape. */
    dependencyBlocked() {
        const done = new Set(this.steps.filter((s) =>
            s.status === STEP.DONE || s.status === STEP.SKIPPED).map((s) => s.id));
        return this.steps.find((s) => s.isOpen() && !s.dependsOn.every((d) => done.has(d))) || null;
    }

    markActive(step) {
        step.status = STEP.ACTIVE;
        step.attempts += 1;
        step.startedAt = step.startedAt || Date.now();
        this.status = PROJECT.ACTIVE;
        this.touch(`step active: ${step.title}`);
    }

    markDone(step, observation = null) {
        step.status = STEP.DONE;
        step.finishedAt = Date.now();
        if (observation) step.observation = observation;
        this.touch(`step done: ${step.title}`);
        this.refreshStatus();
    }

    markFailed(step, note = null, observation = null) {
        step.status = STEP.FAILED;
        step.finishedAt = Date.now();
        step.criticNote = note;
        if (observation) step.observation = observation;
        this.touch(`step failed: ${step.title}${note ? ` (${note})` : ''}`);
    }

    markBlocked(step, note = null) {
        step.status = STEP.BLOCKED;
        step.finishedAt = Date.now();
        step.criticNote = note;
        this.status = PROJECT.PAUSED;
        this.touch(`step blocked: ${step.title}${note ? ` (${note})` : ''}`);
    }

    /** Merge a replanned step list, preserving status/attempts of steps by id. */
    replaceRemaining(newSteps, reason = 'replanned') {
        const kept = this.steps.filter((s) =>
            s.status === STEP.DONE || s.status === STEP.SKIPPED);
        const keptIds = new Set(kept.map((s) => s.id));
        for (const step of newSteps) {
            if (!(step instanceof PlanStep)) throw new Error('replaceRemaining expects PlanStep instances');
            // Dangling dependency on a removed step -> drop it.
            step.dependsOn = step.dependsOn.filter((dep) => keptIds.has(dep) || newSteps.some((n) => n.id === dep));
        }
        this.steps = [...kept, ...newSteps];
        this.iteration += 1;
        this.status = PROJECT.ACTIVE;
        this.touch(`plan revised (${reason}); ${kept.length} step(s) kept, ${newSteps.length} remaining`);
    }

    refreshStatus() {
        if (this.steps.length === 0) return;
        if (this.steps.every((s) => s.status === STEP.DONE || s.status === STEP.SKIPPED)) {
            this.status = PROJECT.DONE;
            this.touch('project complete');
        }
    }

    progress() {
        const total = this.steps.length;
        const done = this.steps.filter((s) => s.status === STEP.DONE || s.status === STEP.SKIPPED).length;
        const pct = total ? Math.round((done / total) * 100) : 0;
        return { total, done, pct };
    }

    render() {
        const icon = {
            [STEP.DONE]: '[x]', [STEP.ACTIVE]: '[>]', [STEP.PENDING]: '[ ]',
            [STEP.FAILED]: '[!]', [STEP.BLOCKED]: '[x-blocked]', [STEP.SKIPPED]: '[~]',
        };
        const lines = [
            `Project: ${this.goal}${this.summary ? ` — ${this.summary}` : ''}`,
            `Status: ${this.status}, progress: ${this.progress().done}/${this.progress().total} (${this.progress().pct}%), plan revision ${this.iteration}`,
        ];
        for (const s of this.steps) {
            lines.push(`  ${icon[s.status] || '[?]'} ${s.title}${s.attempts > 1 ? ` (attempt ${s.attempts})` : ''}`);
            if (s.status === STEP.BLOCKED || s.status === STEP.FAILED) {
                if (s.criticNote) lines.push(`        note: ${s.criticNote}`);
            }
        }
        return lines.join('\n');
    }

    toJSON() {
        return {
            id: this.id,
            goal: this.goal,
            summary: this.summary,
            constraints: this.constraints,
            completionCriteria: this.completionCriteria,
            steps: this.steps.map((s) => s.toJSON()),
            status: this.status,
            iteration: this.iteration,
            createdAt: this.createdAt,
            updatedAt: this.updatedAt,
            history: this.history,
        };
    }

    static fromJSON(data) {
        return new Project(data);
    }
}

/**
 * Validate/normalize a raw planner JSON object. Throws PlanValidationError
 * with all problems at once so the caller can ask the model once to fix them.
 */
export class PlanValidationError extends Error {
    constructor(problems, raw) {
        super(`Invalid plan: ${problems.join('; ')}`);
        this.problems = problems;
        this.raw = raw;
    }
}

export function stepsFromJSON(rawSteps, { repairDeps = true } = {}) {
    const problems = [];
    if (!Array.isArray(rawSteps) || rawSteps.length === 0) {
        return { steps: [], problems: ['steps must be a non-empty array'] };
    }
    if (rawSteps.length > 40) problems.push(`plan has ${rawSteps.length} steps, using the first 40`);

    const parsed = rawSteps.slice(0, 40).map((raw, i) => {
        if (typeof raw === 'string') raw = { title: raw, instruction: raw };
        const title = String(raw.title || raw.instruction || `Step ${i + 1}`).trim();
        const instruction = String(raw.instruction || title).trim();
        if (!instruction) problems.push(`step ${i + 1} has no instruction`);
        const rawDeps = Array.isArray(raw.depends_on) ? raw.depends_on :
            (Array.isArray(raw.dependsOn) ? raw.dependsOn : []);
        const { entries: deltaEntries, problems: deltaProblems } = normalizeDelta(raw.expected_delta);
        for (const p of deltaProblems) if (!p.includes('not verifiable')) problems.push(p);
        return {
            title, instruction, expected: normalizeExpected(raw.expected),
            deltaEntries, rawDeps: rawDeps.map(String),
        };
    });

    // Model-facing dependencies are 1-based ordinals ("step 3"); map them to
    // stable internal ids. Ordinals remain stable across replans for kept steps
    // because completed steps are emitted first, in their original order.
    const steps = parsed.map((p) => new PlanStep({
        title: p.title,
        instruction: p.instruction,
        expected: p.expected,
        expectedDelta: p.deltaEntries,
    }));
    const idByOrdinal = new Map(steps.map((s, i) => [String(i + 1), s.id]));
    for (let i = 0; i < steps.length; i++) {
        const mapped = [];
        for (const dep of parsed[i].rawDeps) {
            if (idByOrdinal.has(dep) && dep !== String(i + 1)) {
                mapped.push(idByOrdinal.get(dep));
            } else {
                problems.push(`step ${i + 1} has invalid dependency "${dep}"`);
            }
        }
        steps[i].dependsOn = repairDeps ? mapped : parsed[i].rawDeps;
    }

    if (hasDependencyCycle(steps)) problems.push('dependency cycle detected; dependencies ignored by runner');
    return { steps, problems };
}

export function hasDependencyCycle(steps) {
    const byId = new Map(steps.map((s) => [s.id, s]));
    const WHITE = 0, GRAY = 1, BLACK = 2;
    const color = new Map(steps.map((s) => [s.id, WHITE]));
    const visit = (id) => {
        color.set(id, GRAY);
        const step = byId.get(id);
        if (!step) return false;
        for (const dep of step.dependsOn) {
            const c = color.get(dep);
            if (c === GRAY) return true;
            if (c === WHITE && visit(dep)) return true;
        }
        color.set(id, BLACK);
        return false;
    };
    for (const s of steps) {
        if (color.get(s.id) === WHITE && visit(s.id)) return true;
    }
    return false;
}

/** Build a Project from validated planner JSON. */
export function projectFromGoal(goal, raw) {
    const { steps, problems } = stepsFromJSON(raw.steps);
    if (steps.length === 0 || problems.some((p) => p.includes('non-empty') || p.includes('cycle'))) {
        throw new PlanValidationError(problems.length ? problems : ['no usable steps'], raw);
    }
    const project = new Project({
        goal,
        summary: String(raw.summary || '').slice(0, 300),
        constraints: Array.isArray(raw.constraints) ? raw.constraints.map(String).slice(0, 10) : [],
        completionCriteria: String(raw.completion_criteria || raw.completionCriteria || '').slice(0, 500),
        steps,
        status: PROJECT.ACTIVE,
    });
    project.touch('plan created');
    return { project, warnings: problems };
}

/** Persistence for the single active project of a bot. */
export class ProjectStore {
    constructor(botName, dir = `./bots`) {
        this.dir = path.join(dir, botName);
        this.fp = path.join(this.dir, 'active_project.json');
    }

    save(project) {
        fs.mkdirSync(this.dir, { recursive: true });
        fs.writeFileSync(this.fp, JSON.stringify(project.toJSON(), null, 2));
    }

    load() {
        try {
            if (!fs.existsSync(this.fp)) return null;
            return Project.fromJSON(JSON.parse(fs.readFileSync(this.fp, 'utf8')));
        } catch (err) {
            console.error(`[planning] failed to load active project: ${err.message}`);
            return null;
        }
    }

    clear() {
        try {
            if (fs.existsSync(this.fp)) fs.unlinkSync(this.fp);
        } catch (err) {
            console.error(`[planning] failed to clear project file: ${err.message}`);
        }
    }
}
