import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { BenchmarkMetrics, BenchmarkStore } from '../src/agent/benchmark/metrics.js';
import { BenchmarkHarness } from '../src/agent/benchmark/harness.js';
import { BenchmarkSuiteRunner } from '../src/agent/benchmark/runner.js';
import { ModelComparator } from '../src/agent/benchmark/comparison.js';
import { ReplayLogger, ReplayPlayer } from '../src/agent/benchmark/replay.js';
import {
    LlmPlannerAdapter,
    BenchmarkLlmError,
    normalizePlannerModelConfig,
    isDeterministicPlannerModel,
    estimateCost,
    BENCHMARK_VERSION,
} from '../src/agent/benchmark/llm_planner.js';
import { createWheatFarmScenario } from '../src/agent/benchmark/scenarios/wheat_farm.js';
import { createIronMineScenario } from '../src/agent/benchmark/scenarios/iron_mine.js';
import { ALL_SCENARIOS } from '../src/agent/benchmark/scenarios/index.js';

// ---------- helpers (mocked providers only — never a real API) ----------

const REPLAN_JSON = JSON.stringify({
    summary: 'mocked replan',
    steps: [
        { title: 'Retry previous step', instruction: 'retry with alternative approach', expected: { kind: 'freeform', description: 'step completed with new approach' } },
        { title: 'Verify farm', instruction: 'verify farm', expected: { kind: 'freeform', description: 'farm complete' } },
    ],
});

function makeMockModel({ response = REPLAN_JSON, usage = null, failTimes = 0, failAlways = false, hangMs = 0, calls = null } = {}) {
    const state = { invocations: 0 };
    const model = {
        lastTokenUsage: null,
        state,
        sendRequest: async () => {
            state.invocations += 1;
            if (calls) calls.push({ at: Date.now(), invocation: state.invocations });
            if (hangMs > 0) {
                await new Promise((resolve) => setTimeout(resolve, hangMs));
            }
            if (failAlways || state.invocations <= failTimes) {
                throw new Error('mock provider failure');
            }
            model.lastTokenUsage = usage;
            return response;
        },
    };
    return model;
}

function mockFactoryFor(model) {
    return async () => model;
}

// ---------- planner model normalization ----------

test('llm benchmark: planner model normalization (string vs object)', () => {
    assert.equal(isDeterministicPlannerModel('deterministic'), true);
    assert.equal(isDeterministicPlannerModel('deterministic-baseline'), true);
    assert.equal(isDeterministicPlannerModel(null), true);
    assert.equal(isDeterministicPlannerModel({ provider: 'openai', model: 'gpt-x' }), false);

    const det = normalizePlannerModelConfig('deterministic-baseline');
    assert.equal(det.mode, 'deterministic');
    assert.equal(det.label, 'deterministic-baseline');

    const llm = normalizePlannerModelConfig({ provider: 'openai', model: 'gpt-x' });
    assert.equal(llm.mode, 'llm');
    assert.equal(llm.provider, 'openai');
    assert.equal(llm.model, 'gpt-x');
    assert.equal(llm.configId, 'openai/gpt-x');
    assert.equal(llm.label, 'openai/gpt-x');
});

// ---------- cost estimation (no fabricated values) ----------

test('llm benchmark: cost estimation only with explicit pricing', () => {
    assert.equal(estimateCost({ inputTokens: 1000, outputTokens: 500 }, null), null);
    assert.equal(estimateCost({ inputTokens: 1000, outputTokens: 500 }, {}), null);
    assert.equal(estimateCost({ inputTokens: null, outputTokens: null }, { input_per_1k: 1, output_per_1k: 2 }), null);

    const cost = estimateCost({ inputTokens: 1000, outputTokens: 500 }, { input_per_1k: 0.01, output_per_1k: 0.02 });
    assert.ok(Math.abs(cost - 0.02) < 1e-9);

    const perMillion = estimateCost({ inputTokens: 1000000, outputTokens: 0 }, { input_per_1m: 1.5, output_per_1m: 2 });
    assert.ok(Math.abs(perMillion - 1.5) < 1e-9);
});

