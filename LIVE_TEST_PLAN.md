# Live integration testing plan

Status: the **FakeBot autonomy benchmark is done and is now regression coverage**
(`node scripts/benchmark_ci.js --seed 123`, 8 scenarios through the real
planner → executor → observer → world model → critic → recovery pipeline).
It proves planner and recovery logic. It proves nothing about Mineflayer,
pathfinding, block/entity observation, inventory transactions, latency, chunk
loading, server behaviour, authentication, or persistence across a real
disconnect — so the next milestone is those things, on a server we control.

```text
FakeBot benchmark  ✅  (keep as regression coverage, do not relax its thresholds)
        ↓
Local real-Minecraft server     ← stage 2, this document
        ↓
Live bot integration (direct)   ← stage 3, protocol layer only, zero API calls
        ↓
Explicit remote target (owned/private or permitted public server) ← stage 4
        ↓
Longer autonomous tasks         ← stage 5
        ↓
Multi-model evaluation          ← stage 6
        ↓
Skill learning                  ← stage 7
```

## What is in the repo now

| Path | Role |
|---|---|
| `src/agent/live/phases.js` | the controlled 8-phase sequence, per-phase verification spec, conservative timeouts |
| `src/agent/live/gates.js` | policy gates: who may be joined, which LLM key may be spent, report redaction |
| `src/agent/live/verify.js` | deterministic "the world actually changed" checks (same philosophy as `planning/observer.js`) |
| `src/agent/live/runner.js` | phase orchestration, timeouts, evidence, report writing |
| `src/agent/live/drivers/mineflayer_driver.js` | the real driver: production `initBot()`, `skills.js`, `world.js`, `observer.captureState()` |
| `src/agent/live/drivers/selftest_driver.js` | in-memory driver that tests **the harness**, never Minecraft |
| `scripts/live/run_controlled_test.js` | CLI (`--preflight`, `--print-plan`, `--driver`, features, gates) |
| `scripts/live/local_mc_server.sh` / `.ps1` | throwaway Paper server on your machine (loopback, whitelisted, offline auth) — bash and PowerShell twins with the same refusals |
| `tests/live_controlled_test.test.js` | gate/plan/verify/runner/CLI tests, dependency-free, runs in CI |

The live driver deliberately reuses the production helpers instead of
reimplementing them, so a green live run is evidence about the real agent, not
about a test-only code path.

## Running it

Bash (Linux/macOS/Git Bash):

```bash
# 0. no sockets, no API calls: shows gates, features, phase plan + timeouts
node scripts/live/run_controlled_test.js --preflight

# 1. prove the harness itself works (NO Minecraft involved, nothing to install)
npm run test:live:harness

# 2. start your own server in one terminal, then:
./scripts/live/local_mc_server.sh --dry-run --username <bot_name>
./scripts/live/local_mc_server.sh --accept-eula --username <bot_name>

# 3. protocol layer only — the first real run
npm run test:live:local -- --username <bot_name> --host 127.0.0.1 --port 55916 --auth offline

# 4. add interruption/recovery, then a real disconnect/reconnect
node scripts/live/run_controlled_test.js --driver mineflayer --host 127.0.0.1 --port 55916 \
  --username <bot_name> --auth offline --features direct,recovery
node scripts/live/run_controlled_test.js --driver mineflayer --host 127.0.0.1 --port 55916 \
  --username <bot_name> --auth offline --features direct,recovery,reconnect
```

PowerShell (Windows), same stages:

```powershell
./scripts/live/local_mc_server.ps1 -DryRun -Username <bot_name>
./scripts/live/local_mc_server.ps1 -AcceptEula -Username <bot_name>
node scripts/live/run_controlled_test.js --driver mineflayer --host 127.0.0.1 --port 55916 `
  --username <bot_name> --auth offline --features direct
