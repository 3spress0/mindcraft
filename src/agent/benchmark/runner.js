/**
 * runner.js — benchmark suite runner with scoring, thresholds, comparison, replay
 *
 * Runs all scenarios, computes standardized scores, checks regression thresholds,
 * saves replay logs, and generates comparison reports.
 *
 * plannerModel may be a deterministic string label (default) or a real-model
 * config object { provider, model, ... } in the repository's profile format.
 * Real-LLM runs flow through the identical pipeline; only the planner's model
 * decision function is swapped (see llm_planner.js), with call/retry/timeout/
 * cost limits enforced so a runaway benchmark cannot make unlimited API calls.
 */

import fs from 'fs';
import path from 'path';

import { BenchmarkHarness } from './harness.js';
import { BenchmarkStore } from './metrics.js';
import { createAllScenarios, createScenario, ALL_SCENARIOS } from './scenarios/index.js';
import { aggregateScores, formatScoreReport } from './scoring.js';
import { ThresholdChecker, DEFAULT_THRESHOLDS } from './thresholds.js';
import { ModelComparator } from './comparison.js';
import { ReplayLogger } from './replay.js';
import { BENCHMARK_VERSION, normalizePlannerModelConfig } from './llm_planner.js';

export class BenchmarkSuiteRunner {
    constructor({
        scenarios = ALL_SCENARIOS,
        plannerModel = 'deterministic',
        storeDir = './benchmark_results',
        seed = null,
        enableReplay = true,
        thresholds = DEFAULT_THRESHOLDS,
        baselineName = 'baseline',
        verbose = false,
        modelFactory = null,
        llmLimits = {},
        llmPricing = null,
        pricing = null,
        useLlmInitialPlan = false,
    } = {}) {
        this.scenarios = scenarios;
        this.plannerModel = plannerModel;
        this.plannerConfig = normalizePlannerModelConfig(plannerModel);
        this.storeDir = storeDir;
        this.seed = seed || Math.floor(Math.random() * 1e9);
        this.enableReplay = enableReplay;
        this.thresholds = thresholds;
        this.baselineName = baselineName;
        this.verbose = verbose;
        // Real-LLM evaluation options (ignored for deterministic runs).
        // llmLimits: { maxScenarios, maxModelCalls (per scenario), maxTotalModelCalls
        //   (suite-wide), maxRetries (per call), timeoutMs (per attempt),
        //   maxEstimatedCost (suite-wide USD), pricing }
        this.modelFactory = modelFactory || null;
        this.llmLimits = { ...(llmLimits || {}) };
        this.llmPricing = llmPricing || pricing || this.llmLimits.pricing || null;
        this.useLlmInitialPlan = !!useLlmInitialPlan;

        this.store = new BenchmarkStore(storeDir);
        this.results = [];
        this.replayLoggers = [];
        this.suiteLlmCalls = 0;
        this.suiteEstimatedCost = 0;
        this.suiteHasCostData = false;
        this.suiteAborted = null;
    }

    get modelLabel() {
        return this.plannerConfig.label;
    }

    get runMode() {
        return this.plannerConfig.mode;
    }