// ---------- adapter behavior with mocked provider ----------

test('llm benchmark: adapter success path records metrics and planner outputs', async () => {
    const metrics = new BenchmarkMetrics({ scenarioName: 'adapter_test', plannerModel: 'mock/mock-a' });
    const model = makeMockModel({ usage: { input_total: 100, output: 50, total: 150 } });
    const adapter = new LlmPlannerAdapter({
        modelConfig: { provider: 'mock', model: 'mock-a' },
        metrics,
        limits: { maxModelCalls: 5, maxRetries: 1, timeoutMs: 5000 },
        modelFactory: mockFactoryFor(model),
        pricing: { input_per_1k: 0.01, output_per_1k: 0.02 },
    });

    const response = await adapter.sendRequest([{ role: 'user', content: 'plan' }], 'system');
    assert.equal(response, REPLAN_JSON);

    const stats = adapter.getStats();
    assert.equal(stats.calls, 1);
    assert.equal(stats.successfulCalls, 1);
    assert.equal(stats.failedCalls, 0);
    assert.equal(stats.retries, 0);
    assert.equal(stats.inputTokens, 100);
    assert.equal(stats.outputTokens, 50);
    assert.equal(stats.totalTokens, 150);
    assert.ok(stats.estimatedCost > 0);
    assert.equal(stats.plannerFailures, 0);

    assert.equal(metrics.llm.calls, 1);
    assert.equal(metrics.llm.successful_calls, 1);
    assert.equal(metrics.LLM_calls, 1); // legacy counter stays in sync
    assert.equal(metrics.llm.total_tokens, 150);

    const outputs = adapter.getPlannerOutputs();
    assert.equal(outputs.length, 1);
    assert.equal(outputs[0].configId, 'mock/mock-a');
    assert.ok(outputs[0].response.includes('mocked replan'));
});

test('llm benchmark: adapter retries once then succeeds', async () => {
    const metrics = new BenchmarkMetrics({ scenarioName: 'retry_test' });
    const model = makeMockModel({ failTimes: 1 });
    const adapter = new LlmPlannerAdapter({
        modelConfig: { provider: 'mock', model: 'mock-retry' },
        metrics,
        limits: { maxRetries: 2, timeoutMs: 5000 },
        modelFactory: mockFactoryFor(model),
    });

    const response = await adapter.sendRequest([{ role: 'user', content: 'plan' }], 'system');
    assert.equal(response, REPLAN_JSON);
    assert.equal(model.state.invocations, 2);

    const stats = adapter.getStats();
    assert.equal(stats.calls, 1); // one top-level call
    assert.equal(stats.retries, 1);
    assert.equal(stats.successfulCalls, 1);
    assert.equal(metrics.llm.retries, 1);
});

test('llm benchmark: adapter failure after retries throws without crashing', async () => {
    const metrics = new BenchmarkMetrics({ scenarioName: 'fail_test' });
    const model = makeMockModel({ failAlways: true });
    const adapter = new LlmPlannerAdapter({
        modelConfig: { provider: 'mock', model: 'mock-fail' },
        metrics,
        limits: { maxRetries: 1, timeoutMs: 5000 },
        modelFactory: mockFactoryFor(model),
    });

    await assert.rejects(() => adapter.sendRequest([{ role: 'user', content: 'x' }], 's'), BenchmarkLlmError);
    assert.equal(model.state.invocations, 2); // 1 initial + 1 retry

    const stats = adapter.getStats();
    assert.equal(stats.calls, 1);
    assert.equal(stats.failedCalls, 1);
    assert.equal(stats.plannerFailures, 1);
    assert.equal(stats.retries, 1);
    assert.equal(metrics.llm.failed_calls, 1);
    assert.equal(metrics.llm.planner_failures, 1);
    assert.equal(metrics.LLM_failures, 1);
});