```

Reports land in `results/live/<run_id>.json` + `.md` (gitignored, secrets
redacted before they touch disk). Exit codes: `0` every phase verified,
`1` a phase failed, `2` refused by a policy gate.

## The controlled sequence (no free roaming)

| # | phase | verifies | what FakeBot cannot |
|---|---|---|---|
| 1 | `connect` | handshake, auth, version match, spawn, keep-alive | the entire protocol stack + server-side login/whitelist |
| 2 | `observe` | chunk streaming, `blockAt`, nearby block palette, biome | real world data arriving from a real server |
| 3 | `report` | position/health/hunger/inventory/entities via `captureState` | inventory slot decoding and entity tracking |
| 4 | `gather` | pathfind → target → dig → pickup, verified by inventory delta | pathfinding on real terrain, reach/facing, dig speed, drop pickup |
| 5 | `craft` | recipe resolves for the live version and the item exists afterwards | recipe tables/grid sizes per server version, transaction atomicity |
| 6 | `build` | placed blocks re-read from the world at absolute coordinates | placement face/adjacency rules, server-side block updates, collisions |
| 7 | `recovery` | a mid-flight interrupt is *really* injected, then retried/resumed to the goal | true in-flight cancellation and a critic that refuses to bless a half-done step |
| 8 | `persist` | final world state; with `reconnect`: state after a genuine socket drop | server-authoritative state vs client cache, persistence across reconnect |

Rules baked into the harness, so the results are not cosmetic:

- a phase passes only if the **world** changed (`verify.js`), not if the call returned;
- a phase whose "success" cannot be observed is recorded as freeform, never auto-passed;
- a failing mutating phase halts later mutating phases; a failed `connect` halts the run;
- `recovery` fails if nothing was actually interrupted (a vacuous pass is a failure);
- `persist` requires the gathered resource to be **held or built** — a gap means the
  server voided or duplicated it;
- every phase has its own conservative timeout plus an optional global `--deadline`;
  start at `--timeout-scale 1`, only shrink after a green run.

## Stage 4: an explicitly selected remote target

A remote target is allowed when the user explicitly selects it with `--host` (or
explicitly opts into `--from-settings`). The harness does not require a staff
authorization JSON file, `--tos-ack`, or an `--allow-remote` flag. This is not an
anti-cheat or server-rules bypass: only connect to a server you own or to a
server whose rules permit automated clients, keep the bot visibly automated, and
do not conceal its identity or evade anti-cheat/security controls.

Remote targets must use a valid Minecraft account and `--auth microsoft`;
`--auth offline` is rejected for public/remote hosts. `--local-only` rejects
public hosts while still allowing loopback and private/LAN targets. Private
addresses receive an ownership warning. An implicit/default loopback target is
never promoted to a remote target by accident.

The first remote run should be read-only protocol observation so that a server
startup or authentication problem cannot create a misleading mutation report:

```bash
node scripts/live/run_controlled_test.js --preflight \
  --host testing-environement.aternos.me --port 28552 \
  --username nickgurrcrafter5 --auth microsoft --features direct \
  --only connect,observe,report

node scripts/live/run_controlled_test.js --driver mineflayer \
  --host testing-environement.aternos.me --port 28552 \
  --username nickgurrcrafter5 --auth microsoft --features direct \
  --only connect,observe,report
```

The resolved host, port, account, auth mode, Minecraft version, selected
features, and selected phases are printed before Mineflayer is constructed. No
credential is printed. If the target is offline, still starting, or rejects
Microsoft authentication, the run fails with that actual connection result; do
not report it as a pass.

PowerShell uses the same Node CLI and does not need Bash:

```powershell
node scripts/live/run_controlled_test.js --driver mineflayer `
  --host testing-environement.aternos.me --port 28552 `
  --username nickgurrcrafter5 --auth microsoft --features direct `
  --only connect,observe,report
```

For a first test against a server you do not administer, check its rules before
connecting. Never spoof a normal client, hide the bot's identity, route around
rate limits or anti-cheat, use alt accounts to dodge a ban, or join during a
populated time window because it is quick.

`--print-plan` displays the same target/gate/credential/plan information and
then exits before driver construction, phase execution, or any network socket.
`--only connect,observe,report` executes exactly those three phases; the report
labels all other runnable phases as intentionally excluded, not failed.

## Credentials: the exposed OpenRouter key must not touch the live bot

**Do not use the exposed key for any live run.** Rotate it first — revocation is
the only real fix; a key that has been in chat, a log, or a commit is public:

1. Revoke/delete the exposed key at the provider, create a replacement.
2. Put the replacement **only** in `settings_llm_providers.json` (gitignored) or
   your shell environment. Never in `settings_llm_providers.example.json`,
   `settings.js`, a profile, a report, or a command-line flag.
