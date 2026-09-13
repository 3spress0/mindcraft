/**
 * benchmark/index.js — public API for deterministic autonomy benchmark
 */

export { BenchmarkMetrics, BenchmarkStore } from './metrics.js';
export { Scenario, checkSuccessCondition, EVENT_TYPES, TRIGGER_AT } from './scenario.js';
export { BenchmarkHarness, FakeBot } from './harness.js';
export { createExpectedSnapshot, compareSnapshot, classifyConstructionDamage, ConstructionRegistry } from '../planning/construction_damage.js';
export { createWheatFarmScenario, wheatFarmScenario } from './scenarios/wheat_farm.js';
export { createIronMineScenario } from './scenarios/iron_mine.js';
export { createShelterBuildScenario } from './scenarios/shelter_build.js';
export { createTreeFarmScenario } from './scenarios/tree_farm.js';
export { createVillageOutpostScenario } from './scenarios/village_outpost.js';
export { createScenario, createAllScenarios, ALL_SCENARIOS, SCENARIO_FACTORIES } from './scenarios/index.js';
export { computeStandardScore, aggregateScores, assessRecoveryQuality, generateLeaderboard, formatScoreReport, SCORE_WEIGHTS, SCENARIO_DIFFICULTY } from './scoring.js';
export { ThresholdChecker, DEFAULT_THRESHOLDS, checkThresholds } from './thresholds.js';
export { ModelComparator, compareModels, generateComparisonReport } from './comparison.js';
export { ReplayLogger, ReplayPlayer, createReplayLogger } from './replay.js';
export { BenchmarkSuiteRunner, runBenchmarkSuite, runAllScenarios } from './runner.js';

import { createWheatFarmScenario } from './scenarios/wheat_farm.js';
import { BenchmarkHarness } from './harness.js';
import { BenchmarkStore } from './metrics.js';

/**
 * Run the canonical wheat farm benchmark.
 * @param {object} opts - { plannerModel, tmpDir, storeDir }
 * @returns {Promise<{project, metrics, success}>}
 */
export async function runWheatFarmBenchmark(opts = {}) {
    const scenario = createWheatFarmScenario();
    const harness = new BenchmarkHarness(scenario, {
        plannerModel: opts.plannerModel || 'deterministic',
        tmpDir: opts.tmpDir || null,
        seed: opts.seed || null,
    });
    const result = await harness.run();
    // Compute extended metrics
    result.metrics.computeRecoveryQuality(scenario.expected_recoveries, result.recoveryChecks);
    result.metrics.computeScore();
    if (opts.storeDir) {
        const store = new BenchmarkStore(opts.storeDir);
        store.save(result.metrics);
    }
    harness.cleanup();
    return result;
}

/**
 * Run full benchmark suite.
 */
export async function runFullBenchmarkSuite(opts = {}) {
    const { BenchmarkSuiteRunner } = await import('./runner.js');
    const runner = new BenchmarkSuiteRunner(opts);
    return runner.runAll();
}
