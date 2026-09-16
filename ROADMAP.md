# Full GO list

Master roadmap for the fork. Checked items are implemented in this repository
(references point at the main module); unchecked items are the open work queue.
Status audited 2026-09-16 against branch `arena/01a0aa05-mindcraft`.

Legend: `[x]` implemented · `[~]` partial / groundwork present · `[ ]` open

### Core architecture

* [x] Persistent world model — `src/agent/world_model/` + `store.js`
* [x] Short-term memory — `src/agent/history.js` conversation buffer
* [x] Long-term world memory — `memory_bank.js`, learned skills, persisted world model
* [~] Semantic memory — embedding model configurable per profile; retrieval not wired
* [x] Entity memory — world-model `entity` facts via observation collector
* [x] Location/waypoint memory — `memory_bank.js` + world-model `location` facts
* [x] Observation timestamps — every fact carries `firstSeen`/`lastSeen`
* [x] Observation confidence — source-based defaults (observed/verified/inferred/told)
* [x] Stale-information expiration — TTLs + confidence decay + pruning in collector
* [x] Event-driven architecture — mineflayer events → collector + `modes.js`
* [x] Unified task system — `tasks.js` + construction/cooking/crafting task modules
* [x] Task queue — planner step queue + action manager queue
* [~] Task priorities — mode ordering + interruption, no formal priority values
* [x] Task cancellation — `!stop`, interrupt propagation
* [x] Task pausing/resuming — mode pause/unpause, schematic build resume
* [x] Task persistence across restarts — npc data + world model + memory bank files
* [~] Checkpointing — construction registry snapshots; plan state persisted per step
* [x] Automatic replanning — `planning/recovery.js`, `!planReplan`, critic
* [x] Failure/recovery manager — `planning/recovery.js` + recovery tests
* [ ] State machine for major activities

### Humanlike behavior

* [x] Humanlike movement speed variation — `humanlike.varied_pace`
* [ ] Natural acceleration/deceleration
* [x] Occasional pauses — `humanlike.hesitations`
* [x] Idle behavior — `idle_staring` mode + idle glances
* [x] Looking around naturally — idle glances
* [x] Natural camera/head movement — humanizer gaze smoothing
* [ ] Look toward interesting entities
* [~] Look at blocks before interacting — placeBlock lookAt; not generalized
* [x] Imperfect camera movements — gaze jitter
* [x] Humanlike turning arcs — max turn rate per tick
* [x] Occasional small aim corrections — jitter + easing gain
* [x] Avoid perfectly deterministic movement
* [ ] Avoid robotic path repetition
* [ ] Natural path choice when multiple routes exist
* [ ] Occasional route reconsideration
* [ ] Humanlike strafing
* [ ] Natural jumping decisions
* [x] Contextual sprinting — sprint ratio mixing
* [ ] Stop sprinting near obstacles
* [ ] Humanlike swimming
* [ ] Humanlike climbing
* [ ] Humanlike bridge/build movement
* [x] Humanlike block interaction timing — `block_place_delay`
* [x] Variable click/interact timing — delay jitter in skills
* [ ] Variable mining timing
* [x] Variable placement timing
* [x] Small reaction delays — `reaction_delay_ms`
* [ ] Context-dependent reaction speed
* [ ] Natural inventory navigation
* [ ] Natural hotbar selection
* [ ] Avoid unnecessary inventory rearrangement
* [x] Occasionally inspect surroundings — idle staring mode
* [x] Notice nearby players — collector + radar into AI context
* [x] Notice mobs — collector entity facts
* [x] Notice dropped items — item facts + item_collecting mode
* [x] React to damage — self_preservation + entityHurt
* [ ] React to explosions
* [ ] React to unexpected events
* [~] Retreat when surprised — cowardice is proximity-based, not surprise-based
* [ ] Hesitate before uncertain actions
* [ ] Prefer safe routes when appropriate
* [ ] Occasional idle wandering
* [ ] Sit/stand behavior where applicable
* [x] Natural sleep behavior — `goToBed` skill/nighttime flow
* [x] Natural eating behavior — mineflayer-auto-eat
* [ ] Food selection based on context
* [x] Tool switching based on context — bestHarvestTool/equip
* [ ] Bring appropriate tools before leaving
* [ ] Return home after completing errands
* [ ] Humanlike exploration patterns
* [ ] Avoid constantly looking at entities through walls
* [x] Only use information the bot could legitimately observe — legit radar posture
* [x] Perception range constraints — radar ranges + collector entity_radius
* [~] Line-of-sight-aware perception — `lineOfSight` available; perception not yet gated by it
* [x] Memory decay — confidence decay with half-life
* [x] Uncertainty in remembered information — fact confidence
* [~] Behavioral personality configuration — profiles/npc data; no personality schema
* [x] Different behavior profiles — agent profiles + movement profiles
* [ ] Conservative/aggressive exploration preferences
* [ ] Social behavior profiles
* [~] Configurable idle behavior — humanlike idle knobs; idle mode itself fixed
* [ ] Configurable risk tolerance
* [~] Non-deterministic but reproducible behavior seeds — benchmark scenarios seeded; live behavior not