    async runSingleScenario(scenarioName, opts = {}) {
        const scenario = typeof scenarioName === 'string' ? createScenario(scenarioName) : scenarioName;
        const seed = opts.seed || this.seed + Math.floor(Math.random() * 1000);
        const effectivePlannerModel = opts.plannerModel || this.plannerModel;
        const harness = new BenchmarkHarness(scenario, {
            plannerModel: effectivePlannerModel,
            tmpDir: null,
            seed,
            modelFactory: opts.modelFactory || this.modelFactory,
            llmLimits: opts.llmLimits || this.llmLimits,
            llmPricing: opts.llmPricing || opts.pricing || this.llmPricing,
            useLlmInitialPlan: opts.useLlmInitialPlan ?? this.useLlmInitialPlan,
        });

        // Setup replay logger if enabled
        let replayLogger = null;
        if (this.enableReplay) {
            replayLogger = new ReplayLogger({
                runId: `pending_${scenario.name}`,
                scenario,
                seed,
                runMode: harness.runMode,
                modelProvider: harness.plannerConfig.provider,
                modelName: harness.plannerConfig.model,
                modelConfigId: harness.plannerConfig.configId,
                benchmarkVersion: BENCHMARK_VERSION,
            });
            replayLogger.setInitialWorld(scenario.initial_world);
            // Hook into harness to record injections and states
            const originalApplyInjection = harness._applyInjection.bind(harness);
            harness._applyInjection = async (event, step, phase) => {
                replayLogger.recordInjection(event, step, phase);
                return originalApplyInjection(event, step, phase);
            };
        }

        const result = await harness.run();

        // Compute recovery quality and score
        result.metrics.computeRecoveryQuality(scenario.expected_recoveries, result.recoveryChecks);
        result.metrics.computeScore();

        // Track suite-wide LLM usage for safety limits.
        this._accumulateSuiteLlmUsage(result.metrics);

        if (replayLogger) {
            replayLogger.runId = result.metrics.runId;
            replayLogger.setModelInfo({
                runMode: result.metrics.runMode,
                provider: result.metrics.modelProvider,
                model: result.metrics.modelName,
                configId: result.metrics.modelConfigId,
                benchmarkVersion: result.metrics.benchmarkVersion,
            });
            replayLogger.recordPlannerOutputs(harness.getPlannerOutputs());
            replayLogger.setFinalMetrics(result.metrics);
            result.metrics.replay_log_id = replayLogger.runId;
            // Record final state
            replayLogger.recordState('final', harness.bot, harness.worldModel);
            // Save replay
            const replayPath = replayLogger.save(this.storeDir);
            result.replayPath = replayPath;
            this.replayLoggers.push(replayLogger);
            if (this.verbose) console.log(`[replay] saved ${replayPath}`);
        }

        // Save metrics
        const metricsPath = this.store.save(result.metrics);
        result.metricsPath = metricsPath;

        if (this.verbose) {
            console.log(`[benchmark] ${scenario.name}: completion=${result.metrics.completion} score=${result.metrics.score.total} time=${result.metrics.execution_time}ms`);
            console.log(formatScoreReport(result.metrics));
        }

        harness.cleanup();
        this.results.push(result);
        return result;
    }

    _accumulateSuiteLlmUsage(metrics) {
        const llm = metrics?.llm;
        if (!llm) return;
        this.suiteLlmCalls += llm.calls || 0;
        if (llm.estimated_cost != null) {
            this.suiteEstimatedCost += Number(llm.estimated_cost) || 0;
            this.suiteHasCostData = true;
        }
    }

    _suiteLimitExceeded() {
        const maxTotal = this.llmLimits.maxTotalModelCalls ?? this.llmLimits.max_total_calls ?? null;
        if (maxTotal != null && this.suiteLlmCalls >= maxTotal) {
            return `suite model-call limit exceeded (${this.suiteLlmCalls}/${maxTotal})`;
        }
        const maxCost = this.llmLimits.maxEstimatedCost ?? this.llmLimits.max_estimated_cost ?? null;
        if (maxCost != null && this.suiteHasCostData && this.suiteEstimatedCost >= maxCost) {
            return `suite estimated-cost limit exceeded ($${this.suiteEstimatedCost.toFixed(4)} >= $${Number(maxCost).toFixed(4)})`;
        }
        return null;
    }