test('llm benchmark: adapter enforces max model calls', async () => {
    const model = makeMockModel({});
    const adapter = new LlmPlannerAdapter({
        modelConfig: { provider: 'mock', model: 'mock-limit' },
        limits: { maxModelCalls: 1, maxRetries: 0, timeoutMs: 5000 },
        modelFactory: mockFactoryFor(model),
    });

    await adapter.sendRequest([{ role: 'user', content: 'a' }], 's');
    const err = await adapter.sendRequest([{ role: 'user', content: 'b' }], 's').then(
        () => null,
        (e) => e
    );
    assert.ok(err instanceof BenchmarkLlmError);
    assert.equal(err.code, 'LIMIT_EXCEEDED');
    assert.equal(model.state.invocations, 1); // blocked before calling provider
});

test('llm benchmark: adapter timeout is retried then reported', async () => {
    const metrics = new BenchmarkMetrics({ scenarioName: 'timeout_test' });
    const model = makeMockModel({ hangMs: 60 });
    const adapter = new LlmPlannerAdapter({
        modelConfig: { provider: 'mock', model: 'mock-hang' },
        metrics,
        limits: { maxRetries: 1, timeoutMs: 15 },
        modelFactory: mockFactoryFor(model),
    });

    const err = await adapter.sendRequest([{ role: 'user', content: 'x' }], 's').then(
        () => null,
        (e) => e
    );
    assert.ok(err instanceof BenchmarkLlmError);
    assert.equal(err.code, 'TIMEOUT');
    assert.equal(metrics.llm.retries, 1);
    assert.equal(metrics.llm.failed_calls, 1);
});

test('llm benchmark: adapter enforces estimated-cost cap', async () => {
    const model = makeMockModel({ usage: { input_total: 100000, output: 50000, total: 150000 } });
    const adapter = new LlmPlannerAdapter({
        modelConfig: { provider: 'mock', model: 'mock-cost' },
        limits: { maxRetries: 0, timeoutMs: 5000, maxEstimatedCost: 0.0001 },
        modelFactory: mockFactoryFor(model),
        pricing: { input_per_1k: 1, output_per_1k: 1 },
    });

    const err = await adapter.sendRequest([{ role: 'user', content: 'x' }], 's').then(
        () => null,
        (e) => e
    );
    assert.ok(err instanceof BenchmarkLlmError);
    assert.equal(err.code, 'COST_EXCEEDED');
});

// ---------- metrics collection / aggregation / versioning ----------

test('llm benchmark: metrics aggregate tokens, cost, latency without fabrication', () => {
    const m = new BenchmarkMetrics({
        scenarioName: 'agg',
        plannerModel: { provider: 'mock', model: 'm1' },
    });
    assert.equal(m.runMode, 'llm');
    assert.equal(m.modelProvider, 'mock');
    assert.equal(m.modelConfigId, 'mock/m1');
    assert.equal(m.benchmarkVersion, BENCHMARK_VERSION);

    // Unknown usage stays null
    m.recordModelCall({ success: true, latencyMs: 100 });
    assert.equal(m.llm.calls, 1);
    assert.equal(m.llm.input_tokens, null);
    assert.equal(m.llm.total_tokens, null);
    assert.equal(m.llm.estimated_cost, null);
    assert.equal(m.llm.cumulative_latency_ms, 100);
    assert.equal(m.llm.avg_latency_ms, 100);

    m.recordModelCall({ success: true, inputTokens: 100, outputTokens: 50, totalTokens: 150, estimatedCost: 0.01, latencyMs: 300 });
    assert.equal(m.llm.calls, 2);
    assert.equal(m.llm.input_tokens, 100);
    assert.equal(m.llm.output_tokens, 50);
    assert.equal(m.llm.total_tokens, 150);
    assert.equal(m.llm.estimated_cost, 0.01);
    assert.equal(m.llm.cumulative_latency_ms, 400);
    assert.equal(m.llm.avg_latency_ms, 200);

    m.recordModelRetry();
    assert.equal(m.llm.retries, 1);
    m.incrementPlannerFailures(2);
    assert.equal(m.llm.planner_failures, 2);
});