### Perception

* [x] Player radar — `src/agent/sensors/radar.js`
* [x] Mob radar — `entityIntel`
* [x] Item radar — `groundItems`
* [x] Container detection — `storageScan` + `storage/index.js`
* [x] Block detection — `getNearestBlocks`, `!searchForBlock`
* [x] Structure detection — world-model `structure` facts
* [x] Line-of-sight system — `radar.lineOfSight`
* [ ] Visibility scoring
* [x] Threat detection — collector threat classification + self_defense
* [x] Nearby-player awareness
* [x] Nearby-mob awareness
* [ ] Sound/event awareness where Mineflayer exposes it
* [x] Environment awareness — biome/weather in `!stats` + full state
* [x] Day/night awareness
* [x] Weather awareness
* [x] Dimension awareness
* [x] Health awareness
* [x] Hunger awareness
* [x] Armor awareness — `!inventory` wearing section
* [x] Held-item awareness
* [ ] Movement-state awareness
* [ ] Chunk awareness
* [~] Hazard detection — self_preservation covers lava/fire/falling blocks/drowning

### Navigation

* [x] Baritone-style goals — `src/agent/baritone/goals.js`
* [x] Goal composites — `GoalAny`/`GoalAll`/`GoalInvert`
* [x] Movement profiles — `baritone/settings.js` (default/legit/fast/builder)
* [x] Path preview — `!previewPath`
* [ ] Path visualization
* [x] Dynamic replanning — pathfinder recompute + `GoalFollow.hasChanged`
* [x] Waypoints — memory bank places
* [x] Named locations — `!rememberHere` / `!savedPlaces`
* [x] Home location — `!sethome` / `!home`
* [~] Storage location — container index knows chest positions; no named storage spots
* [x] Mine locations — world-model resource deposits
* [x] Village locations — world-model locations + village benchmark
* [ ] Portal locations
* [x] Build locations — persisted `npc.data.built` corners
* [ ] Safe-zone locations
* [ ] Route caching
* [ ] Route invalidation
* [x] Dynamic obstacle handling — pathfinder re-plans on world changes
* [~] Hazard-aware pathfinding — default Movements avoid fire/lava/cobweb + hazard blocks added by baritone layer
* [x] Lava avoidance — `blocksToAvoid`
* [x] Water handling — liquid movements + drowning response
* [~] Fall-risk evaluation — `maxDropDown` per profile
* [x] Fire avoidance — `blocksToAvoid`
* [ ] Hostile-mob avoidance — cowardice keeps distance; not wired into path costs
* [ ] Safe route scoring
* [x] Vertical navigation — pathfinder towers + `!digDown`/`!goToSurface`
* [ ] Cave navigation
* [x] Surface navigation — `goToSurface`
* [~] Nether navigation — dimension-aware + nether benchmark scenario; no dedicated logic
* [ ] Portal routing
* [ ] Return-to-base behavior
* [~] Emergency escape behavior — `moveAway`/`avoidEnemies`; no dedicated escape flow
* [x] Follow behavior — `followPlayer` + `GoalFollow`
* [ ] Escort behavior
* [x] Flee behavior — cowardice + avoidEnemies
* [ ] Patrol behavior
* [ ] Wander behavior
* [x] Search behavior — `!searchForBlock` / `!searchForEntity`

### World model

