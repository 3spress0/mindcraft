/**
 * project.js — hierarchical domain model for the planning loop.
 *
 *   Project
 *     └── Phase (Preparation / Construction / Verification ...)
 *           └── task step
 *                 └── optional sub-task steps (parent linkage)
 *
 * Only LEAF steps (no children) are executed; parent/group steps roll their
 * status up from their children. Phases order execution: among runnable leaves
 * the runner always takes the one in the earliest phase, so work proceeds
 * phase by phase while explicit dependencies still gate individual steps.
 *
 * Plans without phases remain valid: they get a single default phase, keeping
 * the old flat format (and persisted projects) fully compatible.
 *
 * Everything here is pure data + deterministic transitions. The LLM only
 * supplies JSON; verification specs are interpreted by observer.js and
 * transitions.js; the PlanRunner owns control flow.
 *
 * Step status lifecycle (leaves):
 *   pending ─► active ─► done
 *                │
 *                ├─► failed   (attempts remain -> retried)
 *                └─► blocked  (recovery paused / needs a human)
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

const DEFAULT_PHASE_ID = 'phase_main';

let stepCounter = 0;
function newStepId() {
    stepCounter = (stepCounter + 1) % 1_000_000;
    return `s${Date.now().toString(36)}_${stepCounter}`;
}

let phaseCounter = 0;
function newPhaseId() {
    phaseCounter = (phaseCounter + 1) % 1_000_000;
    return `ph${Date.now().toString(36)}_${phaseCounter}`;
}

export class Phase {
    constructor(data = {}) {
        this.id = data.id || newPhaseId();
        this.title = String(data.title || 'Phase');
        this.order = Number.isFinite(Number(data.order)) ? Number(data.order) : 0;
    }

    toJSON() {
        return { id: this.id, title: this.title, order: this.order };
    }
}

export class PlanStep {
    constructor(data = {}) {
        this.id = data.id || newStepId();
        this.title = String(data.title || 'Untitled step');
        this.instruction = String(data.instruction || data.title || '');
        this.expected = normalizeExpected(data.expected);
        this.expectedDelta = normalizeStepDelta(data.expectedDelta ?? data.expected_delta);
        this.phaseId = data.phaseId || DEFAULT_PHASE_ID;
        this.parentId = data.parentId || null;
        this.dependsOn = Array.isArray(data.dependsOn) ? [...data.dependsOn] :
            (Array.isArray(data.depends_on) ? [...data.depends_on] : []);
        // Priority handling (GO list): urgent steps jump ahead of normal
        // work, background steps only run when nothing else is pending.
        const prio = String(data.priority || 'normal').toLowerCase();
        this.priority = ['urgent', 'normal', 'background'].includes(prio) ? prio : 'normal';
        this.status = data.status || STEP.PENDING;
        this.attempts = data.attempts || 0;
        this.observation = data.observation || null;
        this.criticNote = data.criticNote || null;
        this.lastRecovery = data.lastRecovery || data.last_recovery || null;
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
            phaseId: this.phaseId,
            parentId: this.parentId,
            dependsOn: this.dependsOn,
            priority: this.priority,
            status: this.status,
            attempts: this.attempts,
            observation: this.observation,
            criticNote: this.criticNote,
            last_recovery: this.lastRecovery,
            startedAt: this.startedAt,
            finishedAt: this.finishedAt,
        };
    }
}

/** Accept normalized entry arrays, model JSON maps, or nothing. */
export function normalizeStepDelta(raw) {
    if (!raw) return null;
    const { entries, problems } = normalizeDelta(raw);
    for (const p of problems) {
        if (!p.includes('not verifiable')) console.warn(`[planning] ${p}`);
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

        const rawPhases = Array.isArray(data.phases) && data.phases.length ?
            data.phases.map((p, i) => new Phase({ ...p, order: p.order ?? i })) :
            [new Phase({ id: DEFAULT_PHASE_ID, title: 'Plan', order: 0 })];
        const phaseIds = new Set(rawPhases.map((p) => p.id));
        this.phases = rawPhases;
        // Repair steps pointing at unknown phases.
        for (const step of this.steps) {
            if (!phaseIds.has(step.phaseId)) step.phaseId = this.phases[0].id;
            if (step.parentId && !this.steps.some((s) => s.id === step.parentId)) step.parentId = null;
        }

        this.status = data.status || PROJECT.PLANNING;
        this.iteration = data.iteration || 1;
        this.createdAt = data.createdAt || Date.now();
        this.updatedAt = data.updatedAt || this.createdAt;
        this.history = Array.isArray(data.history) ? [...data.history] : [];
        this.deriveStatuses();
    }

    touch(note = null) {
        this.updatedAt = Date.now();
        if (note) this.history.push({ at: this.updatedAt, note });
    }

    getStep(id) {
        return this.steps.find((s) => s.id === id) || null;
    }

    phaseById(id) {
        return this.phases.find((p) => p.id === id) || this.phases[0];
    }

    phaseOrder(phaseId) {
        return this.phaseById(phaseId).order;
    }

    childrenOf(parentId) {
        return this.steps.filter((s) => s.parentId === parentId);
    }

    /** Steps with no children — the only steps that actually execute. */
    leaves() {
        const parentIds = new Set(this.steps.filter((s) => s.parentId).map((s) => s.parentId));
        return this.steps.filter((s) => !parentIds.has(s.id));
    }

    /** Group containers (have children); group steps are never sent to the executor. */
    isContainer(step) {
        return this.steps.some((s) => s.parentId === step.id);
    }

    /**
     * The next executable LEAF: open, all dependencies satisfied, chosen from
     * the earliest phase (then plan order). Null when nothing is runnable.
     */
    nextStep() {
        const satisfied = new Set(this.steps.filter((s) =>
            s.status === STEP.DONE || s.status === STEP.SKIPPED).map((s) => s.id));
        const runnable = this.leaves().filter((s) =>
            s.isOpen() && s.dependsOn.every((dep) => satisfied.has(dep)));
        const PRIO = { urgent: 0, normal: 1, background: 2 };
        runnable.sort((a, b) => {
            const pr = (PRIO[a.priority] ?? 1) - (PRIO[b.priority] ?? 1);
            if (pr !== 0) return pr;
            const po = this.phaseOrder(a.phaseId) - this.phaseOrder(b.phaseId);
            if (po !== 0) return po;
            return this.steps.indexOf(a) - this.steps.indexOf(b);
        });
        return runnable[0] || null;
    }

    /** Open leaf whose dependencies can never all be satisfied. */
    dependencyBlocked() {
        const done = new Set(this.steps.filter((s) =>
            s.status === STEP.DONE || s.status === STEP.SKIPPED).map((s) => s.id));
        return this.leaves().find((s) => s.isOpen() && !s.dependsOn.every((d) => done.has(d))) || null;
    }

    markActive(step) {
        step.status = STEP.ACTIVE;
        step.attempts += 1;
        step.startedAt = step.startedAt || Date.now();
        this.status = PROJECT.ACTIVE;
        this.touch(`step active: ${step.title}`);
        this.deriveStatuses();
    }

    markDone(step, observation = null) {
        step.status = STEP.DONE;
        step.finishedAt = Date.now();
        step.lastRecovery = null;
        if (observation) step.observation = observation;
        this.touch(`step done: ${step.title}`);
        this.deriveStatuses();
        this.refreshStatus();
    }

    markFailed(step, note = null, observation = null) {
        step.status = STEP.FAILED;
        step.finishedAt = Date.now();
        step.criticNote = note;
        if (observation) step.observation = observation;
        this.touch(`step failed: ${step.title}${note ? ` (${note})` : ''}`);
        this.deriveStatuses();
    }

    markBlocked(step, note = null) {
        step.status = STEP.BLOCKED;
        step.finishedAt = Date.now();
        step.criticNote = note;
        this.status = PROJECT.PAUSED;
        this.touch(`step blocked: ${step.title}${note ? ` (${note})` : ''}`);
        this.deriveStatuses();
    }

    /** Roll container/group statuses up from their children. */
    deriveStatuses() {
        const containers = this.steps.filter((s) => this.isContainer(s));
        // Children are emitted after parents; iterate reverse so nested
        // groups settle before their parents read them.
        for (let i = containers.length - 1; i >= 0; i--) {
            const c = containers[i];
            const kids = this.childrenOf(c.id);
            if (!kids.length) continue;
            if (kids.every((k) => k.status === STEP.DONE || k.status === STEP.SKIPPED)) c.status = STEP.DONE;
            else if (kids.some((k) => k.status === STEP.BLOCKED)) c.status = STEP.BLOCKED;
            else if (kids.some((k) => k.status === STEP.FAILED)) c.status = STEP.FAILED;
            else if (kids.some((k) => k.status === STEP.ACTIVE)) c.status = STEP.ACTIVE;
            else c.status = STEP.PENDING;
        }
    }

    /** Merge a replanned step list (with optional new phases), keeping completed work. */
    replaceRemaining(newSteps, reason = 'replanned', newPhases = null) {
        const kept = this.steps.filter((s) =>
            s.status === STEP.DONE || s.status === STEP.SKIPPED);
        const keptIds = new Set(kept.map((s) => s.id));

        // Map locally-generated phases of the replan onto project phases.
        const phaseIdMap = new Map();
        if (Array.isArray(newPhases) && newPhases.length) {
            newPhases.forEach((ph, i) => {
                ph.order = this.phases.length + i;
                this.phases.push(ph);
                phaseIdMap.set(ph.id, ph.id);
            });
        }
        const fallbackPhase = this.phases[0].id;

        for (const step of newSteps) {
            if (!(step instanceof PlanStep)) throw new Error('replaceRemaining expects PlanStep instances');
            if (phaseIdMap.has(step.phaseId)) step.phaseId = phaseIdMap.get(step.phaseId);
            else if (!this.phases.some((p) => p.id === step.phaseId)) step.phaseId = fallbackPhase;
            // Dangling dependency / parent on a removed step -> drop it.
            step.dependsOn = step.dependsOn.filter((dep) =>
                keptIds.has(dep) || newSteps.some((n) => n.id === dep));
            if (step.parentId &&
                !keptIds.has(step.parentId) && !newSteps.some((n) => n.id === step.parentId)) {
                step.parentId = null;
            }
        }
        this.steps = [...kept, ...newSteps];
        this.iteration += 1;
        this.status = PROJECT.ACTIVE;
        this.deriveStatuses();
        this.touch(`plan revised (${reason}); ${kept.length} step(s) kept, ${newSteps.length} remaining`);
    }

    refreshStatus() {
        const leaves = this.leaves();
        if (leaves.length === 0) return;
        if (leaves.every((s) => s.status === STEP.DONE || s.status === STEP.SKIPPED)) {
            this.status = PROJECT.DONE;
            this.deriveStatuses();
            this.touch('project complete');
        }
    }

    progress() {
        const leaves = this.leaves();
        const total = leaves.length;
        const done = leaves.filter((s) => s.status === STEP.DONE || s.status === STEP.SKIPPED).length;
        const pct = total ? Math.round((done / total) * 100) : 0;
        return { total, done, pct };
    }

    /** Progress within one phase, counting its leaves. */
    phaseProgress(phase) {
        const leaves = this.leaves().filter((s) => s.phaseId === phase.id);
        const done = leaves.filter((s) => s.status === STEP.DONE || s.status === STEP.SKIPPED).length;
        return { total: leaves.length, done, pct: leaves.length ? Math.round((done / leaves.length) * 100) : 100 };
    }

    render() {
        const icon = {
            [STEP.DONE]: '[x]', [STEP.ACTIVE]: '[>]', [STEP.PENDING]: '[ ]',
            [STEP.FAILED]: '[!]', [STEP.BLOCKED]: '[x-blocked]', [STEP.SKIPPED]: '[~]',
        };
        const p = this.progress();
        const lines = [
            `Project: ${this.goal}${this.summary ? ` — ${this.summary}` : ''}`,
            `Status: ${this.status}, progress: ${p.done}/${p.total} (${p.pct}%), plan revision ${this.iteration}`,
        ];
        const multiPhase = this.phases.length > 1;
        for (const phase of [...this.phases].sort((a, b) => a.order - b.order)) {
            const steps = this.steps.filter((s) => s.phaseId === phase.id);
            if (!steps.length) continue;
            const pp = this.phaseProgress(phase);
            if (multiPhase) lines.push(`${phase.title} (${pp.done}/${pp.total})`);
            const rendered = new Set();
            const renderStep = (step, depth) => {
                if (rendered.has(step.id)) return;
                rendered.add(step.id);
                const indent = multiPhase ? '    ' : '  ';
                const prefix = '  '.repeat(depth);
                const container = this.isContainer(step);
                const marker = container ? '▸' : icon[step.status] || '[?]';
                lines.push(`${indent}${prefix}${marker} ${step.title}${step.attempts > 1 ? ` (attempt ${step.attempts})` : ''}`);
                if (step.status === STEP.BLOCKED || step.status === STEP.FAILED) {
                    if (step.lastRecovery) {
                        lines.push(`${indent}${prefix}    recovery: ${step.lastRecovery.action} (${step.lastRecovery.reason})`);
                        for (const e of (step.lastRecovery.evidence || []).slice(0, 3)) {
                            lines.push(`${indent}${prefix}      • ${e}`);
                        }
                    }
                    if (step.criticNote) lines.push(`${indent}${prefix}    note: ${step.criticNote}`);
                }
                for (const child of this.childrenOf(step.id)) renderStep(child, depth + 1);
            };
            for (const step of steps) {
                // Top-level walk: containers and leaves with no parent in this phase.
                if (!step.parentId || !steps.some((s) => s.id === step.parentId)) renderStep(step, 0);
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
            phases: this.phases.map((p) => p.toJSON()),
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

export class PlanValidationError extends Error {
    constructor(problems, raw) {
        super(`Invalid plan: ${problems.join('; ')}`);
        this.problems = problems;
        this.raw = raw;
    }
}

/**
 * Parse model JSON into phases + steps. Model references are 1-based ORDINALS:
 *   phase:  2  -> second phase in raw.phases
 *   parent: 1  -> first step in rawSteps (must be earlier than the child)
 *   depends_on: ["3"] -> third step in rawSteps
 */
export function stepsFromJSON(rawSteps, rawPhases = null, { repairDeps = true } = {}) {
    const problems = [];
    if (!Array.isArray(rawSteps) || rawSteps.length === 0) {
        return { steps: [], phases: [], problems: ['steps must be a non-empty array'] };
    }
    if (rawSteps.length > 40) problems.push(`plan has ${rawSteps.length} steps, using the first 40`);

    const phases = Array.isArray(rawPhases) && rawPhases.length ?
        rawPhases.slice(0, 12).map((p, i) => new Phase({
            title: typeof p === 'string' ? p : String(p.title || `Phase ${i + 1}`),
            order: i,
        })) :
        [new Phase({ id: DEFAULT_PHASE_ID, title: 'Plan', order: 0 })];

    const parsed = rawSteps.slice(0, 40).map((raw, i) => {
        if (typeof raw === 'string') raw = { title: raw, instruction: raw };
        const title = String(raw.title || raw.instruction || `Step ${i + 1}`).trim();
        const instruction = String(raw.instruction || title).trim();
        if (!instruction) problems.push(`step ${i + 1} has no instruction`);
        const rawDeps = Array.isArray(raw.depends_on) ? raw.depends_on :
            (Array.isArray(raw.dependsOn) ? raw.dependsOn : []);
        return {
            title,
            instruction,
            expected: normalizeExpected(raw.expected),
            deltaEntries: normalizeDelta(raw.expected_delta).entries,
            rawDeps: rawDeps.map(String),
            rawPhase: raw.phase != null ? raw.phase : (raw.phase_id != null ? raw.phase_id : null),
            rawParent: raw.parent != null ? String(raw.parent) : null,
            ordinal: i,
        };
    });

    const steps = parsed.map((p) => new PlanStep({
        title: p.title,
        instruction: p.instruction,
        expected: p.expected,
        expectedDelta: p.deltaEntries,
        phaseId: phases[0].id,
    }));
    const idByOrdinal = new Map(steps.map((s, i) => [String(i + 1), s.id]));

    // Phase ordinal mapping.
    for (let i = 0; i < steps.length; i++) {
        const rawPhase = parsed[i].rawPhase;
        if (rawPhase != null) {
            const idx = Number(rawPhase) - 1;
            if (Number.isInteger(idx) && idx >= 0 && idx < phases.length) {
                steps[i].phaseId = phases[idx].id;
            } else if (typeof rawPhase === 'string') {
                const match = phases.find((p) => p.title.toLowerCase() === rawPhase.toLowerCase());
                if (match) steps[i].phaseId = match.id;
                else problems.push(`step ${i + 1} references unknown phase "${rawPhase}"`);
            } else {
                problems.push(`step ${i + 1} references invalid phase "${rawPhase}"`);
            }
        }
    }

    // Parent linkage: parents must precede their children.
    for (let i = 0; i < steps.length; i++) {
        const rawParent = parsed[i].rawParent;
        if (rawParent != null) {
            const parentIdx = Number(rawParent) - 1;
            if (Number.isInteger(parentIdx) && parentIdx >= 0 && parentIdx < i) {
                steps[i].parentId = steps[parentIdx].id;
                // A group step is a container; it does not itself execute, so
                // verification contracts belong on its leaves.
                const parent = steps[parentIdx];
                if (parent.expected?.kind !== 'freeform') {
                    problems.push(`step ${parentIdx + 1} has sub-tasks; its expectation is rolled up and ignored`);
                }
                parent.expected = { kind: 'freeform', description: 'all sub-tasks completed' };
                parent.expectedDelta = null;
            } else {
                problems.push(`step ${i + 1} has invalid parent "${rawParent}" (must reference an earlier step)`);
            }
        }
    }

    // Dependency ordinal mapping.
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
    return { steps, phases, problems };
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
    const { steps, phases, problems } = stepsFromJSON(raw.steps, raw.phases);
    if (steps.length === 0 || problems.some((p) => p.includes('non-empty') || p.includes('cycle'))) {
        throw new PlanValidationError(problems.length ? problems : ['no usable steps'], raw);
    }
    const project = new Project({
        goal,
        summary: String(raw.summary || '').slice(0, 300),
        constraints: Array.isArray(raw.constraints) ? raw.constraints.map(String).slice(0, 10) : [],
        completionCriteria: String(raw.completion_criteria || raw.completionCriteria || '').slice(0, 500),
        phases,
        steps,
        status: PROJECT.ACTIVE,
    });
    project.touch('plan created');
    return { project, warnings: problems };
}

/** Persistence for the single active project of a bot. */
export class ProjectStore {
    constructor(botName, dir = './bots') {
        this.dir = path.join(dir, botName);
        this.fp = path.join(this.dir, 'active_project.json');
    }

    checkpointPath() {
        return path.join(this.dir, 'plan_checkpoint.json');
    }

    save(project) {
        fs.mkdirSync(this.dir, { recursive: true });
        // atomic write: a crash mid-save must not corrupt the project
        const tmp = `${this.fp}.${process.pid}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify(project.toJSON(), null, 2));
        fs.renameSync(tmp, this.fp);
    }

    /** Persist a lightweight progress checkpoint (see runner.writeCheckpoint). */
    saveCheckpoint(checkpoint) {
        fs.mkdirSync(this.dir, { recursive: true });
        const fp = this.checkpointPath();
        const tmp = `${fp}.${process.pid}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify(checkpoint, null, 2));
        fs.renameSync(tmp, fp);
    }

    loadCheckpoint() {
        try {
            if (!fs.existsSync(this.checkpointPath())) return null;
            return JSON.parse(fs.readFileSync(this.checkpointPath(), 'utf8'));
        } catch {
            return null;
        }
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
            if (fs.existsSync(this.checkpointPath())) fs.unlinkSync(this.checkpointPath());
        } catch (err) {
            console.error(`[planning] failed to clear project file: ${err.message}`);
        }
    }
}
