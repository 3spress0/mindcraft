/**
 * replay.js — replayable event logs for deterministic benchmark reproduction.
 *
 * Records full execution trace with seed, scenario, initial world, injections,
 * bot states, and step outcomes. Allows exact reproduction of failed runs.
 */

import fs from 'fs';
import path from 'path';

export class ReplayLogger {
    constructor({ runId = null, scenario = null, seed = null } = {}) {
        this.runId = runId || `replay_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
        this.scenario = scenario;
        this.seed = seed || Math.floor(Math.random() * 1e9);
        this.startedAt = Date.now();
        this.events = [];
        this.states = [];
        this.injections = [];
        this.steps = [];
        this.initialWorld = null;
        this.finalMetrics = null;
    }

    setInitialWorld(world) {
        this.initialWorld = JSON.parse(JSON.stringify(world));
        this.log('initial_world', { world: this.initialWorld });
    }

    log(type, data = {}) {
        this.events.push({
            at: Date.now(),
            elapsed: Date.now() - this.startedAt,
            type,
            ...data,
        });
    }

    recordInjection(event, step, phase) {
        const record = {
            at: Date.now(),
            elapsed: Date.now() - this.startedAt,
            eventId: event.id,
            eventType: event.type,
            phase,
            stepTitle: step.title,
            stepIndex: step._index || null,
            data: event.data,
        };
        this.injections.push(record);
        this.log('injection', record);
    }

    recordState(label, bot, worldModel = null) {
        const state = {
            at: Date.now(),
            elapsed: Date.now() - this.startedAt,
            label,
            bot: {
                position: { ...bot._pos },
                health: bot.health,
                food: bot.food,
                inventory: bot.getInventory(),
                blocks: Array.from(bot._blocks.entries()).slice(0, 100), // sample first 100
            },
            worldModel: worldModel ? {
                facts: worldModel.facts?.length || 0,
                resources: worldModel.query?.('resource')?.length || 0,
            } : null,
        };
        this.states.push(state);
        this.log('state', { label, position: state.bot.position, health: state.bot.health });
    }

    recordStep(step, outcome, before, after) {
        const record = {
            at: Date.now(),
            elapsed: Date.now() - this.startedAt,
            stepTitle: step.title,
            stepIndex: step._index || null,
            attempts: step.attempts,
            outcome: outcome.outcome,
            failureClass: outcome.failureClass,
            reasoning: outcome.reasoning,
            before: before ? {
                position: before.position,
                health: before.health,
                inventory: before.inventory,
            } : null,
            after: after ? {
                position: after.position,
                health: after.health,
                inventory: after.inventory,
            } : null,
        };
        this.steps.push(record);
        this.log('step', { title: step.title, outcome: outcome.outcome, failureClass: outcome.failureClass });
    }

    recordRecovery(decision, step) {
        this.log('recovery', {
            stepTitle: step.title,
            action: decision.action,
            reason: decision.reason,
            evidence: decision.evidence,
        });
    }

    setFinalMetrics(metrics) {
        this.finalMetrics = metrics.summary ? metrics.summary() : metrics;
        this.log('final_metrics', this.finalMetrics);
    }

    toJSON() {
        return {
            runId: this.runId,
            scenario: this.scenario?.name || this.scenario,
            scenarioData: this.scenario?.toJSON ? this.scenario.toJSON() : this.scenario,
            seed: this.seed,
            startedAt: this.startedAt,
            endedAt: Date.now(),
            initialWorld: this.initialWorld,
            events: this.events,
            injections: this.injections,
            states: this.states,
            steps: this.steps,
            finalMetrics: this.finalMetrics,
            version: 1,
        };
    }

    save(baseDir = './benchmark_results') {
        fs.mkdirSync(baseDir, { recursive: true });
        const fp = path.join(baseDir, `replay_${this.runId}.json`);
        fs.writeFileSync(fp, JSON.stringify(this.toJSON(), null, 2));
        return fp;
    }

    static load(filePath) {
        if (!fs.existsSync(filePath)) return null;
        return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    }

    static loadByRunId(baseDir, runId) {
        const fp = path.join(baseDir, `replay_${runId}.json`);
        return ReplayLogger.load(fp);
    }
}

export class ReplayPlayer {
    constructor(replayData) {
        this.replay = replayData;
        this.currentIndex = 0;
    }

    static fromFile(filePath) {
        const data = ReplayLogger.load(filePath);
        if (!data) return null;
        return new ReplayPlayer(data);
    }

    /**
     * Reconstruct scenario from replay data.
     */
    getScenario() {
        return this.replay.scenarioData;
    }

    /**
     * Get initial world state.
     */
    getInitialWorld() {
        return this.replay.initialWorld;
    }

    /**
     * Get all injections in order.
     */
    getInjections() {
        return this.replay.injections;
    }

    /**
     * Get step-by-step execution trace.
     */
    getSteps() {
        return this.replay.steps;
    }

    /**
     * Check if replay indicates a failure that should be reproduced.
     */
    isFailure() {
        return this.replay.finalMetrics && !this.replay.finalMetrics.completion;
    }

    /**
     * Generate reproduction script.
     * Returns a JS code snippet that can recreate the scenario.
     */
    generateReproScript() {
        const scenarioName = this.replay.scenario;
        const seed = this.replay.seed;
        const runId = this.replay.runId;

        return `
// Reproduction script for failed run ${runId}
import { createScenario } from './src/agent/benchmark/scenarios/index.js';
import { BenchmarkHarness } from './src/agent/benchmark/harness.js';

const scenario = createScenario('${scenarioName}');
const harness = new BenchmarkHarness(scenario, {
    plannerModel: 'repro-${runId}',
    seed: ${seed},
    enableReplay: true,
    replayLogId: '${runId}',
});

const result = await harness.run();
console.log('Repro result:', result.metrics.toJSON());
console.log('Original failure:', ${this.isFailure()});
console.log('Repro success:', result.success);
`;
    }

    /**
     * Compare replay with a new run to check determinism.
     * @param {object} newMetrics - metrics from new run
     * @returns {object} comparison
     */
    compareWithNewRun(newMetrics) {
        const orig = this.replay.finalMetrics;
        const current = newMetrics.summary ? newMetrics.summary() : newMetrics;

        const differences = [];

        if (orig.completion !== current.completion) {
            differences.push({ field: 'completion', original: orig.completion, current: current.completion });
        }
        if (orig.total_steps !== current.total_steps) {
            differences.push({ field: 'total_steps', original: orig.total_steps, current: current.total_steps });
        }
        if (orig.successful_steps !== current.successful_steps) {
            differences.push({ field: 'successful_steps', original: orig.successful_steps, current: current.successful_steps });
        }
        if ((orig.score?.total || 0) !== (current.score?.total || 0)) {
            differences.push({ field: 'score', original: orig.score?.total, current: current.score?.total });
        }

        return {
            isDeterministic: differences.length === 0,
            differences,
            original: orig,
            current,
        };
    }

    /**
     * Generate human-readable report of the replay.
     */
    generateReport() {
        const lines = [];
        lines.push(`# Replay Report: ${this.replay.runId}`);
        lines.push('');
        lines.push(`**Scenario:** ${this.replay.scenario}`);
        lines.push(`**Seed:** ${this.replay.seed}`);
        lines.push(`**Started:** ${new Date(this.replay.startedAt).toISOString()}`);
        lines.push(`**Completion:** ${this.replay.finalMetrics?.completion ? '✓' : '✗'} (${this.replay.finalMetrics?.completionPct || 0}%)`);
        lines.push(`**Score:** ${this.replay.finalMetrics?.score?.total || 0}/100`);
        lines.push('');

        lines.push('## Steps');
        for (const step of this.replay.steps) {
            const icon = step.outcome === 'success' ? '✓' : step.outcome === 'failed' ? '✗' : '○';
            lines.push(`- ${icon} ${step.stepTitle}: ${step.outcome} (${step.failureClass || 'none'}) - ${step.reasoning || ''}`);
        }
        lines.push('');

        lines.push('## Injections');
        for (const inj of this.replay.injections) {
            lines.push(`- [${inj.phase}] ${inj.eventType} (${inj.eventId}) at ${inj.stepTitle}`);
        }
        lines.push('');

        lines.push('## Final Metrics');
        lines.push(`- Successful: ${this.replay.finalMetrics?.successful_steps}/${this.replay.finalMetrics?.total_steps}`);
        lines.push(`- Failed: ${this.replay.finalMetrics?.failed_steps}, Retries: ${this.replay.finalMetrics?.retries}, Replans: ${this.replay.finalMetrics?.replans}`);
        lines.push(`- Deaths: ${this.replay.finalMetrics?.deaths}, Waste: ${this.replay.finalMetrics?.resource_waste}`);
        lines.push(`- Time: ${this.replay.finalMetrics?.execution_time}ms, LLM calls: ${this.replay.finalMetrics?.LLM_calls}`);

        return lines.join('\n');
    }
}

export function createReplayLogger(opts) {
    return new ReplayLogger(opts);
}