test('llm benchmark: metrics round-trip and legacy backwards compatibility', () => {
    const m = new BenchmarkMetrics({ scenarioName: 'rt', plannerModel: { provider: 'mock', model: 'm2' } });
    m.recordModelCall({ success: true, inputTokens: 10, outputTokens: 5, totalTokens: 15, estimatedCost: 0.001, latencyMs: 42 });
    m.setCompletion(true, 100, 3);
    m.finish();

    const restored = BenchmarkMetrics.fromJSON(JSON.parse(JSON.stringify(m.toJSON())));
    assert.equal(restored.runMode, 'llm');
    assert.equal(restored.modelConfigId, 'mock/m2');
    assert.equal(restored.benchmarkVersion, BENCHMARK_VERSION);
    assert.equal(restored.llm.calls, 1);
    assert.equal(restored.llm.total_tokens, 15);
    assert.equal(restored.llm.estimated_cost, 0.001);

    // Legacy v1 payload (no runMode/benchmarkVersion/llm) still loads.
    const legacy = BenchmarkMetrics.fromJSON({
        runId: 'legacy_1',
        scenario: 'wheat_farm_benchmark',
        plannerModel: 'deterministic-baseline',
        seed: 1,
        completion: true,
        completionPct: 100,
        LLM_calls: 2,
        LLM_failures: 0,
    });
    assert.equal(legacy.runMode, 'deterministic');
    assert.equal(legacy.benchmarkVersion, '1.0.0');
    assert.equal(legacy.llm.calls, 0);
    assert.equal(legacy.llm.total_tokens, null);
    assert.equal(legacy.llm.estimated_cost, null);
    assert.equal(legacy.LLM_calls, 2);
});

// ---------- deterministic vs LLM comparison ----------

test('llm benchmark: comparator covers deterministic baseline vs LLM', () => {
    const det = new BenchmarkMetrics({ scenarioName: 'wheat_farm_benchmark', plannerModel: 'deterministic-baseline' });
    det.total_steps = 4;
    det.recordStep({ title: 'a', outcome: 'success', attempts: 1, failed: false });
    det.setCompletion(true, 100, 4);
    det.computeRecoveryQuality([], []);
    det.computeScore();
    det.finish();

    const llm = new BenchmarkMetrics({ scenarioName: 'wheat_farm_benchmark', plannerModel: { provider: 'mock', model: 'm3' } });
    llm.total_steps = 4;
    llm.recordStep({ title: 'a', outcome: 'success', attempts: 1, failed: false });
    llm.recordModelCall({ success: true, inputTokens: 200, outputTokens: 100, totalTokens: 300, estimatedCost: 0.005, latencyMs: 250 });
    llm.setCompletion(true, 100, 4);
    llm.computeRecoveryQuality([], []);
    llm.computeScore();
    llm.finish();

    const comparator = new ModelComparator();
    comparator.addRuns([det, llm]);
    const result = comparator.compare();
    assert.ok(result.models.includes('deterministic-baseline'));
    assert.ok(result.models.includes('mock/m3'));
    assert.equal(result.leaderboard.length, 2);

    const llmEntry = result.leaderboard.find((e) => e.model === 'mock/m3');
    assert.equal(llmEntry.llmCalls, 1);
    assert.equal(llmEntry.totalTokens, 300);
    assert.equal(llmEntry.estimatedCost, 0.005);
    assert.equal(llmEntry.avgLatencyMs, 250);

    const detEntry = result.leaderboard.find((e) => e.model === 'deterministic-baseline');
    assert.equal(detEntry.llmCalls, 0);
    assert.equal(detEntry.totalTokens, null);

    const table = comparator.generateLlmComparisonTable(result);
    for (const header of ['Model', 'Avg Score', 'Completion', 'Recovery Quality', 'Replans', 'Retries', 'LLM Calls', 'Tokens', 'Est Cost', 'Avg Latency']) {
        assert.ok(table.includes(header), `table missing ${header}`);
    }
    assert.ok(table.includes('mock/m3'));
    assert.ok(table.includes('deterministic-baseline'));
});

