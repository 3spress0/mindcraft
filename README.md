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

The live integration harness permits a remote target when the user explicitly selects it with `--host` (or explicitly uses `--from-settings`). It does not require a staff authorization JSON record, `--tos-ack`, or an `--allow-remote` flag. Remote targets still require a valid Minecraft username and `--auth microsoft`; `--auth offline` is rejected remotely. `--local-only` continues to refuse public hosts, and private/LAN targets receive an ownership warning.

Do not connect to a server unless its rules permit automated clients. Do not bypass anti-cheat, anti-bot, authentication, or other server security mechanisms, and do not conceal that the client is a bot. Direct protocol-only runs must not load an LLM key.

```bash
node scripts/live/run_controlled_test.js --preflight --host <server> --port <port> \
  --username <bot-account> --auth microsoft --features direct
```

See [LIVE_TEST_PLAN.md](LIVE_TEST_PLAN.md) for the staged ramp, PowerShell workflow, verification rules, and secret-safety requirements.

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

```text
!saveArea <name> <x1> <y1> <z1> <x2> <y2> <z2>
```

Build state is persisted so interrupted construction can resume.

The build system integrates with the same project planning and verification pipeline rather than bypassing it.

Some complex block orientations and tile-entity contents may require additional handling.

## Litematica capture and export

Schematics are no longer read-only. `!saveArea` captures any box of the live
world — block-state properties included — and serializes it to a real,
gzip-compressed `.litematic` file with a proper block-state palette and packed
bit arrays (entries may straddle 64-bit long boundaries exactly like the
Litematica mod expects). `!saveAreaSchem` writes the same capture as a
Sponge/WorldEdit `.schem` (spec v2: block-state string palette + LEB128 varint
block data), the format WorldEdit saves and Baritone builds natively. Captured
builds land in the build library, so the bot can round-trip them: capture a
structure, quote its materials, and rebuild it elsewhere — or hand the file to
a human using the Litematica mod or WorldEdit.

# Baritone-style Movement

Inspired by [Baritone](https://github.com/cabaletta/baritone), this fork adds a
goal-oriented movement layer on top of mineflayer-pathfinder (rather than
depending on Baritone itself, which would need a separate Java process).

* **Goal types** — `GoalBlock`, `GoalNear`, `GoalXZ`, `GoalNearXZ`, `GoalY`,
  `GoalGetToBlock` (stand next to / on top of a block, used for mining reach),
  `GoalFollow` (tracks a moving entity), `GoalRunAway`, and `GoalAny` /
  `GoalAll` / `GoalInvert` composites. Every goal implements the
  `heuristic` / `isEnd` interface mineflayer-pathfinder expects.
* **Movement profiles** — named presets that tune the pathfinder the way
  Baritone's `#set` options do: `default`, `legit` (no sprinting/parkour/digging,
  human-like), `fast` (sprint + parkour + digging), `builder` (never dig,
  cheap placement), and `safe` (legit + hazard avoidance). Profiles are stored
  per-bot and apply to all navigation.
* **Path preview** — dry-run a path without moving and report whether it exists
  and how long it is, like Baritone's `#calc`.
* **Mining** — `#mine`-style behavior: locate the nearest matching block, path
  to an adjacent spot, equip the best tool, and dig. It is **vein-aware**: after
  each dig, face-connected blocks of the same type (ore veins, gravel pockets)
  are swept out before the next nearest-search, mirroring Baritone's vein
  mining. Disable per call with `{ vein: false }`.

```text
!setPathProfile legit
!listPathProfiles
!previewPath x y z
!baritoneStatus
!mineBlocks iron_ore 8
```

# Navigation Intelligence

`src/agent/navigation/` adds three Baritone-inspired capabilities that make
travel cheaper, safer, and more self-directed.

## Hazard-aware navigation

