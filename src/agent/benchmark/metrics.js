/**
 * metrics.js — benchmark metrics collection and persistence.
 *
 * Records at minimum:
 *   completion
 *   total_steps
 *   successful_steps
 *   failed_steps
 *   retries
 *   replans
 *   recovery_actions
 *   recovery_reasons
 *   interruptions
 *   resumes
 *   deaths
 *   resource_waste
 *   LLM_calls
 *   LLM_failures
 *   execution_time
 *
 * Persisted per run so different planners/models can be compared objectively.
 */

import fs from 'fs';
import path from 'path';

export class BenchmarkMetrics {
    constructor({ runId = null, scenarioName = 'unknown', plannerModel = 'unknown' } = {}) {
        this.runId = runId || `run_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
        this.scenarioName = scenarioName;
        this.plannerModel = plannerModel;
        this.startedAt = Date.now();
        this.endedAt = null;

        this.completion = false;
        this.completionPct = 0;
        this.total_steps = 0;
        this.successful_steps = 0;
        this.failed_steps = 0;
        this.retries = 0;
        this.replans = 0;
        this.recovery_actions = {}; // action -> count
        this.recovery_reasons = {}; // reason -> count
        this.interruptions = 0;
        this.resumes = 0;
        this.deaths = 0;
        this.resource_waste = 0; // estimated wasted items
        this.LLM_calls = 0;
        this.LLM_failures = 0;
        this.execution_time = 0;

        // Detailed traces for analysis
        this.steps = []; // { title, outcome, attempts, recovery }
        this.events = []; // { at, type, data }
        this.recoveryLog = []; // { step, action, reason, evidence }
    }

    recordStep({ title, outcome, attempts = 1, failed = false } = {}) {
        this.steps.push({ title, outcome, attempts, failed, at: Date.now() });
        if (failed) this.failed_steps += 1;
        else this.successful_steps += 1;
        if (attempts > 1) this.retries += (attempts - 1);
    }

    recordRecovery({ action, reason, evidence = [], stepTitle = null } = {}) {
        this.recovery_actions[action] = (this.recovery_actions[action] || 0) + 1;
        this.recovery_reasons[reason] = (this.recovery_reasons[reason] || 0) + 1;
        this.recoveryLog.push({ step: stepTitle, action, reason, evidence, at: Date.now() });
        if (action === 'replan') this.replans += 1;
    }

    recordInterruption(reason = 'unknown') {
        this.interruptions += 1;
        this.events.push({ at: Date.now(), type: 'interruption', reason });
    }

    recordResume() {
        this.resumes += 1;
        this.events.push({ at: Date.now(), type: 'resume' });
    }

    recordDeath(pos = null) {
        this.deaths += 1;
        this.events.push({ at: Date.now(), type: 'death', pos });
    }

    recordResourceWaste(amount = 1, item = null) {
        this.resource_waste += amount;
        if (item) this.events.push({ at: Date.now(), type: 'resource_waste', item, amount });
    }

    recordLLMCall(success = true) {
        this.LLM_calls += 1;
        if (!success) this.LLM_failures += 1;
    }

    recordEvent(type, data = {}) {
        this.events.push({ at: Date.now(), type, ...data });
    }

    setCompletion(completed, pct = 100, totalSteps = null) {
        this.completion = completed;
        this.completionPct = pct;
        if (totalSteps != null) this.total_steps = totalSteps;
    }

    finish() {
        this.endedAt = Date.now();
        this.execution_time = this.endedAt - this.startedAt;
        return this.summary();
    }

    summary() {
        return {
            runId: this.runId,
            scenario: this.scenarioName,
            plannerModel: this.plannerModel,
            startedAt: this.startedAt,
            endedAt: this.endedAt,
            execution_time: this.execution_time,
            completion: this.completion,
            completionPct: this.completionPct,
            total_steps: this.total_steps,
            successful_steps: this.successful_steps,
            failed_steps: this.failed_steps,
            retries: this.retries,
            replans: this.replans,
            recovery_actions: { ...this.recovery_actions },
            recovery_reasons: { ...this.recovery_reasons },
            interruptions: this.interruptions,
            resumes: this.resumes,
            deaths: this.deaths,
            resource_waste: this.resource_waste,
            LLM_calls: this.LLM_calls,
            LLM_failures: this.LLM_failures,
        };
    }

    toJSON() {
        return {
            ...this.summary(),
            steps: this.steps,
            events: this.events,
            recoveryLog: this.recoveryLog,
        };
    }

    static fromJSON(data) {
        const m = new BenchmarkMetrics({ runId: data.runId, scenarioName: data.scenario, plannerModel: data.plannerModel });
        Object.assign(m, data);
        m.startedAt = data.startedAt;
        m.endedAt = data.endedAt;
        return m;
    }
}

export class BenchmarkStore {
    constructor(baseDir = './benchmark_results') {
        this.baseDir = baseDir;
    }

    ensureDir() {
        fs.mkdirSync(this.baseDir, { recursive: true });
    }

    save(metrics) {
        this.ensureDir();
        const fp = path.join(this.baseDir, `${metrics.runId}.json`);
        fs.writeFileSync(fp, JSON.stringify(metrics.toJSON(), null, 2));
        return fp;
    }

    load(runId) {
        const fp = path.join(this.baseDir, `${runId}.json`);
        if (!fs.existsSync(fp)) return null;
        return BenchmarkMetrics.fromJSON(JSON.parse(fs.readFileSync(fp, 'utf8')));
    }

    list() {
        this.ensureDir();
        const files = fs.readdirSync(this.baseDir).filter(f => f.endsWith('.json'));
        return files.map(f => {
            try {
                const data = JSON.parse(fs.readFileSync(path.join(this.baseDir, f), 'utf8'));
                return { runId: data.runId, scenario: data.scenario, completion: data.completion, pct: data.completionPct, time: data.execution_time };
            } catch { return null; }
        }).filter(Boolean);
    }

    saveSummary(metricsArray) {
        this.ensureDir();
        const fp = path.join(this.baseDir, `summary_${Date.now()}.json`);
        const summary = metricsArray.map(m => m.summary ? m.summary() : m);
        fs.writeFileSync(fp, JSON.stringify(summary, null, 2));
        return fp;
    }

    /**
     * Compare runs objectively — for different planners/models.
     */
    compare(runIds) {
        const runs = runIds.map(id => this.load(id)).filter(Boolean);
        if (!runs.length) return null;
        const header = ['runId', 'scenario', 'completion', 'pct', 'total_steps', 'successful', 'failed', 'retries', 'replans', 'interruptions', 'resumes', 'deaths', 'waste', 'LLM_calls', 'LLM_failures', 'time_ms'];
        const rows = runs.map(r => [
            r.runId, r.scenarioName, r.completion, r.completionPct, r.total_steps, r.successful_steps, r.failed_steps,
            r.retries, r.replans, r.interruptions, r.resumes, r.deaths, r.resource_waste, r.LLM_calls, r.LLM_failures, r.execution_time
        ]);
        return { header, rows, runs: runs.map(r => r.summary()) };
    }
}