* [ ] Persistent block knowledge
* [ ] Persistent chunk knowledge
* [x] Persistent structures
* [x] Persistent entities
* [x] Persistent containers — `storage/index.js` container index
* [x] Persistent resource locations
* [x] Persistent player sightings — `player:<name>` facts
* [x] Player last-seen position
* [ ] Player movement history
* [x] Mob sightings
* [x] Item sightings — short-TTL item facts
* [ ] Exploration history
* [~] Known dangerous locations — threat facts carry positions; no durable danger map
* [ ] Known safe locations
* [x] Known useful locations — location/structure/resource facts
* [ ] Known failed routes
* [ ] Known successful routes
* [x] World-model queries — `nearest`/`lastSeen`/`queryNearest`, `!where`/`!world`
* [x] World-model cleanup — expiry pruning + confidence floor
* [x] Save/load world model — `world_model/store.js`
* [ ] Database-backed world model — JSON files today
* [ ] Region/chunk indexing
* [x] Spatial queries — distance-sorted `nearest`

### Task planning

* [x] Goal parser — natural-language `!goal` / `!plan`
* [x] Goal decomposition — planner step generation
* [x] Multi-step plans
* [ ] Dependency graphs
* [~] Preconditions — critic checks; no formal precondition model
* [x] Postconditions — per-step verification
* [x] Task verification — verification pipeline + critic
* [x] Progress tracking — `!planStatus`
* [ ] Plan checkpoints
* [x] Dynamic replanning — recovery + replan commands
* [ ] Resource-aware planning
* [ ] Time-aware planning
* [ ] Risk-aware planning
* [ ] Priority handling
* [x] Interrupt handling
* [~] Background tasks — modes act as background behaviors
* [ ] Scheduled tasks
* [x] Compound goals — npc item/build goals
* [x] Goal memory — npc data persists goals

### Resources

* [x] Inventory abstraction — `world.getInventoryCounts`
* [x] Item indexing
* [x] Item lookup
* [x] Resource requirements — `!buildMaterials`, crafting plans
* [x] Resource dependency graph — detailed crafting plan
* [x] Missing-material calculation — build pause reports
* [x] Known-resource search — world-model resources + `!searchForBlock`
* [x] Resource gathering — `!collectBlocks` / `!mineBlocks`
* [~] Mining planner — nearest-first loop, no pit/branch strategy
* [x] Tool selection — bestHarvestTool
* [ ] Tool durability awareness
* [ ] Replacement tool planning
* [ ] Resource caching
* [ ] Resource reservation
* [x] Storage lookup — `!findItem` over the container index
* [ ] Storage reservation

### Mining

* [x] `#mine`-style mining — `baritone.mineBlocks`
* [x] Target selection — nearest matching block
* [x] Vein-aware mining — adjacent-same-type sweep after each dig
* [ ] Ore prioritization
* [x] Tool selection
* [ ] Safe mining
* [ ] Cave awareness
* [~] Lava awareness — pathfinding avoids lava; mining doesn't probe
* [x] Torch placement — torch_placing mode
* [ ] Mine entrance management
* [ ] Return path
* [ ] Inventory-full handling
* [~] Mining interruption recovery — honors interrupts, resumes on re-run
* [x] Mining progress tracking — progress callbacks + logs

### Crafting/smelting

* [x] Recipe database — minecraft-data
* [x] Recipe discovery — `!craftable`
* [x] Crafting planner — `!getCraftingPlan` + craftRecipe
* [x] Dependency resolution
* [x] Crafting-table handling
* [x] Furnace handling — smeltItem + clearFurnace
* [x] Smelting planner
* [x] Fuel management — getSmeltingFuel
* [x] Batch crafting — quantity parameter
* [ ] Crafting verification
* [ ] Automatic replacement tools
* [ ] Equipment preparation

### Building

* [x] Litematica import — `utils/schematic.js`
* [x] Litematica export — `utils/litematic_writer.js` + `!saveArea`
* [x] `.schem` export — `utils/sponge_writer.js` + `!saveAreaSchem`
* [x] Schematic validation — parse errors + version/unknown-block reports
* [x] Material quotation — `!buildMaterials`
* [x] Material planning — missing-material pause reports
* [x] Block dependency ordering — build_goal layer order
* [~] Build phases — level-by-level building; no named phases
* [x] Construction planner — construction tasks + projects
* [x] Placement planner
* [x] Placement verification — scanProgress/blockSatisfied
* [x] Build repair — repair passes + construction_damage detection
* [x] Resume interrupted builds
* [ ] Terrain preparation
* [x] Scaffold logic — placeBlock scaffolding
* [ ] Temporary-block management
* [x] Build progress tracking
* [~] Build cancellation — `!stop` aborts; no dedicated cancel bookkeeping
* [ ] Build rollback where practical