`hazards.js` classifies danger blocks into **hard** hazards (lava, fire, magma
blocks, campfires, berry bushes, cacti, wither roses, powder snow) and
**soft** hazards (soul sand, cobwebs, honey blocks). The `safe` movement
profile hardens the pathfinder's `blocksToAvoid` set with all of these, so
routes steer around them instead of through them.

```text
!hazards          # scan the local area and list dangers with distance
!hazards 20       # with a custom radius (capped at 24)
!setPathProfile safe
```

## Route caching

Successful trips are remembered (downsampled waypoint corridors, per
start/goal/profile) in `bots/<name>/route_cache.json`. When the bot is asked
to make the same trip again, the cached route is **re-verified against the
live world first** — sampled waypoints are checked for new lava, removed
ground, etc. — and only replayed if still valid; otherwise the entry is
dropped and normal pathfinding runs. Replay never blocks: any hiccup falls
back to the regular two-probe navigation. TTL (default 15 min), entry cap
(default 64) and the master switch live under `settings.navigation.route_cache`.

The cache also keeps a **failure ledger**: when a trip fails (pathfinder gives
up, or a replayed route no longer verifies), the route is remembered as
*known failed* and skipped on future replays until the TTL passes. One
successful trip over the same route forgives it. The ledger persists with the
rest of the cache, so the bot stops burning time on routes that do not work.

```text
!routeCache        # how many routes are remembered, TTL, file location
!routeCache clear  # drop the cache
```

## Route choice & variety

When two viable routes exist (a careful probe and a may-break-blocks probe),
hazard-aware profiles don't blindly take the first — `route_choice.js` scores
each by length **plus hazard exposure** and picks deliberately. The breaking
route carries a handicap so it only wins when it's meaningfully safer/shorter.
A seeded touch of **variety** occasionally takes the near-equivalent
alternate instead, so repeat trips don't trace one robotic line forever —
bounded by `settings.navigation.route_variety` (default 0.1) and never into a
clearly worse route.

## Frontier exploration

`exploration.js` keeps a persisted record of chunks the bot has stood in
(`bots/<name>/exploration.json`) and picks frontier goals on an expanding
ring around its origin — always preferring directions with no recorded
visits. Direction choice comes from the seeded personality RNG, so two bots
explore differently but each bot is reproducible.

```text
!explore 3         # walk 3 outward legs with legit, hazard-aware movement
```

Exploration stops cleanly on interruption, records chunks reached per leg, and
expands the ring automatically once the current one is fully visited. Along
the way it also notes what it passes — dark cave openings and nether portals
become durable POIs automatically.

## Caves & portals

`caves.js` finds caves the legit way — the server already reports air and
light: a dark walk-in opening (air with solid ground, open above, light ≤ 4)
is remembered as a `cave` POI (`!caves`), and `isUnderground` knows when the
bot has no skylight over its head.

`portals.js` does the same for nether portals: observed `nether_portal`
blocks are clustered into one portal per frame, remembered per dimension
(`!portals`), and when the server moves the bot between dimensions the
arrival point is anchored as a portal. Trip planning uses the classic 1:8
shortcut — `!portalPlan 800 -300` returns step-by-step guidance folding in
any portal the bot already knows.

```text
!caves              # remembered cave openings
!portals            # remembered nether portals (per dimension)
!portalPlan 800 -300
```

## Shared bases (multi-agent)

Every bot publishes its home and outposts to one shared registry
(`bots/shared/bases.json`) the moment they are set — no extra server traffic,
just local coordination. Any bot can see where its companions live with
`!sharedBases` and route to the nearest one (`nearestSharedBase`). Publishing
is best-effort: a bot with no write access still works, just alone.

```text
!sharedBases
```

# Tool Durability & Replacement

`src/agent/library/durability.js` keeps tools from silently dying mid-job. It
is fully legit: durability comes from the item-damage metadata the server
already sends for the bot's own inventory.

* **Awareness** — `!tools` lists every tool with remaining/max durability and a
  percentage, flagging anything below the 15% replacement threshold as `WORN`
  and anything at zero as `BROKEN`.
