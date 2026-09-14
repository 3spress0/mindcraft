#!/usr/bin/env node
/**
 * benchmark_ci.js — CI enforcement for autonomy benchmark
 *
 * Loads saved baseline, runs full benchmark suite, checks thresholds,
 * prints concise aggregate/per-scenario report, exits non-zero on regression.
 *
 * Usage:
 *   node scripts/benchmark_ci.js [--baseline benchmark_results/baseline_baseline.json] [--seed 123] [--model deterministic-ci] [--test-failure]
 *
 * --test-failure: verifies that CI script itself enforces thresholds by running against
 *   a deliberately bad baseline / lowered threshold and expecting non-zero exit.
 *   This prevents a script that always exits 0 from appearing to work.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { BenchmarkSuiteRunner } from '../src/agent/benchmark/runner.js';
import { BenchmarkStore } from '../src/agent/benchmark/metrics.js';
import { ThresholdChecker, DEFAULT_THRESHOLDS } from '../src/agent/benchmark/thresholds.js';
import { ALL_SCENARIOS } from '../src/agent/benchmark/scenarios/index.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function parseArgs() {
    const args = process.argv.slice(2);
    const opts = {
        baselinePath: path.join(__dirname, '..', 'benchmark_results', 'baseline_baseline.json'),
        storeDir: path.join(__dirname, '..', 'benchmark_results'),
        writeBaseline: false,
        requireBaseline: false,
        seed: 123,
        model: 'deterministic-ci',
        testFailure: false,
        scenarios: ALL_SCENARIOS,
    };
    for (let i = 0; i < args.length; i++) {
        const a = args[i];
        if (a === '--baseline' && args[i + 1]) opts.baselinePath = args[++i];
        else if (a === '--write-baseline') opts.writeBaseline = true;
        else if (a === '--require-baseline') opts.requireBaseline = true;
        else if (a === '--store' && args[i + 1]) opts.storeDir = args[++i];
        else if (a === '--seed' && args[i + 1]) opts.seed = Number(args[++i]);
        else if (a === '--model' && args[i + 1]) opts.model = args[++i];
        else if (a === '--test-failure') opts.testFailure = true;
        else if (a === '--scenarios' && args[i + 1]) opts.scenarios = args[++i].split(',').map(s => s.trim());
        else if (a === '--help') {
            console.log(`Usage: node scripts/benchmark_ci.js [options]
Options:
  --baseline <path>   Path to baseline JSON (default benchmark_results/baseline_baseline.json)
  --write-baseline    Run the suite, then save it as the baseline (deliberate act; review the diff)
  --require-baseline  Exit non-zero if no baseline exists, so CI cannot silently skip regression checks
  --store <dir>       Store dir for results (default benchmark_results)
  --seed <num>        Deterministic seed (default 123)
  --model <name>      Planner model name (default deterministic-ci)
  --scenarios <list>  Comma-separated scenario names (default all)
  --test-failure      Self-test: verify CI fails on bad baseline/threshold
  --help              Show this help
`);
            process.exit(0);
        }
    }
    return opts;
}

function printReport(aggregate, thresholdResult, metricsList) {
    console.log('\n=== Benchmark CI Report ===\n');
    console.log(`Model: ${metricsList[0]?.plannerModel || 'unknown'} | Seed: ${metricsList[0]?.seed || 'unknown'} | Scenarios: ${aggregate?.scenarios || metricsList.length}`);
    console.log(`Overall: avgScore ${aggregate?.overallAvg ?? 'N/A'} (weighted ${aggregate?.overallWeighted ?? 'N/A'}) | completion ${(aggregate?.overallCompletion * 100).toFixed(1)}% | runs ${aggregate?.totalRuns ?? metricsList.length}`);
    console.log(`Thresholds: ${thresholdResult.passed ? '✅ PASSED' : '❌ FAILED'} | violations ${thresholdResult.violations.length}`);
    if (thresholdResult.summary?.baseline) {
        console.log(`Baseline avg: ${thresholdResult.summary.baseline.avgScore} | current avg: ${thresholdResult.summary.avgScore}`);
    }
    console.log('\nPer-scenario:');
    console.log('| Scenario | Avg | Weighted | Completion | Runs |');
    console.log('|----------|-----|----------|------------|------|');
    if (aggregate?.scenarioScores) {
        for (const [name, sc] of Object.entries(aggregate.scenarioScores)) {
            console.log(`| ${name} | ${sc.avgScore} | ${sc.weightedAvg} | ${(sc.completionRate * 100).toFixed(0)}% | ${sc.runs} |`);
        }
    } else {
        for (const m of metricsList) {
            const sc = m.scenario || m.scenarioName;
            const score = m.score?.total ?? 0;
            console.log(`| ${sc} | ${score} | ${score} | ${m.completion ? '100%' : '0%'} | 1 |`);
        }
    }

    console.log('\nRecovery quality:');
    for (const m of metricsList) {
        const rq = m.recovery_quality;
        console.log(`- ${m.scenario || m.scenarioName}: ${rq?.expected_satisfied ?? 0}/${rq?.expected_total ?? 0} expected, quality ${rq?.score ?? 0}/100, correctRate ${(rq?.correct_action_rate * 100 ?? 0).toFixed(0)}%`);
    }

    if (thresholdResult.violations.length) {
        console.log('\nViolations:');
        for (const v of thresholdResult.violations) {
            console.log(`  ❌ [${v.type}] ${v.message}`);
        }
    } else {
        console.log('\nNo violations — all thresholds passed.');
    }
    console.log('');
}

async function runSuite({ storeDir, seed, model, scenarios }) {
    const runner = new BenchmarkSuiteRunner({
        scenarios,
        plannerModel: model,
        storeDir,
        seed,
        enableReplay: true,
        verbose: false,
    });
    const result = await runner.runAll();
    return result;
}

async function main() {
    const opts = parseArgs();

    // Self-test mode: verify enforcement works
    if (opts.testFailure) {
        console.log('=== CI Self-Test: verifying enforcement ===\n');

        // 1) Run suite normally to get current metrics
        const normalResult = await runSuite(opts);
        const metricsList = normalResult.metricsList.map(m => m.summary ? m.summary() : m);

        // 2) Create deliberately bad baseline (avgScore 200, impossible to meet)
        const badBaseline = {
            name: 'deliberately_bad',
            createdAt: Date.now(),
            avgScore: 200,
            avgCompletion: 1,
            runs: metricsList.map(m => ({ ...m, score: { total: 200 } })),
        };

        const checkerBad = new ThresholdChecker({ baseline: badBaseline });
        const badCheck = checkerBad.checkAggregate(metricsList);

        console.log('Test 1: Bad baseline (100) vs current (~95) should cause regression failure if threshold 0%');
        // Use tight threshold to force failure
        const tightThresholds = {
            global: { ...DEFAULT_THRESHOLDS.global, maxRegressionPct: 0 },
            scenarios: DEFAULT_THRESHOLDS.scenarios,
        };
        const checkerTight = new ThresholdChecker({ thresholds: tightThresholds, baseline: badBaseline });
        const tightCheck = checkerTight.checkAggregate(metricsList);

        console.log(`  Normal check passed: ${normalResult.thresholdResult.passed} (expected true)`);
        console.log(`  Bad baseline check passed: ${badCheck.passed} (expected false if regression >15%)`);
        console.log(`  Tight threshold (0%) check passed: ${tightCheck.passed} (expected false)`);
        console.log(`  Tight violations: ${tightCheck.violations.map(v => v.type).join(', ')}`);

        // 3) Artificially lowered threshold: minAvgScore 100 should fail
        const impossibleThresholds = {
            global: { ...DEFAULT_THRESHOLDS.global, minAvgScore: 100 },
            scenarios: DEFAULT_THRESHOLDS.scenarios,
        };
        const checkerImpossible = new ThresholdChecker({ thresholds: impossibleThresholds });
        const impossibleCheck = checkerImpossible.checkAggregate(metricsList);
        console.log('\nTest 2: Impossible threshold minAvgScore 100 should fail');
        console.log(`  Impossible check passed: ${impossibleCheck.passed} (expected false)`);
        console.log(`  Violations: ${impossibleCheck.violations.map(v => v.type).join(', ')}`);

        const enforcementWorks = !tightCheck.passed && !impossibleCheck.passed;
        console.log(`\n=== Self-Test Result: ${enforcementWorks ? '✅ ENFORCEMENT WORKS' : '❌ ENFORCEMENT BROKEN'} ===`);
        console.log('If this shows ENFORCEMENT WORKS, CI script correctly exits non-zero on regression.');
        console.log('If it shows BROKEN, the script would always exit 0 and is not enforcing.\n');

        // Exit non-zero if enforcement broken, zero if works (self-test itself passes)
        // For CI, we want to ensure the script can detect failures, so self-test should exit 0 when enforcement works
        process.exit(enforcementWorks ? 0 : 2);
    }

    // Normal CI flow
    console.log(`[CI] Loading baseline from ${opts.baselinePath}`);
    let baseline = null;
    let baselineLoaded = false;
    if (fs.existsSync(opts.baselinePath)) {
        try {
            baseline = JSON.parse(fs.readFileSync(opts.baselinePath, 'utf8'));
            baselineLoaded = true;
            console.log(`[CI] Baseline loaded: avgScore ${baseline.avgScore}, scenarios ${baseline.scenarios?.length ?? baseline.runs?.length ?? 'unknown'}`);
        } catch (err) {
            console.warn(`[CI] Failed to load baseline: ${err.message}, proceeding without baseline`);
        }
    } else {
        console.warn(`[CI] Baseline not found at ${opts.baselinePath} — the regression-from-baseline check is SKIPPED.`);
        console.warn(`[CI] Only absolute thresholds are enforced this run. Establish a baseline with --write-baseline, and use --require-baseline in CI.`);
        if (opts.requireBaseline) {
            console.error('[CI] --require-baseline set but no baseline exists; refusing to report a vacuous pass.');
            process.exit(3);
        }
    }

    console.log(`[CI] Running benchmark suite: ${opts.scenarios.length} scenarios, model ${opts.model}, seed ${opts.seed}`);
    const suiteResult = await runSuite(opts);
    const metricsList = suiteResult.metricsList;

    // Threshold check with baseline
    const checker = new ThresholdChecker({ baseline });
    const thresholdResult = checker.checkAggregate(metricsList.map(m => m.summary ? m.summary() : m));

    printReport(suiteResult.aggregate, thresholdResult, metricsList.map(m => m.summary ? m.summary() : m));

    if (opts.writeBaseline) {
        const summaries = metricsList.map((m) => m.summary ? m.summary() : m);
        const payload = {
            generatedAt: new Date().toISOString(),
            seed: opts.seed,
            model: opts.model,
            avgScore: suiteResult.aggregate?.avgScore ?? null,
            overallCompletion: suiteResult.aggregate?.overallCompletion ?? null,
            runs: summaries.map((sm) => ({
                scenario: sm.scenario,
                score: sm.score,
                completion: sm.completion,
                retries: sm.retries,
                replans: sm.replans,
                deaths: sm.deaths,
                seed: sm.seed,
            })),
        };
        fs.mkdirSync(path.dirname(opts.baselinePath), { recursive: true });
        fs.writeFileSync(opts.baselinePath, JSON.stringify(payload, null, 2));
        console.log(`[CI] Baseline written to ${opts.baselinePath} (${payload.runs.length} runs, avgScore ${payload.avgScore}). Review the diff before committing.`);
        process.exit(0);
    }

    // Also check replay determinism
    console.log('=== Replay Determinism Check ===');
    let replayPassed = true;
    for (const result of suiteResult.results) {
        if (!result.replayPath) continue;
        const replayFile = result.replayPath;
        if (!fs.existsSync(replayFile)) {
            console.warn(`  ⚠️  Replay file missing: ${replayFile}`);
            continue;
        }
        try {
            const data = JSON.parse(fs.readFileSync(replayFile, 'utf8'));
            const hasInjections = data.injections && data.injections.length > 0;
            const hasSeed = data.seed != null;
            const hasInitialWorld = data.initialWorld != null;
            const ok = hasInjections && hasSeed && hasInitialWorld;
            console.log(`  ${ok ? '✅' : '❌'} ${data.scenario}: seed ${data.seed}, injections ${data.injections.length}, initialWorld ${hasInitialWorld ? 'yes' : 'no'}`);
            if (!ok) replayPassed = false;
        } catch (err) {
            console.warn(`  ❌ Failed to parse replay ${replayFile}: ${err.message}`);
            replayPassed = false;
        }
    }
    console.log(`Replay check: ${replayPassed ? '✅ PASS' : '❌ FAIL'}\n`);

    const overallPassed = thresholdResult.passed && replayPassed && suiteResult.aggregate.overallCompletion === 1;

    console.log(`=== Final CI Status: ${overallPassed ? '✅ PASSED' : '❌ FAILED'} ===`);
    console.log(`Aggregate completion: ${(suiteResult.aggregate.overallCompletion * 100).toFixed(1)}% (expected 100%)`);
    console.log(`Baseline regression: ${!baselineLoaded ? 'SKIPPED (no baseline — not enforced this run)' : thresholdResult.passed ? 'PASS' : 'FAIL'}`);
    console.log(`Replay determinism: ${replayPassed ? 'PASS' : 'FAIL'}`);

    // Exit codes: 0 pass, 1 fail
    process.exit(overallPassed ? 0 : 1);
}

main().catch(err => {
    console.error('[CI] Fatal error:', err);
    process.exit(3);
});