### Storage

* [x] Chest scanning — `!viewChest` + radar storage scan
* [x] Container indexing — `src/agent/storage/index.js`
* [x] Item-location database — index maps items → container positions
* [x] Deposit logic — `!putInChest`
* [x] Withdraw logic — `!takeFromChest`
* [ ] Sorting
* [ ] Stack management
* [ ] Storage optimization
* [ ] Overflow handling
* [ ] Named storage locations
* [ ] Storage-aware planning

### Survival

* [x] Health monitoring
* [x] Hunger monitoring
* [x] Food management — auto-eat
* [x] Armor awareness
* [x] Equipment management — armor-manager
* [ ] Tool durability management
* [x] Bed detection — goToBed
* [~] Sleep planning — sleeps when told/nighttime via skills; no proactive plan
* [~] Respawn-point awareness — death position remembered; bed spawn not tracked
* [x] Fire/lava emergency handling — self_preservation bucket logic
* [ ] Fall-damage avoidance
* [~] Suffocation detection — unstuck mode handles being stuck
* [x] Drowning detection
* [ ] Environmental survival planner
* [x] Death detection — collector onDeath
* [x] Death recovery — last_death_position memory + world-model fact
* [ ] Item recovery after death

### Farming

* [ ] Crop detection
* [x] Crop planting — tillAndSow
* [~] Crop harvesting — collectBlocks works on crops; no maturity check
* [ ] Replanting
* [ ] Farm maintenance
* [x] Animal detection — radar/entity intel
* [ ] Animal feeding
* [ ] Breeding
* [x] Animal harvesting — hunting mode
* [~] Food production planning — cooking tasks exist; no end-to-end farm loop

### Combat/defense

* [x] Hostile-mob detection
* [ ] Threat scoring
* [x] Defensive behavior — self_defense mode
* [x] Retreat behavior — cowardice mode
* [ ] Shield handling
* [x] Weapon selection — equipHighestAttack
* [x] Armor selection — armor-manager
* [ ] Emergency escape
* [ ] Safe-zone seeking
* [~] Combat state tracking — lastDamageTime/lastDamageTaken; no state machine
* [x] No-cheat interaction constraints — legit-only sensing and movement

### Social behavior

* [x] Player recognition
* [ ] Friend/ally memory
* [ ] Unknown-player classification
* [x] Nearby-player reaction — radar fed to context; modes respond
* [ ] Greeting behavior
* [x] Follow trusted players — followPlayer
* [x] Stop following on request — `!stop`
* [x] Player distance preferences — elbow_room mode
* [x] Social proximity behavior — elbow_room
* [x] Conversational context memory — conversation manager
* [x] Chat response timing — speak.js pacing
* [x] Context-aware chat
* [x] Avoid speaking every tick — cooldowns + shutUp
* [x] Idle chat suppression — `!stfu`
* [ ] Reaction to player actions
* [x] Shared-task behavior — multi-agent conversations
* [x] Trading behavior — showVillagerTrades/tradeWithVillager
* [x] Cooperation behavior — agent-to-agent chat + tasks

### Communication

* [x] Chat command parser — command regex + typed params
* [x] Natural-language goals — `!goal`/`!plan`
* [ ] Confirmation for risky actions
* [x] Status messages
* [x] Progress reports
* [x] Error explanations — formatted action errors
* [~] Task summaries — `!planStatus`; no natural-language summary
* [x] Memory inspection — `!savedPlaces`, `!memory`
* [x] World-model inspection — `!world`, `!where`
* [x] Navigation inspection — `!previewPath`, `!baritoneStatus`
* [x] Plan inspection — `!planStatus`, blueprint queries
* [~] Configurable verbosity — narrate_behavior toggle; not graduated

### Agent intelligence