* **Durability-aware digging** — `breakBlockAt` and Baritone-style `mineBlocks`
  call `ensureUsableTool` before each dig: if the held tool can't harvest, is
  nearly dead, or is broken, the bot swaps in the healthiest harvestable tool
  from its inventory instead of snapping the one in hand.
* **Replacement planning** — `replacementPlan` checks the tool's crafting
  recipe against the inventory and reports `craftable` now or exactly which
  materials are missing.
* **Automatic replacement** — `!replaceTool <tool>` equips the healthiest
  spare, or crafts a fresh one (via the normal crafting skill) when no spare
  exists, then equips it.

```text
!tools
!replaceTool iron_pickaxe
```

# Autonomous Task Loop

`src/agent/autonomy/` gives the bot a deliberate, needs-driven idle loop —
the "larger autonomous behavior" stage of the progression. It complements
(but never overrides) user commands, LLM self-prompting, and survival modes.

* **Needs scoring** — while idle, the loop builds a state snapshot and scores
  needs by urgency: broken/nearly-dead tools (replace), nearly-full inventory
  (unload to storage), low torches/food (restock), ripe crops (farm), bedtime
  (rest), dark spots around home (maintain_base), a configured patrol circuit
  (patrol, daytime only), and frontier exploration after long idle. Risky
  needs are held while hostiles are close; night dampens wandering.
* **Guardrails** — runs only when truly idle (no action, no conversation, no
  self-prompting), personality-paced cooldown between runs, a hard action
  timeout, and a bounded history. Executors catch their own errors; the loop
  itself never throws.
* **Interruptible** — every action runs through the normal action manager
  (`autonomy:*` labels), so `!stop` and new user messages interrupt it, and
  the behavior FSM tracks it like any other activity.

```text
!autonomyStatus        # on/off, cooldown, last run, current needs, history
!setAutonomy off       # pause the loop; "on" resumes it
!setRisk cautious      # risk posture: cautious | balanced | bold
```

Configuration lives under `settings.autonomy` (`enabled`, `cooldown_s`,
`action_timeout_s`, and per-need thresholds like `tool_replace_threshold`,
`explore_when_idle`, `explore_idle_s`, `min_torches`, `min_food`,
`max_unload_types`, `farm_radius`, `max_harvest`, `max_plants`).

# Social Memory & Reactions

`src/agent/social/` gives the bot persistent people skills — all legit, built
only on entities the server actually reports.

* **Player ledger** — `bots/<name>/player_ledger.json` remembers every player
  ever seen: trust level (`friend`/`neutral`/`hostile`), first/last seen
  times, sighting counts, and last known distance. Bounded to 128 players,
  atomic writes, corrupt-file tolerant.
* **Reactions** — a throttled social pass detects players entering view,
  approaching (≤12m), and departing (≥24m). Cooldown-gated and
  personality-paced, the bot occasionally *whispers* a contextual reaction:
  warm greetings scaled by sociability, wary notices for hostiles, the
  occasional farewell. It never speaks over an active conversation and
  respects `!stfu`.
* **Trust commands** — teach the bot who to like:

```text
!social                          # everyone remembered, with trust + last distance
!trustPlayer Steve helped build  # mark friend (note optional)
!distrustPlayer Eve griefed      # mark hostile
```

Reactions can be disabled entirely with `settings.social.greetings: false`.

# Storage, Reserves, Farming & Risk

The autonomy loop (`src/agent/autonomy/`) now keeps the bot's material life in
order and lets you dial its risk appetite — all using only information the
server already provides.

* **Autonomous storage management** — when free slots run low, the loop finds
  the nearest chest within 32 blocks and deposits bulk non-essentials (sorted
  by volume), always keeping tools, armor, food, and working items like
  buckets and flint & steel. Deposits go through the normal `putInChest`
  skill so the storage index stays accurate.
