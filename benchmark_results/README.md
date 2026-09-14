# Benchmark results

This directory stores outputs of the autonomy benchmark suite
(`src/agent/benchmark/`):

- `run_*.json` — per-run metrics (score, recovery quality, steps, events).
- `replay_*.json` — replay logs (seed, initial world, injections, world states,
  planner outputs, final metrics).
- `summary_*.json` / `report_*` — suite aggregates and markdown reports.
- `baseline_*.json` — committed regression baselines (currently
  `baseline_baseline.json`, the deterministic baseline).

Do not hand-edit baselines. Regenerate them deliberately and review the diff.

## Deterministic benchmark (no API calls, CI-enforced)

Runs 8 scripted scenarios through the real
Planner → Executor → Observer → WorldModel → Critic → Recovery/Replan pipeline
with a deterministic stub planner:

```bash
node scripts/benchmark_ci.js --seed 123
```

`--test-failure` self-tests that the CI script actually fails on regression.
All scenarios, seeds, injections, scores, thresholds, and replay checks are
deterministic.

## Real-LLM benchmark evaluation (uses API calls)

The exact same scenarios can be executed with a real LLM planner for direct
comparison against the deterministic baseline. Only the planner's
model-decision function is swapped; executor, observer, world model, critic,
and recovery/verification are identical.

### 1. Configure a real model

Model selection reuses the normal profile convention. Copy the example registry
and fill in keys (or export them as environment variables):

```bash
cp settings_llm_providers.example.json settings_llm_providers.json
# edit settings_llm_providers.json -> keys.{YOUR_PROVIDER_API_KEY}
```

Then pick the model exactly like a profile does:

```bash
node scripts/benchmark_llm.js --provider openai --model gpt-5.4-mini --scenarios wheat_farm_benchmark
node scripts/benchmark_llm.js --model openai/gpt-5.4-mini --scenarios wheat_farm_benchmark
node scripts/benchmark_llm.js --profile profiles/gpt.json --scenarios wheat_farm_benchmark
```

Keys are read from `settings_llm_providers.json` / the environment via the
existing provider mechanism. The script never accepts keys as flags, and no
credentials are ever written to `benchmark_results/`.

### 2. Compare deterministic baseline vs LLM

```bash
node scripts/benchmark_llm.js --provider openai --model gpt-5.4-mini --compare
```

This runs the LLM suite, loads the deterministic baseline, and prints a
comparison table (Model, Average Score, Completion Rate, Recovery Quality,
Replans, Retries, LLM Calls, Tokens, Estimated Cost, Average Latency).
Thresholds are NOT relaxed for LLM runs. One run never proves an LLM is
better — re-run with more seeds before concluding anything.

### 3. How costs and tokens are recorded

After each planner call the adapter reads the provider's reported usage
(`lastTokenUsage`: input/output/total tokens). Cost is computed ONLY when you
also supply explicit rates:

```bash
node scripts/benchmark_llm.js --provider openai --model gpt-5.4-mini \
  --price-in 0.001 --price-out 0.004 --compare
```

Without provider usage or without `--price-in/--price-out`, tokens/cost are
stored as `n/a` (null) — never estimated or fabricated. Every LLM run persists
provider, model, config id (`provider/model`), run mode (`llm`), benchmark
version, seed, timestamp, metrics, score, recovery quality, and replay id, so
LLM runs are always distinguishable from deterministic runs and never
overwrite `baseline_*.json`.

### 4. Avoiding accidentally expensive runs

- Start with one scenario: `--scenarios wheat_farm_benchmark`.
- Preview first: `--dry-run` prints the resolved config and limits with no API
  calls.
- Caps are enforced: `--max-scenarios`, `--max-calls` (suite-wide, default
  200), `--max-model-calls` (per scenario, default 50), `--max-retries`
  (default 2), `--timeout` (ms, default 60000), `--max-cost` (USD, needs
  usage + pricing). Call/retry limits apply even when cost data is
  unavailable, so a runaway benchmark cannot make unlimited API calls.
- By default the LLM is used only for replan decisions while scenario steps
  are kept, which bounds calls and keeps runs directly comparable. Full LLM
  initial planning (`--use-llm-initial-plan`) is opt-in.

### 5. Deterministic vs stochastic replay

- Deterministic replays (`runMode: deterministic`) record seed, scenario,
  initial world, injections, and states, and can be reproduced exactly.
- LLM replays (`runMode: llm`) additionally record provider/model/config,
  benchmark version, and planner outputs — but stochastic model output is
  never claimed to be reproducible. `ReplayPlayer` reports the distinction
  (`isDeterministicRun()`, `compareWithNewRun().stochastic`) and generates a
  re-evaluation script instead of a reproduction script for LLM runs.

### 6. Tests

```bash
node --test tests/benchmark.test.js tests/benchmark_llm.test.js
```

LLM tests use mocked providers only and never touch the network or require an
API key. The deterministic suite must keep passing unchanged.
