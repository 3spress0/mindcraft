<h1 align="center">🧠 mindcraft ⛏️</h1>

<p align="center">
  An actively developed Mindcraft fork focused on reliable Minecraft autonomy, planning, recovery, world modeling, and real-LLM evaluation.
</p>

<p align="center">
  <a href="https://github.com/3spress0/mindcraft">GitHub</a> •
  <a href="https://github.com/3spress0/mindcraft/issues">Issues</a> •
  <a href="https://github.com/mindcraft-bots/mindcraft">Upstream Mindcraft</a>
</p>

> [!NOTE]
> This repository is a fork of the original [Mindcraft](https://github.com/mindcraft-bots/mindcraft) project.
>
> It contains substantial additional development by `3spress0`, including hierarchical planning, execution verification, persistent world modeling, contextual recovery, schematic construction, humanlike locomotion, deterministic benchmarks, and real-LLM evaluation.
>
> Upstream documentation and research should be attributed to the original Mindcraft project where applicable.

> [!CAUTION]
> Mindcraft gives an LLM the ability to interact with Minecraft and, when coding is enabled, potentially write and execute code on the host system.
>
> Do not connect coding-enabled agents to untrusted public servers. Prompt injection and malicious game content can cause unintended behavior.
>
> Coding is disabled by default. Only enable `allow_insecure_coding` when you understand the risks.

# Getting Started

## Requirements

* Minecraft Java Edition compatible with the version supported by the installed Mindcraft/Mineflayer stack.
* **Node.js 24 (Active LTS)**. Node.js 24 is the supported runtime and development target for this project. It is pinned consistently across local development (`.nvmrc`/`.node-version`), Codespaces (`.devcontainer/`), CI (`.github/workflows/ci.yml`), and Docker (`node:24-*` images), and `npm install` enforces it via `engines` + `engine-strict` (`.npmrc`). With `nvm`, run `nvm install && nvm use` in the repo root.
* At least one supported LLM provider/API key unless using a local model.
* A Minecraft account for online-mode servers.

The bot screenshot/vision feature uses native modules (`gl`, `canvas`, via `node-canvas-webgl`). These are **optional dependencies**: if they cannot be built for your platform they are skipped and the rest of the project still installs and runs normally — only screenshot-based vision is unavailable. They build automatically in the Docker image and the Codespaces devcontainer; to build them locally, see "Native dependencies" below.

## Installation

> Using GitHub Codespaces or VS Code Dev Containers instead? This repository ships `.devcontainer/`, so a fresh container lands on Node.js 24 with all native prerequisites and runs `npm install` for you. You can skip the steps below (except provider configuration).

1. Clone this repository or download a release.

2. Create your local provider configuration:

```text
settings_llm_providers.example.json
        ↓
settings_llm_providers.json
```

3. Configure at least one model provider. Never commit API keys.

4. Make sure you are on Node.js 24, then install dependencies:

```bash
nvm install && nvm use   # reads .nvmrc, skip if Node.js 24 is already active
npm install              # fails early with EBADENGINE on the wrong Node version
```

5. Start a Minecraft world and expose it to LAN, or configure an external Minecraft server in `settings.js`.

6. Start Mindcraft:

```bash
node main.js
```

For development and automated testing, see the benchmark and testing sections below.

### Native dependencies (only for the bot screenshot/vision feature)

The headless renderer (`gl` via `node-canvas-webgl`) compiles native code. On Node.js 24 it is always built from source (no prebuilt binary exists for Node 24 yet), which requires:

* **Debian/Ubuntu:** `sudo apt-get install -y build-essential python3 libgl1-mesa-dev libgles2-mesa-dev libosmesa6-dev libcairo2-dev libpango1.0-dev libjpeg-dev libgif-dev librsvg2-dev libxi-dev libxinerama-dev libxrandr-dev`
* **macOS:** Xcode command line tools (`xcode-select --install`)
* **Windows:** Visual Studio Build Tools ("Desktop development with C++")

If the build fails or the prerequisites are missing, `npm install` continues and **skips** these optional packages; if the agent is then asked for a screenshot it responds that vision capture is unavailable. Use the Docker image or Codespaces devcontainer to get the feature without touching your host.

```bash
docker compose up --build
```

# Configuration

Main configuration is stored in:

```text
settings.js
```

Bot profiles are stored in:

```text
profiles/
```

A profile can select the bot's model, prompts, coding model, vision model, embedding model, and other behavior.

Example:

```json
{
  "name": "andy",
  "model": "openai/gpt-5.4-mini"
}
```

Provider-specific configuration is stored separately in:

```text
settings_llm_providers.json
```

Keep this file local. It may contain credentials.

## Supported Providers

The provider registry currently supports, depending on the installed configuration and model implementation:

| Provider       | Environment variable  |
| -------------- | --------------------- |
| `openai`       | `OPENAI_API_KEY`      |
| `anthropic`    | `ANTHROPIC_API_KEY`   |
| `google`       | `GEMINI_API_KEY`      |
| `xai`          | `XAI_API_KEY`         |
| `deepseek`     | `DEEPSEEK_API_KEY`    |
| `openrouter`   | `OPENROUTER_API_KEY`  |
| `qwen_cn`      | `QWEN_API_KEY`        |
| `mistral`      | `MISTRAL_API_KEY`     |
| `replicate`    | `REPLICATE_API_KEY`   |
| `groq`         | `GROQCLOUD_API_KEY`   |
| `huggingface`  | `HUGGINGFACE_API_KEY` |
| `novita`       | `NOVITA_API_KEY`      |
| `hyperbolic`   | `HYPERBOLIC_API_KEY`  |
| `cerebras`     | `CEREBRAS_API_KEY`    |
| `mercury`      | `MERCURY_API_KEY`     |
| `ollama`       | `OLLAMA_API_KEY`      |
| `ollama_local` | none                  |
| `vllm`         | none                  |
| `lmstudio`     | none                  |

Exact provider availability is determined by `settings_llm_providers.json` and the installed model adapters.

For OpenRouter, models can use the normal provider/model convention:

```json
{
  "model": "openrouter/openai/gpt-4o-mini"
}
```

or explicit provider configuration:

```json
{
  "model": {
    "provider": "openrouter",
    "model": "openai/gpt-4o-mini"
  }
}
```

# Online Servers

Mindcraft can connect to Minecraft servers using a Microsoft-authenticated Minecraft account.

Configure `settings.js` with the target server:

```javascript
"host": "example.com",
"port": 25565,
"auth": "microsoft"
```

The Minecraft profile name configured for the bot must match the account/profile being used.

Before connecting an autonomous bot to a public server, verify that automated clients, bots, and AI agents are permitted by that server's rules.

Do not use the bot to bypass anti-cheat, anti-bot, authentication, or other server security mechanisms.

The live integration harness enforces the same rule mechanically: a non-local server is refused unless staff permission is recorded in an authorization file naming the account, host, port, and who approved automation. There is no flag that skips that gate.

```bash
node scripts/live/run_controlled_test.js --preflight --host <server> --port <port> \
  --username <bot-account> --auth microsoft
```

See [LIVE_TEST_PLAN.md](LIVE_TEST_PLAN.md) for the permission record format and the staged test ramp.

# Tasks

The original Mindcraft task system is still supported.

Example:

```bash
node main.js --task_path tasks/basic/single_agent.json --task_id gather_oak_logs
```

A task can define:

* Goal text
* Target item
* Required quantity
* Initial inventory
* Agent count
* Timeout
* Blocked actions
* Crafting requirements

# Autonomous Project Planning

This fork adds a structured long-horizon planning system for goals such as:

```text
Build an automated iron farm.
```

Instead of continuously self-prompting, the agent can execute a verified project loop:

```text
Planner
   ↓
Executor
   ↓
Observer
   ↓
WorldModel
   ↓
Critic
   ↓
Recovery / Replan
   ↺
```

The planner creates dependency-aware steps organized into phases.

Typical phases might be:

```text
Preparation
    ↓
Resource Gathering
    ↓
Construction
    ↓
Verification
```

Only executable leaf steps are run. Parent/group tasks roll their status up from their children.

Project state is persisted so interrupted projects can resume.

## Planning Commands

Create and execute a project:

```text
!plan <goal>
```

Inspect the project:

```text
!planStatus
```

Pause:

```text
!planStop
```

Resume:

```text
!planResume
```

Discard the remaining plan and replan:

```text
!planReplan
```

The simpler continuous goal loop remains available:

```text
!goal <prompt>
```

# Context-Aware Recovery

Failures are no longer handled as generic retries.

The recovery system combines:

* Failure type
* Planner/recovery profile
* WorldModel facts
* Known resource locations
* Depleted deposits
* Known threats
* Last-seen entities
* Known shelters
* Health state
* Attempt/replan budgets

Possible recovery actions include:

```text
retry
repath
navigate
search
gather
retreat
replan
human
abort
```

Example:

```text
Recovery [default:navigate]
Obtain 32 iron:
target_depleted
nearest known deposit is depleted;
usable deposit found 180m away at (180, 64, -20)
```

Recovery profiles include:

```text
default
explorer
builder
survival
```

Profiles can be customized through the `planning` configuration in `settings.js`.

# Persistent World Model

The fork maintains a persistent world model at:

```text
bots/<name>/world_model.json
```

The model stores verified and observed facts such as:

* Locations
* Villages
* Bases
* Resource deposits
* Structures
* Mobs and NPCs
* Threats
* Death locations
* Proven crafting recipes
* Player state
* Active project state

Facts have confidence, timestamps, sources, and optional expiration.

Volatile information such as threats can expire, while durable knowledge can survive restarts.

Inspect it in-game:

```text
!world
```

Find the nearest known fact:

```text
!where village
!where iron
!where zombie
```

List a category:

```text
!where resources
```

## Verified State Transitions

Planner steps can declare machine-checkable state changes.

Example:

```json
{
  "expected_delta": {
    "inventory.hopper": 1,
    "inventory.iron_ingot": -5
  }
}
```

The critic can verify the actual world transition rather than trusting the LLM's statement that a step succeeded.

This prevents cases where the model says:

```text
Crafting completed.
```

even though the inventory did not actually change.

# Schematic Construction

This fork adds schematic-based construction using existing building infrastructure.

Supported schematic formats include:

* Litematica `.litematic`
* Sponge / WorldEdit `.schem`
* Vanilla structure `.nbt`

Useful commands:

```text
!listBuilds
```

```text
!buildMaterials <name>
```

```text
!buildSchematic <name> [x y z rotation]
```

Build state is persisted so interrupted construction can resume.

The build system integrates with the same project planning and verification pipeline rather than bypassing it.

Some complex block orientations and tile-entity contents may require additional handling.

# Humanlike Locomotion

The fork includes a humanization layer for movement and camera behavior.

It provides controlled variation in:

* Gaze movement
* Head turns
* Walking vs sprinting
* Micro-movement
* Jump timing
* Reaction delays
* Idle behavior
* Per-bot movement personality

The system deliberately bypasses humanization where precise control is required, such as:

* Digging
* Block placement
* PvP aiming
* Riding
* Swimming
* Explicit skill-driven camera control

Humanization is intended to make movement behavior less rigid; it is not intended as a mechanism for bypassing server security systems.

# Coding and Sandboxing

Mindcraft's coding system allows the agent to generate JavaScript actions.

This fork includes sandboxing and execution controls around generated code, including:

* Absolute-path validation
* Linting
* Cached code
* Restricted execution
* Execution timeouts
* Tool interruption on timeout
* Error analysis

Coding remains disabled by default.

For additional isolation, a Docker deployment can be used.

> [!WARNING]
> Sandboxing reduces risk but does not make execution of untrusted LLM-generated code completely safe.

# Benchmarking

This fork contains a deterministic autonomy benchmark and a real-LLM benchmark.

Benchmark code is located in:

```text
src/agent/benchmark/
```

Results are written locally to:

```text
benchmark_results/
```

The benchmark currently covers eight scenarios:

```text
wheat_farm_benchmark
iron_mine_benchmark
shelter_build_benchmark
tree_farm_benchmark
village_outpost_benchmark
nether_expedition_benchmark
adversarial_depleted_alternatives_benchmark
adversarial_trap_target_benchmark
```

The benchmark intentionally evaluates the complete autonomy pipeline:

```text
Scenario
   ↓
Planner
   ↓
Executor
   ↓
Observer
   ↓
WorldModel
   ↓
Critic
   ↓
Recovery / Replan
   ↓
Metrics
```

## Deterministic Benchmark

Run the CI benchmark:

```bash
node scripts/benchmark_ci.js --seed 123
```

The deterministic suite is used as the regression baseline.

Regression checks need a saved baseline. If `benchmark_results/baseline_baseline.json` is absent, the CI script enforces the absolute thresholds and reports `Baseline regression: SKIPPED` rather than passing vacuously; `--require-baseline` makes the missing baseline a CI failure, and `--write-baseline` regenerates it deliberately:

```bash
node scripts/benchmark_ci.js --seed 123 --write-baseline
node scripts/benchmark_ci.js --seed 123 --require-baseline
```

## Real-LLM Benchmark

Run one scenario with a real provider:

```bash
node scripts/benchmark_llm.js \
  --provider openrouter \
  --model openai/gpt-4o-mini \
  --scenarios wheat_farm_benchmark \
  --seed 123 \
  --compare
```

PowerShell:

```powershell
node scripts/benchmark_llm.js `
  --provider openrouter `
  --model openai/gpt-4o-mini `
  --scenarios wheat_farm_benchmark `
  --seed 123 `
  --compare
```

Pricing can be supplied for cost estimation:

```text
--price-in <USD per 1k input tokens>
--price-out <USD per 1k output tokens>
```

Safety controls include:

```text
--max-calls
--max-model-calls
--max-retries
--timeout
--max-cost
--dry-run
```

The benchmark keeps the existing scenario steps by default and uses the real LLM for planner/replan decisions. This keeps model comparisons directly comparable to the deterministic baseline.

Full-LLM initial planning can be enabled with:

```text
--use-llm-initial-plan
```

## Live Integration Testing

The benchmark runs against `FakeBot`, so it validates planner, critic, and recovery logic. It cannot validate Mineflayer interaction, pathfinding, block and entity observation, inventory transactions, latency, chunk loading, authentication, or persistence across a real disconnect. Those are covered by a controlled sequence against a real server:

```text
connect and authenticate
   |
observe nearby world
   |
report position, health, inventory, entities
   |
gather a resource
   |
craft an item
   |
build a small structure
   |
recover from an injected interruption
   |
verify resulting world state (optionally across a reconnect)
```

Run it in stages:

```bash
node scripts/live/run_controlled_test.js --preflight
node scripts/live/run_controlled_test.js --driver selftest
node scripts/live/run_controlled_test.js --driver mineflayer --host 127.0.0.1 --port 55916 --auth offline --username <bot-account> --features direct
```

Each phase passes only when the world state actually changed; a phase that cannot be observed is not auto-passed, and a failing mutating phase stops later mutating phases instead of compounding damage. `--features direct` uses no LLM key at all, so the first live runs cost no API calls.

PowerShell, on Windows:

```powershell
./scripts/live/local_mc_server.ps1 -AcceptEula -Username "<bot-account>"
node scripts/live/run_controlled_test.js --driver mineflayer --host 127.0.0.1 --port 55916 --auth offline --username "<bot-account>" --features direct,recovery
```

Reports are written to `results/live/` with credentials redacted, and the FakeBot thresholds are never relaxed to accommodate a live failure. `--driver selftest` exercises the harness only; it is not a live test result.

## Benchmark Design

The evaluation framework records metrics including:

* Completion
* Total steps
* Successful/failed steps
* Retries
* Replans
* Recovery actions
* Recovery reasons
* Interruptions/resumes
* Deaths
* Resource waste
* Model calls
* Model failures
* Token usage
* Estimated cost
* Latency
* Recovery quality
* Replay information

The benchmark also supports:

* Deterministic replay
* Model comparison
* Baseline regression checks
* Scenario-specific thresholds
* Recovery-quality evaluation
* CI enforcement

A single LLM run is not treated as proof that one model is better than another. Repeated runs across seeds are required for meaningful statistical comparisons.

# Development

Run the test suite:

```bash
npm test
```

Benchmark tests:

```bash
node --test tests/benchmark.test.js
```

Real-LLM benchmark tests:

```bash
node --test tests/benchmark_llm.test.js
```

Both benchmark test suites:

```bash
node --test tests/benchmark.test.js tests/benchmark_llm.test.js
```

Live harness tests (no Minecraft, no network required):

```bash
npm run test:live
```

Lint the project using the repository's configured ESLint setup.

# Security

Never commit:

```text
settings_llm_providers.json
```

or any file containing API keys, authentication tokens, or Minecraft account credentials.

Use environment variables where practical:

```powershell
$env:OPENROUTER_API_KEY = "your-key"
```

Do not put API keys directly into source code.

When a key is exposed publicly, revoke it and issue a replacement.

The live harness can refuse a burned key permanently: set `LIVE_TEST_LEAKED_KEY_HASHES` to the SHA-256 digest of the exposed value, and any run resolves to a key with that digest fails before connecting.

```powershell
$env:LIVE_TEST_LEAKED_KEY_HASHES = (Get-FileHash -Algorithm SHA256 -InputStream ([IO.MemoryStream]::new([Text.Encoding]::UTF8.GetBytes("sk-or-EXPOSED-KEY"))) | Select-Object -ExpandProperty Hash)
```

Only digests and truncated fingerprints are recorded in reports; key material is redacted from every artifact written to disk.

# Project Direction

This fork focuses on moving Mindcraft toward a more reliable autonomous-agent architecture.

Current architecture:

```text
Planner
   ↓
Executor
   ↓
Observer
   ↓
WorldModel
   ↓
Critic
   ↓
Recovery / Replan
```

Current development priorities are centered around:

```text
1. Reliable live Minecraft integration
2. Stronger real-LLM evaluation
3. Repeated multi-model benchmarking
4. Model selection/routing
5. Reusable skill acquisition
6. Longer-horizon autonomous behavior
```

The deterministic benchmark remains the regression anchor while real-world Minecraft testing is used to identify failures that cannot be reproduced by simulation alone.

# Upstream

This repository originated from the open-source Mindcraft project:

https://github.com/mindcraft-bots/mindcraft

The original project provides the underlying Minecraft/LLM agent framework, Mineflayer integration, profiles, task system, and research foundation.

Changes in this fork should not be assumed to exist upstream.

# Research Citation

The original Mindcraft research is:

**Collaborating Action by Action: A Multi-agent LLM Framework for Embodied Reasoning**

```bibtex
@article{mindcraft2025,
  title = {Collaborating Action by Action: A Multi-agent LLM Framework for Embodied Reasoning},
  author = {White, Isadora and Nottingham, Kolby and Maniar, Ayush and Robinson, Max and Lillemark, Hansen and Maheshwari, Mehul and Qin, Lianhui and Ammanabrolu, Prithviraj},
  journal = {arXiv preprint arXiv:2504.17950},
  year = {2025},
  url = {https://arxiv.org/abs/2504.17950}
}
```

Please cite the original paper when using the underlying Mindcraft research in academic work.

# License

See the repository's license files for the applicable licensing terms and the obligations inherited from the upstream project.

# Status

This is an actively developed fork.

The benchmark, planning, world-model, recovery, construction, and humanization systems are under ongoing development, and some features may still have implementation-specific limitations.

For bugs or improvements specific to this fork, use the GitHub issue tracker:

https://github.com/3spress0/mindcraft/issues