* **Self-maintained reserves** — two new needs top up consumables when
  materials allow: torches (`min_torches`, default 8, crafted from
  coal/charcoal + sticks) and food (`min_food`, default 5, bread from wheat).
  Nothing is crafted unless the recipe materials are already in hand.
* **Autonomous farming at base scale** — when food is low and bread can't be
  crafted, the loop tends crops instead: it harvests mature wheat, carrots,
  potatoes and beetroots (reading the server-reported growth age), plants
  carried seeds on open farmland, and *grows the farm itself*: when seeds
  outnumber farmland it hoes new soil within hydration range of water and
  plants it (`max_till` plots per run, `farm_expand: false` to disable).
  Bounded per run (`max_harvest`/`max_plants`/`farm_radius`) and
  interruptible like every other autonomy action.
* **Animal husbandry** — the food loop extends to animals: when the bot
  carries breeding food (wheat for cows/sheep/mooshrooms, carrots for pigs,
  seeds for chickens) and adult animals are nearby, a `husbandry` need pairs
  them up — bounded per run (`max_breed_pairs`), daytime-only, risk-gated
  like other outdoor work. `!breedAnimals` does it on demand.
* **Named storage spots** — teach the bot where storage lives with
  `!nameStorage tools` standing next to a chest; `!storageSpots` lists them.
  When no chest is within 32 blocks, inventory unloads route to the nearest
  known spot (named spots, or the last chest that worked) within 64 blocks.
* **Multi-chest load balancing** — instead of cramming everything into the
  nearest chest, the unload executor ranks every chest in range by estimated
  free capacity (from the storage index — legit, since it only reflects what
  the bot has seen in its own container windows) against distance, then
  spreads the deposit list across the best targets so no single chest
  overflows.
* **Storage reservation** — claim a named spot for specific item types with
  `!reserveStorage tools iron_ingot,gold_ingot`; future unloads route those
  items to that chest first. Pass no items to clear the reservation.
* **Risk-aware planning** — before every autonomous action the loop assesses
  local danger (hostile mobs in range, night) against the bot's risk posture.
  Under high risk, risky work (exploration, farming) is held — and recorded
  in `!autonomyStatus` — while safe upkeep (tool swaps, crafting reserves)
  still proceeds.
* **Risk postures** — `!setRisk cautious|balanced|bold` applies a preset from
  `humanlike/personality.js`: cautious uses the hazard-aware `safe` path
  profile and skips idle exploration, balanced uses default paths and
  explores when idle, bold uses fast paths (which may dig) and explores. The
  posture also scales the risk assessment (bold tolerates more, cautious less).
* **Risk-aware route selection** — `navigation/route_choice.js` scores routes
  by how much hazard corridor they cross (hard hazards count double) and picks
  the safer one; autonomous exploration scans local hazards and steers its
  frontier goals around them as avoid-zones.

```text
!setRisk cautious     # slow and careful
!setRisk balanced     # default
!setRisk bold         # fast, exploratory, may dig
!nameStorage tools    # remember the nearest chest as "tools"
!storageSpots         # list remembered storage spots
!reserveStorage tools iron_ingot,gold_ingot   # route these items to "tools"
```

# Survival Metrics

