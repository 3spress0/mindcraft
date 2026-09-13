/**
 * runner.js — benchmark suite runner with scoring, thresholds, comparison, replay
 *
 * Runs all scenarios, computes standardized scores, checks regression thresholds,
 * saves replay logs, and generates comparison reports.
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
    } = {}) {
        this.scenarios = scenarios;
        this.plannerModel = plannerModel;
        this.storeDir = storeDir;
        this.seed = seed || Math.floor(Math.random() * 1e9);
        this.enableReplay = enableReplay;
        this.thresholds = thresholds;
        this.baselineName = baselineName;
        this.verbose = verbose;

        this.store = new BenchmarkStore(storeDir);
        this.results = [];
        this.replayLoggers = [];
    }

    async runSingleScenario(scenarioName, opts = {}) {
        const scenario = typeof scenarioName === 'string' ? createScenario(scenarioName) : scenarioName;
        const seed = opts.seed || this.seed + Math.floor(Math.random() * 1000);
        const harness = new BenchmarkHarness(scenario, {
            plannerModel: opts.plannerModel || this.plannerModel,
            tmpDir: null,
            seed,
        });

        // Setup replay logger if enabled
        let replayLogger = null;
        if (this.enableReplay) {
            replayLogger = new ReplayLogger({
                runId: `pending_${scenario.name}`,
                scenario,
                seed,
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

        if (replayLogger) {
            replayLogger.runId = result.metrics.runId;
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

    async runAll() {
        this.results = [];
        this.replayLoggers = [];
        console.log(`[benchmark] Running ${this.scenarios.length} scenarios with model ${this.plannerModel}, seed ${this.seed}`);

        for (const scenarioName of this.scenarios) {
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
            model: this.plannerModel,
            seed: this.seed,
            totalScenarios: this.scenarios.length,
            completedRuns: metricsList.length,
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
        lines.push(`# Benchmark Report: ${this.plannerModel}`);
        lines.push('');
        lines.push(`**Seed:** ${this.seed}`);
        lines.push(`**Scenarios:** ${this.scenarios.join(', ')}`);
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
            lines.push(`### ${result.metrics.scenarioName} — ${result.metrics.runId}`);
            lines.push(`- Score: ${result.metrics.score.total} (C:${result.metrics.score.completion} E:${result.metrics.score.efficiency} R:${result.metrics.score.recovery} Rob:${result.metrics.score.robustness})`);
            lines.push(`- Completion: ${result.metrics.completion ? '✓' : '✗'} ${result.metrics.completionPct}%`);
            lines.push(`- Recovery Quality: ${result.metrics.recovery_quality.score}/100 (${result.metrics.recovery_quality.expected_satisfied}/${result.metrics.recovery_quality.expected_total} expected)`);
            lines.push(`- Time: ${result.metrics.execution_time}ms, LLM: ${result.metrics.LLM_calls}`);
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