3. Tell the harness what is burned, so it can refuse it forever:
   ```bash
   export LIVE_TEST_LEAKED_KEY_HASHES=$(printf '%s' '<the-exposed-old-key>' | sha256sum | cut -d' ' -f1)
   # PowerShell:
   # $env:LIVE_TEST_LEAKED_KEY_HASHES = [BitConverter]::ToString(
   #   [Security.Cryptography.SHA256]::Create().ComputeHash(
   #     [Text.Encoding]::UTF8.GetBytes('<the-exposed-old-key>'))).Replace('-','').ToLower()
   node scripts/live/run_controlled_test.js --preflight --features direct,pipeline --provider openrouter
   ```
   Preflight prints only digests and length (`sha8` + 4-char prefix), never a key.
4. Also check for **local** exposure before declaring victory — the repo and its
   history are the easy part:
   ```bash
   git -C . log --all -p | grep -c 'sk-or-'          # expect 0
   git grep -In 'sk-or-' $(git rev-parse HEAD)        # expect no hits
   grep -rl 'sk-or-' results src/models/logs ~/.bash_history 2>/dev/null
   ```
   Never paste the real key into a chat window, a ticket, or a commit message while
doing this — hash it locally, share only the digest if you need a second opinion.

In this repo right now: `git rev-list --all` objects contain **no** `sk-or-*`
   string, `settings_llm_providers.json` is gitignored and absent, and the only
   match anywhere is the empty placeholder in
   `settings_llm_providers.example.json`. So the exposure is in the environment /
   chat / any machine that saw it, not in version control — which is exactly why
   rotation is required and committing "fix the leak" would not be enough.

Two properties make this testable rather than aspirational:

- `--features direct` (stages 2–4) **loads no LLM key at all**, so the first live
  runs cannot spend the wrong key even by accident. The credential gate then only
  has to prove no key-looking string appears in the run's evidence.
- enabling `pipeline` requires `--rotation-ack`, and a key matching a
  `LIVE_TEST_LEAKED_KEY_HASHES` digest is refused even with that ack.

## Stage 5+ (only after stages 2–4 are green on the local server)

- **5, longer autonomous tasks**: same driver, `--features direct,pipeline`, one
  `!plan` goal with a bounded step budget (`settings.planning.max_executions`),
  `--deadline` set to the budget, and success judged by `verify.js`-style world
  checks, not by the bot's own narration. Run at least 3 seeds/tasks before
  reading anything into a number.
- **6, multi-model evaluation**: reuse `scripts/benchmark_llm.js` for the
  planner-side comparison (its `--max-calls` / `--max-cost` caps stay on) and the
  live CLI for the executor side, one model per run, identical plan/task config,
  and thresholds unchanged across models.
- **7, skill learning**: only once a live run can be repeated green. Learned
  skills must be validated by the same verification rules (recorded outcome =
  observed world change), stored per bot under `bots/<name>/learnedSkills/`, and
  a skill that cannot be re-verified on a fresh world must not be reusable.

## Standing rules

- The FakeBot benchmark stays the regression gate: `npm test` must stay green,
  and a live failure never justifies editing `benchmark_results/baseline_*.json`
  or `src/agent/benchmark/thresholds.js`.
- **Known gap in that gate right now:** `benchmark_results/baseline_baseline.json`
  is not in the tree (it was deleted), so `node scripts/benchmark_ci.js --seed 123`
  enforces absolute thresholds but the *regression-from-baseline* check is vacuous.
  It now says `SKIPPED (no baseline)` instead of a misleading `PASS`. Restore it
  deliberately with `node scripts/benchmark_ci.js --seed 123 --write-baseline`
  (review the diff before committing) and add `--require-baseline` to CI so a
  missing baseline can never read as a pass again.
- `--driver selftest` (and `selftest_driver.js`) is a harness test, not a live
  test; its green report says nothing about Minecraft and must never be quoted
  as a live result.
- `results/live/` and `.live/` are gitignored. No world saves, API keys,
  authentication caches, or other local credentials belong in git.
- In-game chat logging, `only_chat_with`, and `chat_ingame` are production
  behaviour: for a public run, decide explicitly whether the bot should talk to
  players at all before you join (default for remote runs: leave them alone).