* [x] Tool-use planner — native tools + coding tools
* [x] Action validation — tool_adapter validation + action verification
* [x] State validation — state_snapshot
* [x] Context compression — history memory summaries
* [ ] Relevant-memory retrieval
* [x] Spatial-memory retrieval — `!where`/nearest
* [x] Goal-aware context — full state injected per turn
* [x] Failure-aware context — recovery context + history
* [ ] Action confidence
* [ ] Uncertainty handling
* [~] Self-check before actions — critic for plans; not per-action
* [x] Post-action verification — verification pipeline
* [~] Reasoning checkpoints — ReAct message manager
* [x] Hallucination-resistant world queries — queries read live bot state
* [x] No invented world state
* [x] No invented inventory
* [x] No invented player locations — radar positions come from server entities

### Humanlike decision-making

* [~] Prefer simple solutions — prompt-guided; not enforced
* [~] Avoid unnecessary actions — prompt-guided
* [~] Avoid unnecessary travel — prompt-guided
* [ ] Batch related tasks
* [~] Remember ongoing intent — npc goals persist; LLM-side intent not
* [~] Contextual tool choice — bestHarvestTool for mining; general choice is LLM-driven
* [ ] Contextual route choice
* [ ] Contextual interaction choice
* [x] Change plans when circumstances change — recovery/replanning
* [x] Recover instead of immediately restarting — recovery manager
* [ ] Occasionally reconsider goals
* [ ] Use remembered preferences
* [ ] Distinguish urgent vs non-urgent tasks
* [x] Prioritize survival when necessary — self_preservation interrupts all
* [~] Prioritize user requests appropriately — conversation interrupt handling
* [ ] Explicit uncertainty when information is incomplete

### Debugging/observability

* [ ] Structured logs
* [~] Navigation logs — path_reset events; no structured nav log
* [ ] Perception logs
* [ ] Planning logs
* [ ] Inventory logs
* [ ] Building logs
* [ ] World-model logs
* [x] LLM logs — log_all_prompts + chat trace JSONL
* [x] Event tracing — chat trace projector + mindserver UI
* [~] Task timeline — mindserver UI shows history; no Gantt-style timeline
* [x] Performance metrics — benchmark metrics module
* [ ] Path metrics
* [x] Token/cost metrics — `models/token_usage.js`
* [ ] Error categorization
* [~] Debug commands — `!modes`/`!setMode`; no dedicated debug suite
* [x] Replayable sessions — benchmark replay + deterministic scenarios

### Testing

* [x] Unit tests — 250+ node:test cases
* [x] Integration tests — live controlled test harness
* [ ] Navigation tests
* [x] Goal tests — baritone goal suite
* [x] World-model tests
* [ ] Inventory tests
* [ ] Crafting tests
* [x] Mining tests — baritone mining suite
* [x] Building tests — schematic + build suites
* [x] Storage tests — storage index suite
* [x] Recovery tests
* [x] Death/reconnect tests — live reconnect feature
* [x] Persistence tests — world-model store suite
* [x] Human-behavior tests — humanizer suite
* [x] Deterministic behavior tests — benchmark harness
* [ ] Long-running agent tests
* [x] Regression suite — CI npm test

### Benchmarking

* [x] Gather-resource benchmark — iron_mine/tree_farm scenarios
* [x] Crafting benchmark — crafting task suite
* [x] Mining benchmark — iron_mine scenario
* [ ] Exploration benchmark
* [ ] Navigation benchmark
* [x] Building benchmark — shelter_build/construction scenarios
* [ ] Recovery benchmark
* [ ] Storage benchmark
* [ ] Survival benchmark
* [x] Multi-step task benchmark — scenario suite
* [ ] Humanlike-behavior benchmark
* [x] Efficiency metrics
* [x] Completion metrics
* [ ] Death metrics
* [ ] Replan metrics
* [ ] Movement metrics
* [ ] Resource-waste metrics
* [x] LLM-call metrics
* [x] Token-cost metrics
* [x] Seeded benchmark scenarios

### Configuration

* [x] Behavior profiles — agent profiles
* [x] Movement profiles — baritone profiles
* [ ] Risk profiles
* [ ] Social profiles
* [ ] Exploration profiles
* [ ] Building profiles
* [ ] Resource priorities
* [x] Forbidden behaviors — blocked_actions/blacklist_commands
* [x] Server-specific configuration — settings.js
* [ ] Per-world configuration
* [ ] Per-player trust configuration
* [x] Persistent settings

