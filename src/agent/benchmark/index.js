/**
 * benchmark/index.js — public API for deterministic autonomy benchmark
 */

export { BenchmarkMetrics, BenchmarkStore } from './metrics.js';
export { Scenario, checkSuccessCondition, EVENT_TYPES, TRIGGER_AT } from './scenario.js';
export { BenchmarkHarness, FakeBot } from './harness.js';
export { createExpectedSnapshot, compareSnapshot, classifyConstructionDamage, ConstructionRegistry } from '../planning/construction_damage.js';
export { createWheatFarmScenario, wheatFarmScenario } from './scenarios/wheat_farm.js';

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
    });
    const result = await harness.run();
    if (opts.storeDir) {
        const store = new BenchmarkStore(opts.storeDir);
        store.save(result.metrics);
    }
    harness.cleanup();
    return result;
}