// ---------- persistence / versioning ----------

test('llm benchmark: store persists versioned LLM runs without touching baseline', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mindcraft-bench-llm-store-'));
    try {
        const store = new BenchmarkStore(dir);
        const m = new BenchmarkMetrics({ scenarioName: 'persist_llm', plannerModel: { provider: 'mock', model: 'm4' } });
        m.recordModelCall({ success: true, inputTokens: 5, outputTokens: 5, totalTokens: 10, latencyMs: 11 });
        m.setCompletion(true, 100, 1);
        m.finish();
        const fp = store.save(m);
        assert.ok(fs.existsSync(fp));

        const loaded = store.load(m.runId);
        assert.equal(loaded.runMode, 'llm');
        assert.equal(loaded.modelConfigId, 'mock/m4');
        assert.equal(loaded.benchmarkVersion, BENCHMARK_VERSION);
        assert.equal(loaded.llm.total_tokens, 10);

        const list = store.list();
        assert.equal(list.length, 1);
        assert.equal(list[0].runMode, 'llm');
        assert.equal(list[0].benchmarkVersion, BENCHMARK_VERSION);
        assert.equal(list[0].llmCalls, 1);

        // Deterministic baseline blob shape still loads next to LLM runs.
        const baselineFp = path.join(dir, 'baseline_smoke.json');
        fs.writeFileSync(baselineFp, JSON.stringify({ name: 'smoke', avgScore: 90, runs: [] }));
        assert.ok(store.loadBaseline('smoke'));
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

// ---------- replay metadata ----------

test('llm benchmark: replay distinguishes deterministic vs stochastic runs', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mindcraft-bench-llm-replay-'));
    try {
        const logger = new ReplayLogger({
            runId: 'replay_llm_1',
            scenario: 'wheat_farm_benchmark',
            seed: 42,
            runMode: 'llm',
            modelProvider: 'mock',
            modelName: 'm5',
            modelConfigId: 'mock/m5',
        });
        logger.recordPlannerOutputs([{ provider: 'mock', model: 'm5', configId: 'mock/m5', response: REPLAN_JSON, latencyMs: 5, attempt: 0 }]);
        logger.setFinalMetrics({ completion: true, completionPct: 100, total_steps: 1, successful_steps: 1, score: { total: 90 } });
        const fp = logger.save(dir);
        const player = ReplayPlayer.fromFile(fp);
        assert.ok(player);
        assert.equal(player.isDeterministicRun(), false);
        assert.equal(player.getRunMode(), 'llm');
        assert.deepEqual(player.getModelInfo().configId, 'mock/m5');
        assert.equal(player.getPlannerOutputs().length, 1);

        const cmp = player.compareWithNewRun({ completion: true, total_steps: 1, successful_steps: 1, score: { total: 90 } });
        assert.equal(cmp.stochastic, true);
        assert.equal(cmp.isDeterministic, false);
        assert.match(cmp.reason, /stochastic/);
        assert.match(player.generateReproScript(), /stochastic/);
        assert.match(player.generateReport(), /model-dependent/);

        // Deterministic replay keeps claiming reproducibility.
        const detLogger = new ReplayLogger({ runId: 'replay_det_1', scenario: 'wheat_farm_benchmark', seed: 7 });
        const detFp = detLogger.save(dir);
        const detPlayer = ReplayPlayer.fromFile(detFp);
        assert.equal(detPlayer.isDeterministicRun(), true);
        assert.doesNotMatch(detPlayer.generateReproScript(), /stochastic/);

        // Legacy replay JSON without runMode defaults to deterministic.
        const legacyPlayer = new ReplayPlayer({ runId: 'old', scenario: 'x', seed: 1, finalMetrics: { completion: true } });
        assert.equal(legacyPlayer.isDeterministicRun(), true);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

// ---------- end-to-end mocked LLM evaluation through the same pipeline ----------

test('llm benchmark: mocked LLM run uses the same scenario pipeline', async () => {
    const scenario = createWheatFarmScenario();
    const beforeSteps = JSON.stringify(scenario.project.steps);
    const model = makeMockModel({ usage: { input_total: 500, output: 200, total: 700 } });
    const harness = new BenchmarkHarness(scenario, {
        plannerModel: { provider: 'mock', model: 'mock-e2e' },
        seed: 123,
        modelFactory: mockFactoryFor(model),
        llmLimits: { maxModelCalls: 20, maxRetries: 1, timeoutMs: 5000 },
        llmPricing: { input_per_1k: 0.01, output_per_1k: 0.02 },
    });

    const result = await harness.run();
    try {
        // Same scenario definition / initial world / injections / seed.
        assert.equal(JSON.stringify(scenario.project.steps), beforeSteps);
        assert.equal(result.metrics.runMode, 'llm');
        assert.equal(result.metrics.modelConfigId, 'mock/mock-e2e');
        assert.equal(result.metrics.benchmarkVersion, BENCHMARK_VERSION);
        // LLM only replaced planner decisions: executor/observer/recovery still ran.
        assert.ok(result.metrics.successful_steps > 0);
        assert.ok(Object.keys(result.metrics.recovery_actions).length > 0);
        assert.ok(result.metrics.events.some((e) => e.type === 'injection_applied'));
        assert.ok(result.metrics.llm.calls >= 1);
        assert.equal(result.metrics.llm.total_tokens, 700 * result.metrics.llm.calls);
        assert.ok(result.metrics.llm.estimated_cost > 0);
        assert.ok(harness.getPlannerOutputs().length >= 1);
        assert.ok(result.metrics.score.total > 0);
    } finally {
        harness.cleanup();
    }
}, { timeout: 15000 });

test('llm benchmark: provider failures do not crash the harness', async () => {
    const scenario = createWheatFarmScenario();
    const model = makeMockModel({ failAlways: true });
    const harness = new BenchmarkHarness(scenario, {
        plannerModel: { provider: 'mock', model: 'mock-broken' },
        seed: 456,
        modelFactory: mockFactoryFor(model),
        llmLimits: { maxRetries: 0, timeoutMs: 2000 },
    });

    const result = await harness.run();
    try {
        assert.ok(result.metrics);
        assert.ok(result.metrics.llm.failed_calls >= 1);
        assert.ok(result.metrics.llm.planner_failures >= 1);
        assert.ok(result.metrics.events.some((e) => e.type === 'planner_failed'));
        assert.ok(result.metrics.score.total >= 0);
    } finally {
        harness.cleanup();
    }
}, { timeout: 15000 });

test('llm benchmark: runner persists mocked LLM run with replay metadata', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mindcraft-bench-llm-runner-'));
    try {
        const model = makeMockModel({ usage: { input_total: 50, output: 25, total: 75 } });
        const runner = new BenchmarkSuiteRunner({
            scenarios: ['wheat_farm_benchmark'],
            plannerModel: { provider: 'mock', model: 'mock-runner' },
            storeDir: dir,
            seed: 999,
            modelFactory: mockFactoryFor(model),
            llmLimits: { maxModelCalls: 20, maxRetries: 1, timeoutMs: 5000 },
        });

        const result = await runner.runSingleScenario('wheat_farm_benchmark', { seed: 999 });
        assert.ok(result.metricsPath);
        assert.ok(fs.existsSync(result.metricsPath));
        assert.ok(result.replayPath);
        assert.ok(fs.existsSync(result.replayPath));

        const saved = JSON.parse(fs.readFileSync(result.metricsPath, 'utf8'));
        assert.equal(saved.runMode, 'llm');
        assert.equal(saved.modelConfigId, 'mock/mock-runner');
        assert.equal(saved.benchmarkVersion, BENCHMARK_VERSION);
        assert.ok(saved.llm.calls >= 1);
        assert.ok(saved.score.total > 0);
        assert.ok(saved.recovery_quality);

        const replay = JSON.parse(fs.readFileSync(result.replayPath, 'utf8'));
        assert.equal(replay.runMode, 'llm');
        assert.equal(replay.modelConfigId, 'mock/mock-runner');
        assert.equal(replay.seed, 999);
        assert.ok((replay.plannerOutputs || []).length >= 1);

        const player = ReplayPlayer.fromFile(result.replayPath);
        assert.equal(player.isDeterministicRun(), false);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
}, { timeout: 15000 });

test('llm benchmark: runner enforces max scenarios and suite call caps', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mindcraft-bench-llm-limits-'));
    try {
        // maxScenarios slices the suite.
        const sliced = new BenchmarkSuiteRunner({
            scenarios: ['wheat_farm_benchmark', 'iron_mine_benchmark'],
            plannerModel: 'deterministic',
            storeDir: dir,
            seed: 11,
            enableReplay: false,
            llmLimits: { maxScenarios: 1 },
        });
        const slicedResult = await sliced.runAll();
        assert.equal(slicedResult.results.length, 1);

        // Suite-wide call cap aborts remaining scenarios once reached.
        const probeModel = makeMockModel({});
        const probe = new BenchmarkSuiteRunner({
            scenarios: ['wheat_farm_benchmark'],
            plannerModel: { provider: 'mock', model: 'mock-cap' },
            storeDir: dir,
            seed: 12,
            enableReplay: false,
            modelFactory: mockFactoryFor(probeModel),
        });
        const probeResult = await probe.runAll();
        const usedCalls = probeResult.metricsList[0]?.llm?.calls || 0;
        assert.ok(usedCalls >= 1, 'probe scenario should exercise the planner model');

        const cappedModel = makeMockModel({});
        const capped = new BenchmarkSuiteRunner({
            scenarios: ['wheat_farm_benchmark', 'iron_mine_benchmark'],
            plannerModel: { provider: 'mock', model: 'mock-cap' },
            storeDir: dir,
            seed: 12,
            enableReplay: false,
            modelFactory: mockFactoryFor(cappedModel),
            llmLimits: { maxTotalModelCalls: usedCalls },
        });
        const cappedResult = await capped.runAll();
        assert.ok(capped.suiteAborted, 'suite should abort once the call cap is reached');
        assert.equal(cappedResult.results.length, 2);
        assert.equal(cappedResult.results[1].skipped, true);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
}, { timeout: 30000 });

// ---------- backwards compatibility ----------

test('llm benchmark: deterministic runs are unchanged (no LLM calls, same behavior)', async () => {
    const scenario = createWheatFarmScenario();
    const harness = new BenchmarkHarness(scenario, { plannerModel: 'deterministic-test', seed: 321 });
    const result = await harness.run();
    try {
        assert.equal(result.metrics.runMode, 'deterministic');
        assert.equal(result.metrics.llm.calls, 0);
        assert.equal(result.metrics.llm.total_tokens, null);
        assert.equal(result.metrics.llm.estimated_cost, null);
        assert.equal(result.metrics.completion, true);
        assert.deepEqual(harness.getPlannerOutputs(), []);
        assert.equal(harness.getLlmStats(), null);
    } finally {
        harness.cleanup();
    }
}, { timeout: 15000 });

test('llm benchmark: all 8 existing scenarios remain available', () => {
    assert.equal(ALL_SCENARIOS.length, 8);
    for (const name of [
        'wheat_farm_benchmark',
        'iron_mine_benchmark',
        'shelter_build_benchmark',
        'tree_farm_benchmark',
        'village_outpost_benchmark',
        'nether_expedition_benchmark',
        'adversarial_depleted_alternatives_benchmark',
        'adversarial_trap_target_benchmark',
    ]) {
        assert.ok(ALL_SCENARIOS.includes(name), `missing scenario ${name}`);
    }
    // Spot-check that untouched scenario factories still build.
    assert.equal(createWheatFarmScenario().name, 'wheat_farm_benchmark');
    assert.equal(createIronMineScenario().name, 'iron_mine_benchmark');
});
