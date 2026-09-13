/**
 * scenario.js — data-driven benchmark scenario definition.
 *
 * Scenario shape:
 *   scenario
 *     initial_world
 *     project
 *     injected_events[]
 *     expected_recoveries[]
 *     success_condition
 */

export const EVENT_TYPES = {
    MISSING_RESOURCES: 'missing_resources',
    DEPLETED_DEPOSITS: 'depleted_deposits',
    INTERRUPTED_EXECUTION: 'interrupted_execution',
    RESTART_RESUME: 'restart_resume',
    DESTROYED_CONSTRUCTION_BLOCKS: 'destroyed_construction_blocks',
    THREATS_LOW_HEALTH: 'threats_low_health',
    UNAVAILABLE_PERMISSIONS: 'unavailable_permissions',
};

export const TRIGGER_AT = {
    BEFORE_STEP: 'before_step',
    AFTER_STEP: 'after_step',
    ON_ATTEMPT: 'on_attempt',
    BEFORE_RUN: 'before_run',
    AFTER_RUN: 'after_run',
};

export class Scenario {
    constructor({
        name,
        description = '',
        initial_world = {},
        project = {},
        injected_events = [],
        expected_recoveries = [],
        success_condition = { kind: 'all_steps_done' },
    } = {}) {
        if (!name) throw new Error('Scenario requires a name');
        this.name = String(name);
        this.description = String(description);
        this.initial_world = normalizeInitialWorld(initial_world);
        this.project = normalizeProject(project);
        this.injected_events = injected_events.map(normalizeEvent);
        this.expected_recoveries = expected_recoveries.map(normalizeExpectedRecovery);
        this.success_condition = normalizeSuccessCondition(success_condition);
    }

    validate() {
        const problems = [];
        if (!this.name) problems.push('missing name');
        if (!this.project || (!this.project.goal && !this.project.steps)) problems.push('project needs goal or steps');
        for (const ev of this.injected_events) {
            if (!Object.values(EVENT_TYPES).includes(ev.type)) problems.push(`unknown event type ${ev.type} in ${ev.id}`);
            if (!Object.values(TRIGGER_AT).includes(ev.trigger.at)) problems.push(`unknown trigger ${ev.trigger.at} in ${ev.id}`);
        }
        return problems;
    }

    /**
     * Find events that should fire at a given point.
     * @param {string} at - trigger point
     * @param {object} ctx - { stepIndex, stepTitle, attempt, runPhase }
     */
    eventsAt(at, ctx = {}) {
        return this.injected_events.filter(ev => {
            if (ev.trigger.at !== at) return false;
            if (ev.trigger.stepIndex != null && ev.trigger.stepIndex !== ctx.stepIndex) return false;
            if (ev.trigger.stepTitle && ev.trigger.stepTitle !== ctx.stepTitle) return false;
            if (ev.trigger.attempt != null && ev.trigger.attempt !== ctx.attempt) return false;
            return true;
        });
    }

    toJSON() {
        return {
            name: this.name,
            description: this.description,
            initial_world: this.initial_world,
            project: this.project,
            injected_events: this.injected_events,
            expected_recoveries: this.expected_recoveries,
            success_condition: this.success_condition,
        };
    }

    static fromJSON(data) {
        return new Scenario(data);
    }
}

function normalizeInitialWorld(raw = {}) {
    return {
        inventory: raw.inventory || {},
        position: raw.position || { x: 0, y: 64, z: 0 },
        health: raw.health ?? 20,
        food: raw.food ?? 20,
        dimension: raw.dimension || 'overworld',
        world_model: raw.world_model || { resources: [], threats: [], locations: [], structures: [] },
        blocks: raw.blocks || {}, // map "x,y,z" -> blockName
        botVersion: raw.botVersion || null,
    };
}

function normalizeProject(raw = {}) {
    return {
        goal: raw.goal || '',
        summary: raw.summary || '',
        steps: Array.isArray(raw.steps) ? raw.steps : null, // deterministic plan JSON if provided
        phases: Array.isArray(raw.phases) ? raw.phases : null,
        construction: raw.construction || null, // optional schematic for damage detection
        position: raw.position || null,
        orientation: raw.orientation || 0,
    };
}

function normalizeEvent(raw = {}) {
    return {
        id: String(raw.id || `ev_${Math.random().toString(36).slice(2, 8)}`),
        trigger: {
            at: raw.trigger?.at || TRIGGER_AT.BEFORE_STEP,
            stepIndex: raw.trigger?.stepIndex ?? null,
            stepTitle: raw.trigger?.stepTitle ?? null,
            attempt: raw.trigger?.attempt ?? null,
        },
        type: String(raw.type),
        data: raw.data || {},
        description: raw.description || '',
    };
}

function normalizeExpectedRecovery(raw = {}) {
    return {
        eventId: raw.eventId || null,
        expectedAction: raw.expectedAction || null,
        expectedReason: raw.expectedReason || null,
        stepIndex: raw.stepIndex ?? null,
        description: raw.description || '',
    };
}

function normalizeSuccessCondition(raw = {}) {
    if (typeof raw === 'string') return { kind: raw };
    return {
        kind: raw.kind || 'all_steps_done',
        ...raw,
    };
}

/**
 * Evaluate success condition against a finished project and metrics.
 * @returns {boolean}
 */
export function checkSuccessCondition(condition, project, metrics) {
    switch (condition.kind) {
        case 'all_steps_done':
            return project ? project.status === 'done' || project.status === 'DONE' || metrics.completion : false;
        case 'pct_complete': {
            const need = condition.pct ?? 100;
            return (metrics.completionPct ?? 0) >= need;
        }
        case 'steps_done': {
            const need = condition.steps ?? [];
            const doneTitles = new Set((project?.steps || []).filter(s => s.status === 'done').map(s => s.title));
            return need.every(t => doneTitles.has(t));
        }
        case 'construction_intact': {
            // Check via metrics events: no construction_damaged at end
            const lastDamage = metrics.events.filter(e => e.type === 'construction_damaged').pop();
            const lastRepair = metrics.events.filter(e => e.type === 'construction_repaired').pop();
            if (!lastDamage) return true;
            if (!lastRepair) return false;
            return lastRepair.at > lastDamage.at;
        }
        case 'custom': {
            if (typeof condition.check === 'function') return condition.check(project, metrics);
            return false;
        }
        default:
            return metrics.completion;
    }
}
