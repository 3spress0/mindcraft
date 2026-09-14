#!/usr/bin/env node
/**
 * benchmark_llm.js — run the deterministic benchmark scenarios with a real LLM planner.
 *
 * The same scenario definitions, initial worlds, injections, and seeds are used as the
 * deterministic baseline; only the planner's model-decision function is swapped for a
 * real provider model (resolved via settings_llm_providers.json + environment keys,
 * exactly like normal agent profiles). Executor, observer, world model, critic, and
 * recovery/verification are unchanged.
 *
 * Model selection follows the repository's profile convention:
 *   node scripts/benchmark_llm.js --provider openai --model gpt-5.4-mini
 *   node scripts/benchmark_llm.js --model openai/gpt-5.4-mini
 *   node scripts/benchmark_llm.js --profile profiles/gpt.json
 *
 * Safety: the suite enforces call/retry/timeout limits (and an optional cost cap)
 * so a runaway benchmark cannot make unlimited API calls. See --help.
 *
 * Comparison mode (deterministic baseline vs selected LLM):
 *   node scripts/benchmark_llm.js --provider openai --model gpt-5.4-mini --compare
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { BenchmarkSuiteRunner } from '../src/agent/benchmark/runner.js';
import { ModelComparator } from '../src/agent/benchmark/comparison.js';
import { BENCHMARK_VERSION } from '../src/agent/benchmark/llm_planner.js';
import { ALL_SCENARIOS } from '../src/agent/benchmark/scenarios/index.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function parseArgs() {
    const args = process.argv.slice(2);
    const opts = {
        provider: null,
        model: null,
        profile: null,
        api: null,
        url: null,
        scenarios: ALL_SCENARIOS,
        seed: 123,
        storeDir: path.join(__dirname, '..', 'benchmark_results'),
        baselinePath: path.join(__dirname, '..', 'benchmark_results', 'baseline_baseline.json'),
        maxScenarios: null,
        maxCalls: 200, // suite-wide safety cap (use --max-calls 0 to disable)
        maxModelCalls: 50, // per-scenario cap
        maxRetries: 2,
        maxCost: null,
        timeoutMs: 60000,
        priceIn: null, // USD per 1k input tokens (for cost estimates)
        priceOut: null, // USD per 1k output tokens
        compare: false,
        dryRun: false,
        listScenarios: false,
        useLlmInitialPlan: false,
        verbose: false,
    };
    for (let i = 0; i < args.length; i++) {
        const a = args[i];
        if (a === '--provider' && args[i + 1]) opts.provider = args[++i];
        else if (a === '--model' && args[i + 1]) opts.model = args[++i];
        else if (a === '--profile' && args[i + 1]) opts.profile = args[++i];
        else if (a === '--api' && args[i + 1]) opts.api = args[++i];
        else if (a === '--url' && args[i + 1]) opts.url = args[++i];
        else if (a === '--scenarios' && args[i + 1]) opts.scenarios = args[++i].split(',').map(s => s.trim()).filter(Boolean);
        else if (a === '--seed' && args[i + 1]) opts.seed = Number(args[++i]);
        else if (a === '--store' && args[i + 1]) opts.storeDir = args[++i];
        else if (a === '--baseline' && args[i + 1]) opts.baselinePath = args[++i];
        else if (a === '--max-scenarios' && args[i + 1]) opts.maxScenarios = Number(args[++i]);
        else if (a === '--max-calls' && args[i + 1]) opts.maxCalls = Number(args[++i]);
        else if (a === '--max-model-calls' && args[i + 1]) opts.maxModelCalls = Number(args[++i]);
        else if (a === '--max-retries' && args[i + 1]) opts.maxRetries = Number(args[++i]);
        else if (a === '--max-cost' && args[i + 1]) opts.maxCost = Number(args[++i]);
        else if (a === '--timeout' && args[i + 1]) opts.timeoutMs = Number(args[++i]);
        else if (a === '--price-in' && args[i + 1]) opts.priceIn = Number(args[++i]);
        else if (a === '--price-out' && args[i + 1]) opts.priceOut = Number(args[++i]);
        else if (a === '--compare') opts.compare = true;
        else if (a === '--dry-run') opts.dryRun = true;
        else if (a === '--list-scenarios') opts.listScenarios = true;
        else if (a === '--use-llm-initial-plan') opts.useLlmInitialPlan = true;
        else if (a === '--verbose') opts.verbose = true;
        else if (a === '--help' || a === '-h') {
            printHelp();
            process.exit(0);
        } else {
            console.error(`Unknown argument: ${a}`);
            printHelp();
            process.exit(2);
        }
    }
    return opts;
}

function printHelp() {
    console.log(`Usage: node scripts/benchmark_llm.js [options]

Run the benchmark scenarios with a real LLM planner (same scenarios/seeds as baseline).

Model selection (repository profile convention, pick one style):
  --provider <name>     Provider from settings_llm_providers.json (e.g. openai)
  --model <name>        Model name, or "provider/model" (e.g. gpt-5.4-mini)
  --profile <path>      Profile JSON with a { model: { provider, model } } block
  --api <name>          Optional API/format override (e.g. openai-completions)
  --url <baseUrl>       Optional base URL override (local servers)

Suite selection:
  --scenarios <list>    Comma-separated scenario names (default: all ${ALL_SCENARIOS.length})
  --list-scenarios      Print available scenarios and exit
  --seed <num>          Base seed, shared with deterministic runs (default 123)
  --store <dir>         Results dir (default benchmark_results)
  --baseline <path>     Deterministic baseline for --compare

Safety / cost controls (a runaway benchmark must not make unlimited API calls):
  --max-scenarios <n>   Cap scenarios evaluated
  --max-calls <n>       Suite-wide max model calls (default 200, 0 = unlimited)
  --max-model-calls <n> Per-scenario max model calls (default 50)
  --max-retries <n>     Retries per failed/timed-out call (default 2)
  --max-cost <usd>      Abort suite once estimated cost reaches this (needs usage+pricing)
  --timeout <ms>        Per-attempt model timeout (default 60000)
  --price-in <usd>      USD per 1k input tokens (enables cost estimates)
  --price-out <usd>     USD per 1k output tokens (enables cost estimates)

Modes:
  --compare             After the LLM run, compare deterministic baseline vs LLM
  --use-llm-initial-plan  Let the LLM also generate initial plans (default: scenario
                        steps are kept so runs stay directly comparable; LLM is used
                        for replan decisions)
  --dry-run             Print resolved config/limits and exit without API calls
  --verbose             Verbose per-scenario output
  --help                Show this help

API keys are read from settings_llm_providers.json ( keys section ) or environment
variables, exactly like normal agent runs. This script never takes keys as flags.

Examples:
  node scripts/benchmark_llm.js --provider openai --model gpt-5.4-mini --scenarios wheat_farm_benchmark
  node scripts/benchmark_llm.js --model openai/gpt-5.4-mini --compare --price-in 0.001 --price-out 0.002
  node scripts/benchmark_llm.js --profile profiles/gpt.json --max-scenarios 2 --dry-run
`);
}

function loadProfileModel(profilePath) {
    const resolved = path.isAbsolute(profilePath) ? profilePath : path.join(process.cwd(), profilePath);
    if (!fs.existsSync(resolved)) {
        throw new Error(`Profile not found: ${profilePath}`);
    }
    const profile = JSON.parse(fs.readFileSync(resolved, 'utf8'));
    const model = profile.model;
    if (!model || typeof model !== 'object') {
        throw new Error(`Profile ${profilePath} has no model block`);
    }
    return { ...model };
}

function resolveModelConfig(opts) {
    if (opts.profile) {
        const fromProfile = loadProfileModel(opts.profile);
        if (opts.provider) fromProfile.provider = opts.provider;
        if (opts.model) fromProfile.model = opts.model;
        if (opts.api) fromProfile.api = opts.api;
        if (opts.url) fromProfile.url = opts.url;
        return fromProfile;
    }
    let provider = opts.provider || null;
    let model = opts.model || null;
    if (model && model.includes('/') && !provider) {
        const [prov, ...rest] = model.split('/');
        provider = prov;
        model = rest.join('/');
    }
    if (!provider && !model && !opts.api) {
        throw new Error('Select a model with --provider/--model or --profile (see --help)');
    }
    const config = {};
    if (provider) config.provider = provider;
    if (model) config.model = model;
    if (opts.api) config.api = opts.api;
    if (opts.url) config.url = opts.url;
    return config;
}

function buildLlmLimits(opts) {
    const pricing = (opts.priceIn != null || opts.priceOut != null)
        ? {
            ...(opts.priceIn != null ? { input_per_1k: opts.priceIn } : {}),
            ...(opts.priceOut != null ? { output_per_1k: opts.priceOut } : {}),
        }
        : null;
    return {
        ...(opts.maxScenarios != null ? { maxScenarios: opts.maxScenarios } : {}),
        maxModelCalls: opts.maxModelCalls,
        ...(opts.maxCalls ? { maxTotalModelCalls: opts.maxCalls } : {}),
        maxRetries: opts.maxRetries,
        timeoutMs: opts.timeoutMs,
        ...(opts.maxCost != null ? { maxEstimatedCost: opts.maxCost } : {}),
        ...(pricing ? { pricing } : {}),
    };
}

function loadBaselineRuns(baselinePath) {
    if (!fs.existsSync(baselinePath)) return null;
    try {
        const baseline = JSON.parse(fs.readFileSync(baselinePath, 'utf8'));
        return baseline.runs || [];
    } catch (err) {
        console.warn(`[llm-benchmark] Failed to load baseline ${baselinePath}: ${err.message}`);
        return null;
    }
}

function printComparison(llmMetricsList, baselinePath) {
    const comparator = new ModelComparator();
    const baselineRuns = loadBaselineRuns(baselinePath);
    if (baselineRuns && baselineRuns.length) {
        console.log(`[llm-benchmark] Loaded ${baselineRuns.length} deterministic baseline run(s) from ${baselinePath}`);
        comparator.addRuns(baselineRuns);
    } else {
        console.warn(`[llm-benchmark] No baseline runs at ${baselinePath}; comparison shows LLM runs only.`);
    }
    comparator.addRuns(llmMetricsList.map(m => (m.summary ? m.summary() : m)));
    const result = comparator.compare();
    if (!result) {
        console.log('[llm-benchmark] No runs to compare.');
        return;
    }
    console.log('\n=== Deterministic Baseline vs LLM ===\n');
    console.log(comparator.generateLlmComparisonTable(result));
    console.log('');
    if (result.comparisons.length) {
        for (const comp of result.comparisons) {
            console.log(`- ${comp.vs}: ${comp.scoreDiff} points (${comp.pctDiff}%) ${comp.significant ? '(significant)' : '(minor)'}`);
        }
        console.log('');
    }
    console.log('Note: one run never proves an LLM is better. Re-run with more seeds before concluding anything.');
}

async function main() {
    const opts = parseArgs();

    if (opts.listScenarios) {
        console.log('Available scenarios:');
        for (const name of ALL_SCENARIOS) console.log(`- ${name}`);
        process.exit(0);
    }

    for (const name of opts.scenarios) {
        if (!ALL_SCENARIOS.includes(name)) {
            console.error(`Unknown scenario: ${name}. Available: ${ALL_SCENARIOS.join(', ')}`);
            process.exit(2);
        }
    }

    const modelConfig = resolveModelConfig(opts);
    const llmLimits = buildLlmLimits(opts);
    const label = `${modelConfig.provider || '?provider'}/${modelConfig.model || '?model'}`;

    console.log(`[llm-benchmark] Model: ${label} (benchmark v${BENCHMARK_VERSION})`);
    console.log(`[llm-benchmark] Scenarios: ${opts.scenarios.join(', ')} | seed ${opts.seed} | store ${opts.storeDir}`);
    console.log(`[llm-benchmark] Limits: per-scenario calls=${llmLimits.maxModelCalls}, suite calls=${llmLimits.maxTotalModelCalls || 'unlimited'}, retries=${llmLimits.maxRetries}, timeout=${llmLimits.timeoutMs}ms, maxCost=${llmLimits.maxEstimatedCost ?? 'none'}`);
    if (llmLimits.pricing) {
        console.log(`[llm-benchmark] Pricing: $${llmLimits.pricing.input_per_1k ?? '?'} / 1k input, $${llmLimits.pricing.output_per_1k ?? '?'} / 1k output`);
    } else {
        console.log('[llm-benchmark] No pricing configured: costs will be recorded as n/a (never estimated without rates).');
    }
    if (opts.useLlmInitialPlan) {
        console.log('[llm-benchmark] Full-LLM planning enabled: initial plans also come from the model (less directly comparable).');
    } else {
        console.log('[llm-benchmark] Scenario steps are kept; the LLM is used for replan decisions (directly comparable).');
    }
    console.log('[llm-benchmark] Keys are read from settings_llm_providers.json / environment. Start small (--scenarios <one>, --max-calls) to bound spend.');

    if (opts.dryRun) {
        console.log('[llm-benchmark] Dry run: exiting without API calls.');
        console.log(JSON.stringify({ modelConfig, scenarios: opts.scenarios, seed: opts.seed, llmLimits, useLlmInitialPlan: opts.useLlmInitialPlan }, null, 2));
        process.exit(0);
    }

    const runner = new BenchmarkSuiteRunner({
        scenarios: opts.scenarios,
        plannerModel: modelConfig,
        storeDir: opts.storeDir,
        seed: opts.seed,
        enableReplay: true,
        verbose: opts.verbose,
        llmLimits,
        llmPricing: llmLimits.pricing || null,
        useLlmInitialPlan: opts.useLlmInitialPlan,
    });

    const suiteResult = await runner.runAll();
    const metricsList = suiteResult.metricsList;

    console.log('\n=== LLM Benchmark Report ===\n');
    console.log(`Model: ${label} | scenarios ${metricsList.length}/${opts.scenarios.length} | suite LLM calls ${runner.suiteLlmCalls} | est. cost ${runner.suiteHasCostData ? `$${runner.suiteEstimatedCost.toFixed(4)}` : 'n/a'}`);
    if (runner.suiteAborted) console.log(`Suite aborted early: ${runner.suiteAborted}`);
    if (suiteResult.aggregate) {
        console.log(`Overall: avgScore ${suiteResult.aggregate.overallAvg} (weighted ${suiteResult.aggregate.overallWeighted}) | completion ${(suiteResult.aggregate.overallCompletion * 100).toFixed(1)}%`);
    }
    console.log(`Thresholds: ${suiteResult.thresholdResult.passed ? 'PASSED' : 'FAILED'} (${suiteResult.thresholdResult.violations.length} violations; thresholds are NOT relaxed for LLM runs)`);
    for (const v of suiteResult.thresholdResult.violations) {
        console.log(`  - [${v.type}] ${v.message}`);
    }
    console.log(`\nReport: ${suiteResult.reportPath}\nMarkdown: ${suiteResult.mdPath}\nSummary: ${suiteResult.summaryPath}`);

    if (opts.compare) {
        printComparison(metricsList, opts.baselinePath);
    } else {
        console.log('\nTip: re-run with --compare to print deterministic-baseline vs LLM side by side.');
    }

    const hardFailure = metricsList.length === 0 || runner.suiteAborted != null;
    process.exit(hardFailure ? 1 : 0);
}

main().catch(err => {
    console.error('[llm-benchmark] Fatal error:', err.message);
    if (String(err.message || '').includes('API key')) {
        console.error('[llm-benchmark] Configure keys in settings_llm_providers.json (copy from settings_llm_providers.example.json) or environment variables. No keys are ever passed as CLI flags.');
    }
    process.exit(3);
});