`src/agent/library/metrics.js` tracks how the bot is actually doing, persisted
across sessions at `bots/<name>/metrics.json`: total deaths, a per-cause
breakdown (refined from the server's death message), the last death position,
session uptime, and deaths-per-hour. It is wired to the bot's death events
automatically — benchmarks can assert on it, and you can just ask:

```text
!metrics
```

Four new social-flavored personality presets are also available via
`settings.personality.preset`: `guardian`, `greeter`, `scout`, and `worker`.

# Mental Map (POI Notes)

`src/agent/memory/mental_map.js` gives the bot a durable sense of *where
things are*: a journal of places of interest that the LLM authors as it
discovers the world — villages, houses, bases, farms, storage, water, caves,
landmarks — and reads back in later sessions. It complements the WorldModel:
the model holds verified, decaying facts; the mental map holds durable,
human-readable place notes with provenance (told / observed / inferred).

* **The LLM takes notes** — after finding something interesting, the bot (or
  you) notes it: `!notePlace desert-village village blacksmith has loot`.
  Notes near an existing POI of the same type merge instead of duplicating,
  bumping the sighting count.
* **Automatic notes** — deaths are noted automatically with the extracted
  cause; the map also seeds itself from the home waypoint, last death
  position, and named storage spots.
* **Recall & travel** — `!pois` (optionally filtered by type) lists
  everything remembered; `!goToPoi desert-village` travels there;
  `!memory` now includes the mental map so the LLM sees it whenever it
  inspects its own memory.

```text
!notePlace riverside-house house two floors, door broken
!pois village               # filter by type
!goToPoi desert-village
!forgetPoi old-camp
```

# Storage-Aware Fetching

Because the storage index remembers what was put where, the bot can plan
retrievals instead of re-searching: `!fetchItem iron_ingot 32` routes to the
containers believed to hold the item (from the index), walks there, and
withdraws until satisfied — reporting exactly which chests it visited.

```text
!fetchItem iron_ingot 32    # get 32 iron from storage
!fetchItem bread            # get every stored bread (-1 = all)
```

# Chest Tidying, Sorting & Stack Management

Chests the bot uses a lot accumulate scattered partial stacks of the same
item, and eventually end up in arbitrary order. Both problems are fixed the
way a player would do it — ordinary container windows, no slot-packet tricks:

* **Tidy** — `!organizeChest` detects scattered partial stacks and
  consolidates them: withdraw the item entirely and re-deposit it, letting
  vanilla merge the stacks.
* **Sort** — `!sortChest` rearranges the whole chest into a deterministic
  order: category groups (tools / armor / food / resources / blocks / misc),
  then item name, then stack size, empties last — applied with window-click
  swaps.

```text
!organizeChest              # consolidate scattered stacks in the nearest chest
!sortChest                  # full category/name/count sort of the nearest chest
```

The tidying module also produces category manifests so the LLM can reason
about what a chest is for.

# Respawn & Bed Awareness

The bot tracks where the server puts it after death: every respawn bumps the
metrics counter, records the position, and notes a `spawn` POI in the mental
map. Beds anchor respawns, so the bot scans for one and notes the nearest as
its respawn anchor — automatically on login/respawn, or on demand:

```text
!findBed                    # scan for a bed and note it as respawn anchor
!metrics                    # respawns are listed alongside deaths
```

# Bedtime & Home Maintenance

The autonomy loop keeps the bot's home life in order with two needs that run
only when it is safe and sensible:

* **Bedtime (`rest`)** — at night, if the bot knows a bed (mental map or a
  bed it can reach), it sleeps until morning instead of wandering. Sleep is a
  *risky* need: the risk gate holds it whenever hostiles are close, so the
  bot never dozes off in danger. `!sleep` triggers it on demand.
* **Home lighting (`maintain_base`)** — the bot scans the area around its
  home (`settings.autonomy.needs.maintain_radius`) for spots dark enough to
  spawn mobs and places torches there, but only when it actually carries
  torches. Keeps the base lit without being asked.
* **Patrol (`patrol`)** — with two or more named stops configured in
  `settings.autonomy.needs.patrol_pois` (mental-map POI names, or `"home"`),
  an idle bot walks the circuit by day instead of frontier-exploring: each
  leg is risk-checked, the loop closes back on the first stop, and anything
  that interrupts an action stops the patrol cleanly. `!patrol` runs a
  circuit on demand.
* **Coming home** — after wandering errands (explore, farm, unload, patrol)
  the loop walks the bot back to its home base, best-effort. Disable with
  `settings.autonomy.needs.return_home_after_errand: false`.

```text
!sleep                                # sleep in the nearest bed now
!patrol home north-tower storage-shed # walk a named circuit now
```

# Spatial Recall

`src/agent/memory/recall.js` wires retrieval into the bot's spatial memory:
search everything it knows about places — mental map POIs, saved memory-bank
places, named storage spots — with a free-text query. Scoring is local and
deterministic: exact name > name substring > type > notes, ties broken by
distance from the bot.

Recall also accepts an **optional embedding hook**: if the agent carries an
`_embedding_provider` with `embed(text) -> number[]`, each candidate's
keyword score is blended with its cosine similarity to the query (weight 2),
so semantically close places float up even when the words differ. Without a
provider — or if it errors — recall silently falls back to pure keywords, so
it never depends on an external service.

```text
!recall village blacksmith  # ranked matches across all spatial memory
!recall iron storage
```

# Legit Awareness (Radar)

Borrowing the *information* side of utility clients like Meteor Client and
LiquidBounce — not their cheats — the bot can build a detailed picture of its
surroundings purely from data the server already sends:

* **Player intel** — exact positions, distances, compass bearings, health,
  sneak/sprint state and held item for every visible player.
* **Entity intel** — mobs, animals and other entities with position and bearing.
* **Ground items** — dropped item stacks and where they are.
* **Storage scan** — positions of nearby chests, furnaces, hoppers, barrels and
  shulker boxes (locations only; nothing is opened).
* **Line of sight** — sampled raycast between the bot's eye and a target point.

This is fed into the AI's context so it can reason about *where* things are,
not just that they exist, and is exposed as a command:

```text
!radar
```

This is observational awareness only. It does not send packets the bot isn't
supposed to send and is not a mechanism for bypassing anti-cheat.

# Storage Awareness

The bot keeps an **item-location database**: every container it opens or scans
is remembered by position with what was last seen inside. Viewing, depositing
and withdrawing (`!viewChest` / `!putInChest` / `!takeFromChest`) all feed the
index, and the radar's storage scan seeds positions of unopened containers. The
index is capped, pruned by age, and persisted per-bot to
`bots/<name>/storage_index.json`.

```text
!storage
!findItem iron_ingot
```

This is best-effort knowledge from the bot's own window interactions — never
from packets it shouldn't have — so it answers "where is my iron?" with a
position instead of re-scanning the world.

# Home, Outposts & Unified Status

```text
!sethome
!home
!setOutpost mine-camp
!outposts
!removeOutpost mine-camp
!status
!memory
```

`!sethome` marks the current position as a persistent home waypoint (stored in
the world model and memory bank); `!home` walks back to it. On top of home,
the bot can keep **named outposts** — secondary bases like a mine camp or a
village house (`!setOutpost <name>`). Outposts are stored with the same
redundancy as home and noted in the mental map as `base` POIs, so the LLM can
read them back with `!pois`/`!memory`. The autonomy loop is multi-base aware:
after wandering errands it returns to the **nearest** base, and base upkeep
(lighting) centers on whichever base the bot is living at. `!outposts` lists
everything. `!status` gives one report combining the current action,
position/health/hunger, the Baritone movement profile and goal, plan progress,
and nearby players. `!memory` inspects saved places, the home waypoint, and a
world-model summary.

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

The system deliberately bypasses locomotion humanization where precise control is required, such as:

* PvP aiming
* Riding
* Swimming
* Explicit skill-driven camera control

(Digging and block placement are *timing*-humanized separately by the behavior
layer below, without affecting the pathfinder's precise movement.)

Humanization is intended to make movement behavior less rigid; it is not intended as a mechanism for bypassing server security systems.

# Humanlike Behavior Layer

Beyond locomotion, `src/agent/humanlike/` is a deliberate behavior layer where
**all** randomness lives — seeded, bounded, and reproducible:

* **`rng.js`** — seeded PRNG (mulberry32 + FNV-1a string hashing) with bounded
  helpers: `range`, `int`, `chance`, `pick`, `triangular`, `jitter`, `bell`.
* **`personality.js`** — per-bot trait vectors derived deterministically from a
  seed (defaults to a hash of the bot name): `pace`, `curiosity`, `caution`,
  `restlessness`, `sociability`, `precision`. Presets: `default`, `curious`,
  `cautious`, `energetic`, `laidback`, `social`; exact values can be pinned via
  overrides. Same seed ⇒ identical behavior, so tests are reproducible.
* **`behavior_state.js`** — explicit state machine
  `IDLE → OBSERVE → DECIDE → ACT → VERIFY → REACT/INTERRUPTED/RECOVER → RESUME`.
  It remembers interrupted activities on a stack so the bot can resume what it
  was doing, and it is mirrored from the action manager in `agent.js`.
* **`attention.js`** — line-of-sight-gated sightings (no staring through
  walls), novelty detection, last-seen tracking, sudden-event recording
  (`entityHurt`, damage, loud sounds), and bounded glances with imprecision.
* **`startle.js`** — loud sounds (explosions, lightning, withers, ghasts,
  TNT…) make the bot flinch and look: the event is recorded in attention and
  the camera glances at the source. It never interrupts the current action —
  the risk gate handles actual danger.
* **`interaction.js`** — look-before-you-act focus and bounded, personality-
  scaled pauses for digging, placing, equipping, and opening containers, wired
  into `skills.breakBlockAt/placeBlock/equip`, chest skills, and Baritone-style
  mining. Gated off automatically in cheat mode and via `bot._humanlike_off`.
* **`idle.js`** — context-dependent idle selection: glances at novel sights,
  short hazard-checked wanders (gated by restlessness and idle time),
  "checking the bag" look-downs, and bounded look-around sweeps.

Wiring:

* `idle_staring` mode now glances only at things the bot can actually see,
  turns toward fresh events, and uses personality-driven cadence.
* `idle_behavior` mode performs the longer idle activities with long cooldowns.
* `!status` reports the behavior state, pending resume, attention summary, and
  personality preset/seed.

Configuration lives under `settings.humanlike`:

```jsonc
"humanlike": {
    "enabled": true,
    "seed": null,                  // fixed seed for reproducibility (else bot-name hash)
    "personality": {
        "preset": "default",      // default|curious|cautious|energetic|laidback|social|guardian|greeter|scout|worker
        "overrides": {}            // e.g. { "curiosity": 0.9 }
    },
    "interaction": {
        "enabled": true,
        "dig_pause_ms": [80, 280],
        "place_pause_ms": [60, 220],
        "equip_pause_ms": [50, 250],
        "window_pause_ms": [150, 450]
        // ... focus_dwell_ms, focus_offset, post_action_pause_ms
    },
    "idle": { "enabled": true, "wander": true, "inspect": true, "radius": 4 }
}
```

All timing values are [min, max] envelopes; actual waits are triangular within
the envelope and scaled by the bot's `pace` trait, so every delay stays bounded.

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

Beyond the scenario pipeline, each behavior layer has its own deterministic
benchmark suite under `tests/` (run with `npm test`): **navigation**
(route replay/cache hygiene/hazards), **storage** (unload at scale, balancing,
reservations, tidying/sorting, fetch, recall), **survival** (a simulated week
of needs + risk decisions), **humanlike behavior** (8 interrupt/resume and
pacing scenarios), **exploration** (frontier coverage, ring expansion, seed
reproducibility, avoid-zone steering, cross-session persistence) and
**recovery** (interrupt-resume, death/respawn bookkeeping, route-failure
campaigns, partial-failure executors, mid-patrol danger aborts, crash
containment). The real-LLM path (`scripts/benchmark_llm.js`) swaps only the
planner's model-decision function into the identical pipeline, with call,
retry, timeout and cost limits enforced.

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
node scripts/live/run_controlled_test.js --print-plan --driver mineflayer --features direct --only connect,observe,report
```

`--print-plan` prints the resolved target, gates, credentials status, selected plan, and exclusions, then exits before constructing a driver or opening a socket. `--only connect,observe,report` runs exactly those phases; the report marks the other runnable phases as intentionally excluded.

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