    async runAll() {
        this.results = [];
        this.replayLoggers = [];
        this.suiteLlmCalls = 0;
        this.suiteEstimatedCost = 0;
        this.suiteHasCostData = false;
        this.suiteAborted = null;

        let scenarios = [...this.scenarios];
        const maxScenarios = this.llmLimits.maxScenarios ?? this.llmLimits.max_scenarios ?? null;
        if (maxScenarios != null && scenarios.length > maxScenarios) {
            console.log(`[benchmark] Limiting to ${maxScenarios}/${scenarios.length} scenarios (maxScenarios)`);
            scenarios = scenarios.slice(0, maxScenarios);
        }

        console.log(`[benchmark] Running ${scenarios.length} scenarios with model ${this.modelLabel} (${this.runMode}), seed ${this.seed}, benchmark v${BENCHMARK_VERSION}`);
        if (this.runMode === 'llm') {
            console.log(`[benchmark] LLM limits: per-scenario calls=${this.llmLimits.maxModelCalls ?? 50}, suite calls=${this.llmLimits.maxTotalModelCalls ?? 'unlimited'}, retries=${this.llmLimits.maxRetries ?? 2}, timeout=${this.llmLimits.timeoutMs ?? 60000}ms, maxCost=${this.llmLimits.maxEstimatedCost ?? 'none'}`);
        }

        for (const scenarioName of scenarios) {
            const limitReason = this._suiteLimitExceeded();
            if (limitReason) {
                console.error(`[benchmark] Aborting suite: ${limitReason}`);
                this.suiteAborted = limitReason;
                this.results.push({
                    scenario: scenarioName,
                    error: limitReason,
                    skipped: true,
                    metrics: { scenario: scenarioName, completion: false, score: { total: 0 } },
                });
                break;
            }
            try {
                await this.runSingleScenario(scenarioName);
            } catch (err) {
                console.error(`[benchmark] Failed scenario ${scenarioName}:`, err.message);
                // Record failure
                this.results.push({
                    scenario: scenarioName,
                    error: err.message,
                    metrics: { scenario: scenarioName, completion: false, score: { total: 0 } },
                });
            }
        }

        const metricsList = this.results.filter(r => r.metrics && r.metrics.computeScore).map(r => r.metrics);
        const aggregate = aggregateScores(metricsList.map(m => m.summary ? m.summary() : m));

        // Check thresholds
        const baseline = this.store.loadBaseline(this.baselineName);
        const checker = new ThresholdChecker({
            thresholds: this.thresholds,
            baseline,
        });
        const thresholdResult = checker.checkAggregate(metricsList.map(m => m.summary ? m.summary() : m));

        // Save summary
        const summaryPath = this.store.saveSummary(metricsList);
        const report = {
            model: this.modelLabel,
            plannerModel: this.modelLabel,
            runMode: this.runMode,
            benchmarkVersion: BENCHMARK_VERSION,
            modelProvider: this.plannerConfig.provider,
            modelName: this.plannerConfig.model,
            modelConfigId: this.plannerConfig.configId,
            seed: this.seed,
            totalScenarios: scenarios.length,
            completedRuns: metricsList.length,
            suiteLlmCalls: this.suiteLlmCalls,
            suiteEstimatedCost: this.suiteHasCostData ? this.suiteEstimatedCost : null,
            suiteAborted: this.suiteAborted,
            aggregate,
            thresholdResult,
            results: metricsList.map(m => m.summary()),
            generatedAt: Date.now(),
        };
        const reportPath = path.join(this.storeDir, `report_${Date.now()}.json`);
        fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));

        // Generate markdown report
        const mdReport = this.generateMarkdownReport(aggregate, thresholdResult);
        const mdPath = path.join(this.storeDir, `report_${Date.now()}.md`);
        fs.writeFileSync(mdPath, mdReport);

        return {
            results: this.results,
            metricsList,
            aggregate,
            thresholdResult,
            summaryPath,
            reportPath,
            mdPath,
            passed: thresholdResult.passed,
        };
    }

    generateMarkdownReport(aggregate, thresholdResult) {
        const lines = [];
        lines.push(`# Benchmark Report: ${this.modelLabel}`);
        lines.push('');
        lines.push(`**Run Mode:** ${this.runMode}`);
        lines.push(`**Benchmark Version:** ${BENCHMARK_VERSION}`);
        lines.push(`**Seed:** ${this.seed}`);
        lines.push(`**Scenarios:** ${this.scenarios.join(', ')}`);
        if (this.runMode === 'llm') {
            lines.push(`**LLM Calls (suite):** ${this.suiteLlmCalls}`);
            lines.push(`**Est. Cost (suite):** ${this.suiteHasCostData ? `$${this.suiteEstimatedCost.toFixed(4)}` : 'n/a (provider did not report usage)'}`);
            if (this.suiteAborted) lines.push(`**Suite Aborted:** ${this.suiteAborted}`);
        }
        lines.push(`**Total Runs:** ${aggregate?.totalRuns || 0}`);
        lines.push(`**Overall Avg Score:** ${aggregate?.overallAvg || 0} (weighted ${aggregate?.overallWeighted || 0})`);
        lines.push(`**Completion Rate:** ${((aggregate?.overallCompletion || 0) * 100).toFixed(1)}%`);
        lines.push('');
        lines.push('## Scenario Scores');
        lines.push('| Scenario | Runs | Avg | Weighted | Best | Worst | Completion |');
        lines.push('|----------|------|-----|----------|------|-------|------------|');
        if (aggregate?.scenarioScores) {
            for (const [name, sc] of Object.entries(aggregate.scenarioScores)) {
                lines.push(`| ${name} | ${sc.runs} | ${sc.avgScore} | ${sc.weightedAvg} | ${sc.bestScore} | ${sc.worstScore} | ${(sc.completionRate * 100).toFixed(1)}% |`);
            }
        }
        lines.push('');

        lines.push('## Threshold Check');
        lines.push(`**Status:** ${thresholdResult.passed ? '✅ PASSED' : '❌ FAILED'}`);
        lines.push('');
        if (thresholdResult.summary) {
            lines.push(`- Avg Score: ${thresholdResult.summary.avgScore}`);
            lines.push(`- Completion: ${(thresholdResult.summary.completionRate * 100).toFixed(1)}%`);
            lines.push(`- Avg Replans: ${thresholdResult.summary.avgReplans}`);
            lines.push(`- Avg Retries: ${thresholdResult.summary.avgRetries}`);
        }
        lines.push('');
        if (thresholdResult.violations.length) {
            lines.push('### Violations');
            for (const v of thresholdResult.violations) {
                lines.push(`- ❌ ${v.message}`);
            }
        } else {
            lines.push('No violations — all thresholds passed.');
        }
        lines.push('');

        lines.push('## Individual Runs');
        for (const result of this.results) {
            if (!result.metrics || !result.metrics.score) continue;
            const score = result.metrics.score || {};
            const rq = result.metrics.recovery_quality || { score: 0, expected_satisfied: 0, expected_total: 0 };
            lines.push(`### ${result.metrics.scenarioName || result.scenario} — ${result.metrics.runId || 'failed'}`);
            if (result.skipped || result.error) {
                lines.push(`- ${result.skipped ? 'Skipped' : 'Failed'}: ${result.error || 'unknown error'}`);
                lines.push('');
                continue;
            }
            lines.push(`- Score: ${score.total} (C:${score.completion} E:${score.efficiency} R:${score.recovery} Rob:${score.robustness})`);
            lines.push(`- Completion: ${result.metrics.completion ? '✓' : '✗'} ${result.metrics.completionPct}%`);
            lines.push(`- Recovery Quality: ${rq.score}/100 (${rq.expected_satisfied}/${rq.expected_total} expected)`);
            lines.push(`- Time: ${result.metrics.execution_time}ms, LLM: ${result.metrics.LLM_calls}`);
            const llm = result.metrics.llm;
            if (llm && llm.calls > 0) {
                lines.push(`- Model: ${llm.configId || result.metrics.plannerModel} — calls ${llm.calls} (ok ${llm.successful_calls}/fail ${llm.failed_calls}), retries ${llm.retries}, tokens ${llm.total_tokens ?? 'n/a'}, est. cost ${llm.estimated_cost != null ? `$${Number(llm.estimated_cost).toFixed(4)}` : 'n/a'}, avg latency ${llm.avg_latency_ms}ms, planner failures ${llm.planner_failures}`);
            }
            if (result.replayPath) lines.push(`- Replay: ${result.replayPath}`);
            lines.push('');
        }

        return lines.join('\n');
    }

    /**
     * Compare current results with baseline or other models.
     */
    async compareWithBaseline() {
        const comparator = new ModelComparator({ store: this.store });
        // Load all runs from store
        const allRuns = this.store.list().map(f => this.store.load(f.runId)).filter(Boolean);
        comparator.addRuns(allRuns);
        return comparator.compare();
    }

    static async runQuick(scenarioName = 'wheat_farm_benchmark', opts = {}) {
        const runner = new BenchmarkSuiteRunner({
            scenarios: [scenarioName],
            ...opts,
        });
        return runner.runSingleScenario(scenarioName, opts);
    }
}

export async function runBenchmarkSuite(opts = {}) {
    const runner = new BenchmarkSuiteRunner(opts);
    return runner.runAll();
}

export async function runAllScenarios(opts = {}) {
    return runBenchmarkSuite(opts);
}