### UI/commands

* [x] `!radar`
* [x] `!previewPath`
* [x] `!listPathProfiles`
* [x] `!mineBlocks`
* [x] `!saveArea`
* [x] `!setPathProfile`
* [x] `!baritoneStatus`
* [x] `!goal`
* [x] `!tasks` — via `!planStatus`/npc goal introspection
* [x] `!status` — unified status query (action + nav + plan + radar)
* [ ] `!pause`
* [~] `!resume` — `!planResume` for plans; no global pause/resume
* [~] `!cancel` — `!stop` covers cancellation; no cancel-with-reason
* [x] `!inventory`
* [x] `!where`
* [x] `!home`
* [x] `!sethome`
* [x] `!memory` — memory inspection query
* [ ] `!map`
* [x] `!storage` — container index inspector
* [x] `!craft` — `!craftRecipe`
* [x] `!gather` — `!collectBlocks`/`!mineBlocks`
* [x] `!build` — `!buildSchematic`
* [ ] `!explore`
* [x] `!follow` — `!followPlayer`
* [x] `!stop`
* [ ] `!debug`

### Reliability

* [x] Graceful reconnect — live-tested reconnect feature
* [x] Server restart handling — reconnect
* [~] Chunk-load failure handling — blockAt null guards; no chunk tracking
* [x] Pathfinding failure handling — destructive fallback + error reports
* [~] Entity disappearance handling — GoalFollow guards vanished entities
* [ ] Inventory desync detection
* [x] World-state mismatch detection — construction_damage
* [x] Build mismatch detection
* [x] Network interruption recovery
* [~] LLM failure fallback — provider retries; no cross-provider fallback chain
* [x] Tool timeout handling — action timeouts
* [x] Action timeout handling — code_timeout_mins
* [~] Persistent crash recovery — state survives restarts; no crash-loop guard
* [x] Safe shutdown — cleanKill
* [~] Resume-after-crash — builds/goals resume; no crash detection

### Long-term autonomy

* [ ] Autonomous exploration
* [~] Autonomous resource gathering — npc item goals; not self-initiated
* [x] Autonomous crafting — npc item_goal chains
* [x] Autonomous building — npc build_goal
* [ ] Autonomous farming
* [ ] Autonomous storage management
* [ ] Autonomous base maintenance
* [x] Autonomous recovery
* [x] Autonomous task selection — self-prompter + npc goals
* [x] Long-running goals — npc projects
* [~] Multiple simultaneous objectives — modes concurrent; one action at a time
* [~] Background maintenance tasks — modes act as maintenance behaviors
* [ ] Self-maintained resource reserves
* [ ] Self-maintained equipment
* [ ] Self-maintained food supply
* [~] Self-maintained base — construction_damage repair; not proactive

### Final architecture target

```text
LLM
 │
 ▼
Goal / Task Planner
 │
 ▼
Decision + Behavior Layer
 │
 ├── Humanlike Behavior
 ├── Social Behavior
 ├── Risk Management
 └── Recovery
 │
 ▼
Task Executor
 │
 ├── Navigation / Baritone
 ├── Mining
 ├── Gathering
 ├── Crafting
 ├── Smelting
 ├── Storage
 ├── Building / Litematica
 ├── Farming
 └── Survival
 │
 ▼
World Model
 │
 ├── Blocks
 ├── Chunks
 ├── Players
 ├── Mobs
 ├── Items
 ├── Containers
 ├── Structures
 ├── Locations
 └── Memories
 │
 ▼
Sensors / Events
 │
 ├── Radar
 ├── World observations
 ├── Entity events
 ├── Inventory events
 ├── Chat
 └── Environment
```

The key progression is:

**commands -> actions -> tasks -> plans -> persistent world knowledge -> autonomous behavior -> believable humanlike behavior.**

Current position in that progression: commands/actions are mature, tasks and
plans are solid with verification and recovery, persistent world knowledge is
being filled in (world model, container index, waypoints), autonomous behavior
exists via npc goals + self-prompter, humanlike believability is the active
frontier (gaze/pace humanizer shipped; path and interaction variety pending).
