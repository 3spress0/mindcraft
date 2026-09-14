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
 * Extended with:
 *   recovery quality tracking
 *   standardized scoring
 *   replay log reference
 *
 * Persisted per run so different planners/models can be compared objectively.
 */

import fs from 'fs';
import path from 'path';

import { BENCHMARK_VERSION } from './llm_planner.js';

export { BENCHMARK_VERSION };

function defaultLlmStats() {
    return {
        provider: null,
        model: null,
        configId: null,
        calls: 0,
        successful_calls: 0,
        failed_calls: 0,
        retries: 0,
        input_tokens: null,
        output_tokens: null,
        total_tokens: null,
        estimated_cost: null,
        cumulative_latency_ms: 0,
        avg_latency_ms: 0,
        planner_failures: 0,
    };
}

export class BenchmarkMetrics {
    constructor({ runId = null, scenarioName = 'unknown', plannerModel = 'unknown', seed = null, modelProvider = null, modelName = null, modelConfigId = null, runMode = null, benchmarkVersion = null } = {}) {
        this.runId = runId || `run_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
        this.scenarioName = scenarioName;
        // Backwards compatible: plannerModel may be a string label (deterministic)
        // or a real-model config object { provider, model, ... } (LLM mode).
        if (plannerModel != null && typeof plannerModel === 'object') {
            const provider = plannerModel.provider || plannerModel.api || 'unknown';
            const model = plannerModel.model || plannerModel.defaultModel || plannerModel.default_model || 'default';
            this.plannerModel = plannerModel.label || `${provider}/${model}`;
            this.modelProvider = modelProvider || String(provider);
            this.modelName = modelName || String(model);
            this.modelConfigId = modelConfigId || `${provider}/${model}`;
            this.runMode = runMode || 'llm';
        } else {
            this.plannerModel = plannerModel;
            this.modelProvider = modelProvider || 'deterministic';
            this.modelName = modelName || String(plannerModel);
            this.modelConfigId = modelConfigId || String(plannerModel);
            this.runMode = runMode || 'deterministic';
        }
        this.benchmarkVersion = benchmarkVersion || BENCHMARK_VERSION;
        this.seed = seed || Math.floor(Math.random() * 1e9);
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

        // Real-LLM evaluation stats. Deterministic runs keep calls=0 and
        // null tokens/cost (never fabricated). LLM_calls/LLM_failures above
        // stay in sync for backwards-compatible scoring.
        this.llm = defaultLlmStats();
        this.llm.provider = this.modelProvider;
        this.llm.model = this.modelName;
        this.llm.configId = this.modelConfigId;

        // Extended tracking
        this.recovery_quality = {
            expected_total: 0,
            expected_satisfied: 0,
            correct_action_rate: 0,
            recovery_success_rate: 0,
            avg_attempts_per_failure: 0,
            waste_efficiency: 1,
            score: 0,
        };
        this.score = {
            total: 0,
            completion: 0,
            efficiency: 0,
            recovery: 0,
            robustness: 0,
            breakdown: {},
        };
        this.replay_log_id = null;

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

    setModelInfo({ provider = null, model = null, configId = null, runMode = null } = {}) {
        if (provider != null) {
            this.modelProvider = provider;
            this.llm.provider = provider;
        }
        if (model != null) {
            this.modelName = model;
            this.llm.model = model;
        }
        if (configId != null) {
            this.modelConfigId = configId;
            this.llm.configId = configId;
        }
        if (runMode != null) this.runMode = runMode;
    }

    /**
     * Record one top-level real-model planner call. Also keeps the legacy
     * LLM_calls/LLM_failures counters in sync so scoring stays comparable.
     * Unknown token/cost values stay null — never fabricated.
     */
    recordModelCall({ success = true, inputTokens = null, outputTokens = null, totalTokens = null, estimatedCost = null, latencyMs = 0, plannerFailed = false } = {}) {
        this.recordLLMCall(success);
        this.llm.calls += 1;
        if (success) this.llm.successful_calls += 1;
        else {
            this.llm.failed_calls += 1;
            this.llm.planner_failures += 1;
        }
        if (plannerFailed && success) this.llm.planner_failures += 1;
        if (inputTokens != null && Number.isFinite(Number(inputTokens))) {
            this.llm.input_tokens = (this.llm.input_tokens || 0) + Number(inputTokens);
        }
        if (outputTokens != null && Number.isFinite(Number(outputTokens))) {
            this.llm.output_tokens = (this.llm.output_tokens || 0) + Number(outputTokens);
        }
        if (totalTokens != null && Number.isFinite(Number(totalTokens))) {
            this.llm.total_tokens = (this.llm.total_tokens || 0) + Number(totalTokens);
        } else if (inputTokens != null || outputTokens != null) {
            const partial = (Number(inputTokens) || 0) + (Number(outputTokens) || 0);
            if (Number.isFinite(partial) && (inputTokens != null || outputTokens != null)) {
                this.llm.total_tokens = (this.llm.total_tokens || 0) + partial;
            }
        }
        if (estimatedCost != null && Number.isFinite(Number(estimatedCost))) {
            this.llm.estimated_cost = (this.llm.estimated_cost || 0) + Number(estimatedCost);
        }
        if (latencyMs != null && Number.isFinite(Number(latencyMs))) {
            this.llm.cumulative_latency_ms += Number(latencyMs);
        }
        this.llm.avg_latency_ms = this.llm.calls > 0
            ? Math.round(this.llm.cumulative_latency_ms / this.llm.calls)
            : 0;
    }

    recordModelRetry() {
        this.llm.retries += 1;
    }

    incrementPlannerFailures(count = 1) {
        this.llm.planner_failures += count;
    }

    recordEvent(type, data = {}) {
        this.events.push({ at: Date.now(), type, ...data });
    }

    setCompletion(completed, pct = 100, totalSteps = null) {
        this.completion = completed;
        this.completionPct = pct;
        if (totalSteps != null) this.total_steps = totalSteps;
    }

    /**
     * Compute recovery quality based on expected recoveries and actual recovery log.
     * @param {Array} expectedRecoveries - from scenario
     * @param {Array} recoveryChecks - [{ satisfied, expectedAction, expectedReason, ... }]
     */
    computeRecoveryQuality(expectedRecoveries = [], recoveryChecks = []) {
        const total = expectedRecoveries.length;
        const satisfied = recoveryChecks.filter(c => c.satisfied).length;
        const correctRate = total > 0 ? satisfied / total : 1;

        const totalAttempts = this.steps.reduce((s, st) => s + (st.attempts || 1), 0);
        const avgAttemptsPerFailure = this.failed_steps > 0 ? totalAttempts / (this.failed_steps + this.successful_steps) : 1;

        const recoverySuccessRate = this.total_steps > 0 ? this.successful_steps / this.total_steps : 0;

        const wasteEfficiency = this.resource_waste === 0 ? 1 : Math.max(0, 1 - this.resource_waste / Math.max(10, this.total_steps * 2));

        // Recovery quality score 0-100
        const qualityScore = Math.round(
            correctRate * 40 +
            recoverySuccessRate * 30 +
            wasteEfficiency * 15 +
            (Math.max(0, 1 - (avgAttemptsPerFailure - 1) / 3) * 15)
        );

        this.recovery_quality = {
            expected_total: total,
            expected_satisfied: satisfied,
            correct_action_rate: correctRate,
            recovery_success_rate: recoverySuccessRate,
            avg_attempts_per_failure: avgAttemptsPerFailure,
            waste_efficiency: wasteEfficiency,
            score: qualityScore,
            checks: recoveryChecks.map(c => ({
                eventId: c.eventId,
                expectedAction: c.expectedAction,
                expectedReason: c.expectedReason,
                satisfied: c.satisfied,
                description: c.description,
            })),
        };
        return this.recovery_quality;
    }

    /**
     * Compute standardized score 0-100 across dimensions.
     * This is the primary metric for CI regression and model comparison.
     */
    computeScore() {
        // Completion: 0-40
        let completionScore = 0;
        if (this.completion) completionScore = 40;
        else completionScore = Math.round((this.completionPct / 100) * 35);

        // Efficiency: 0-25
        let efficiency = 25;
        efficiency -= Math.min(10, this.retries * 2);
        efficiency -= Math.min(10, this.replans * 3);
        efficiency -= Math.min(5, this.resource_waste);
        efficiency -= Math.min(5, Math.max(0, (this.LLM_calls - 5) * 0.1));
        efficiency -= Math.min(5, Math.max(0, (this.execution_time - 2000) / 1000));
        efficiency = Math.max(0, Math.round(efficiency));

        // Recovery quality: 0-25 (uses computed recovery_quality if available)
        let recoveryScore = 15;
        if (this.recovery_quality && this.recovery_quality.score) {
            recoveryScore = Math.round((this.recovery_quality.score / 100) * 25);
        } else {
            // Fallback heuristic
            const hasRecovery = Object.keys(this.recovery_actions).length > 0;
            if (hasRecovery) {
                const successRatio = this.total_steps > 0 ? this.successful_steps / this.total_steps : 0;
                recoveryScore = Math.round(successRatio * 20 + 5);
            } else if (this.completion) {
                recoveryScore = 20;
            }
        }

        // Robustness: 0-10
        let robustness = 10;
        robustness -= Math.min(6, this.deaths * 3);
        if (this.interruptions > 0 && this.interruptions === this.resumes) robustness += 2; // handled correctly
        else if (this.interruptions > this.resumes) robustness -= 3;
        robustness -= Math.min(4, this.LLM_failures * 2);
        robustness = Math.max(0, Math.min(10, Math.round(robustness)));

        const total = completionScore + efficiency + recoveryScore + robustness;

        this.score = {
            total,
            completion: completionScore,
            efficiency,
            recovery: recoveryScore,
            robustness,
            breakdown: {
                completionPct: this.completionPct,
                retries: this.retries,
                replans: this.replans,
                waste: this.resource_waste,
                llmCalls: this.LLM_calls,
                recoveryQuality: this.recovery_quality?.score || 0,
                deaths: this.deaths,
                interruptionsHandled: this.interruptions === this.resumes,
            },
        };
        return this.score;
    }

    finish() {
        this.endedAt = Date.now();
        this.execution_time = this.endedAt - this.startedAt;
        if (!this.score.total) this.computeScore();
        return this.summary();
    }

    summary() {
        return {
            runId: this.runId,
            scenario: this.scenarioName,
            plannerModel: this.plannerModel,
            runMode: this.runMode,
            benchmarkVersion: this.benchmarkVersion,
            modelProvider: this.modelProvider,
            modelName: this.modelName,
            modelConfigId: this.modelConfigId,
            seed: this.seed,
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
            llm: { ...this.llm },
            recovery_quality: { ...this.recovery_quality },
            score: { ...this.score },
            replay_log_id: this.replay_log_id,
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
        const m = new BenchmarkMetrics({
            runId: data.runId,
            scenarioName: data.scenario,
            plannerModel: data.plannerModel,
            seed: data.seed,
            modelProvider: data.modelProvider,
            modelName: data.modelName,
            modelConfigId: data.modelConfigId,
            runMode: data.runMode,
            benchmarkVersion: data.benchmarkVersion,
        });
        Object.assign(m, data);
        m.startedAt = data.startedAt;
        m.endedAt = data.endedAt;
        // Backwards compatibility: runs persisted before LLM evaluation
        // (schema v1) have no runMode/benchmarkVersion/llm fields.
        if (!data.runMode) m.runMode = 'deterministic';
        if (!data.benchmarkVersion) m.benchmarkVersion = '1.0.0';
        if (!data.modelProvider) m.modelProvider = 'deterministic';
        if (!data.modelName) m.modelName = String(data.plannerModel || 'unknown');
        if (!data.modelConfigId) m.modelConfigId = String(data.plannerModel || 'unknown');
        // Ensure nested objects are cloned
        m.recovery_quality = data.recovery_quality || m.recovery_quality;
        m.score = data.score || m.score;
        m.llm = { ...defaultLlmStats(), ...(data.llm || {}) };
        if (!m.llm.provider) m.llm.provider = m.modelProvider;
        if (!m.llm.model) m.llm.model = m.modelName;
        if (!m.llm.configId) m.llm.configId = m.modelConfigId;
        m.steps = data.steps || [];
        m.events = data.events || [];
        m.recoveryLog = data.recoveryLog || [];
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
        const files = fs.readdirSync(this.baseDir).filter(f => f.endsWith('.json') && !f.startsWith('summary_') && !f.startsWith('baseline_') && !f.startsWith('replay_') && !f.startsWith('report_'));
        return files.map(f => {
            try {
                const data = JSON.parse(fs.readFileSync(path.join(this.baseDir, f), 'utf8'));
                if (!data.runId) return null;
                return {
                    runId: data.runId,
                    scenario: data.scenario,
                    completion: data.completion,
                    pct: data.completionPct,
                    time: data.execution_time,
                    score: data.score?.total || 0,
                    model: data.plannerModel,
                    runMode: data.runMode || 'deterministic',
                    benchmarkVersion: data.benchmarkVersion || '1.0.0',
                    modelConfigId: data.modelConfigId || data.plannerModel,
                    llmCalls: data.llm?.calls ?? 0,
                    tokens: data.llm?.total_tokens ?? null,
                    estimatedCost: data.llm?.estimated_cost ?? null,
                };
            } catch { return null; }
        }).filter(Boolean);
    }

    listByScenario(scenarioName) {
        return this.list().filter(r => r.scenario === scenarioName);
    }

    saveSummary(metricsArray) {
        this.ensureDir();
        const fp = path.join(this.baseDir, `summary_${Date.now()}.json`);
        const summary = metricsArray.map(m => m.summary ? m.summary() : m);
        fs.writeFileSync(fp, JSON.stringify(summary, null, 2));
        return fp;
    }

    saveBaseline(metricsArray, name = 'baseline') {
        this.ensureDir();
        const fp = path.join(this.baseDir, `baseline_${name}.json`);
        const summary = metricsArray.map(m => m.summary ? m.summary() : m);
        const aggregate = {
            name,
            createdAt: Date.now(),
            runs: summary,
            avgScore: summary.reduce((s, r) => s + (r.score?.total || 0), 0) / Math.max(1, summary.length),
            avgCompletion: summary.reduce((s, r) => s + (r.completion ? 1 : 0), 0) / Math.max(1, summary.length),
            scenarios: [...new Set(summary.map(r => r.scenario))],
        };
        fs.writeFileSync(fp, JSON.stringify(aggregate, null, 2));
        return fp;
    }

    loadBaseline(name = 'baseline') {
        const fp = path.join(this.baseDir, `baseline_${name}.json`);
        if (!fs.existsSync(fp)) return null;
        return JSON.parse(fs.readFileSync(fp, 'utf8'));
    }

    /**
     * Compare runs objectively — for different planners/models.
     */
    compare(runIds) {
        const runs = runIds.map(id => this.load(id)).filter(Boolean);
        if (!runs.length) return null;
        const header = ['runId', 'scenario', 'model', 'completion', 'pct', 'score', 'total_steps', 'successful', 'failed', 'retries', 'replans', 'interruptions', 'resumes', 'deaths', 'waste', 'LLM_calls', 'LLM_failures', 'time_ms'];
        const rows = runs.map(r => [
            r.runId, r.scenarioName, r.plannerModel, r.completion, r.completionPct, r.score?.total || 0,
            r.total_steps, r.successful_steps, r.failed_steps,
            r.retries, r.replans, r.interruptions, r.resumes, r.deaths, r.resource_waste, r.LLM_calls, r.LLM_failures, r.execution_time
        ]);
        return { header, rows, runs: runs.map(r => r.summary()) };
    }

    compareByModel() {
        const all = this.list();
        const byModel = {};
        for (const r of all) {
            if (!byModel[r.model]) byModel[r.model] = [];
            byModel[r.model].push(r);
        }
        const result = {};
        for (const [model, runs] of Object.entries(byModel)) {
            const avgScore = runs.reduce((s, r) => s + (r.score || 0), 0) / runs.length;
            const completionRate = runs.filter(r => r.completion).length / runs.length;
            const scenarios = [...new Set(runs.map(r => r.scenario))];
            result[model] = {
                model,
                runs: runs.length,
                avgScore: Math.round(avgScore),
                completionRate,
                scenarios,
                bestRun: runs.reduce((best, cur) => (cur.score > (best?.score || 0) ? cur : best), null),
                worstRun: runs.reduce((worst, cur) => (cur.score < (worst?.score || Infinity) ? cur : worst), null),
            };
        }
        return result;
    }
}
