# Full GO list

Master roadmap for the fork. Checked items are implemented in this repository
(references point at the main module); unchecked items are the open work queue.
Status audited 2026-09-17 against branch `arena/01a0aa05-mindcraft`.

Legend: `[x]` implemented · `[~]` partial / groundwork present · `[ ]` open

### Core architecture

* [x] Persistent world model — `src/agent/world_model/` + `store.js`
* [x] Short-term memory — `src/agent/history.js` conversation buffer
* [x] Long-term world memory — `memory_bank.js`, learned skills, persisted world model
* [x] Semantic memory — keyword retrieval (`memory/recall.js`, `!recall`) plus optional embedding provider hook: an agent-level `_embedding_provider.embed(text)` blends cosine similarity into recall scores, keyword-only fallback
* [x] Entity memory — world-model `entity` facts via observation collector
* [x] Location/waypoint memory — `memory_bank.js` + world-model `location` facts
* [x] Mental map (POI notes) — `memory/mental_map.js`: durable village/house/base/farm/storage notes the LLM authors with `!notePlace` and reads via `!memory`/`!pois`/`!goToPoi`; deaths auto-noted
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
* [x] State machine for major activities — `humanlike/behavior_state.js` FSM (IDLE→OBSERVE→DECIDE→ACT→VERIFY→REACT/INTERRUPTED/RECOVER→RESUME), mirrored from the action manager in `agent.js`

### Humanlike behavior

* [x] Humanlike movement speed variation — `humanlike.varied_pace`
* [ ] Natural acceleration/deceleration
* [x] Occasional pauses — `humanlike.hesitations`
* [x] Idle behavior — `idle_staring` mode + idle glances
* [x] Looking around naturally — idle glances
* [x] Natural camera/head movement — humanizer gaze smoothing
* [x] Look toward interesting entities — `humanlike/attention.js` novelty glances (players/mobs/items, LOS-gated)
* [x] Look at blocks before interacting — `humanlike/interaction.focusOn` wired into dig/place/mine
* [x] Imperfect camera movements — gaze jitter
* [x] Humanlike turning arcs — max turn rate per tick
* [x] Occasional small aim corrections — jitter + easing gain
* [x] Avoid perfectly deterministic movement
* [x] Avoid robotic path repetition — `route_choice.js` seeded variety: hazard-aware profiles occasionally take a near-equivalent alternate instead of tracing one line forever
* [x] Natural path choice when multiple routes exist — `skills.goToGoal` scores both viable probes by hazard exposure (`chooseSaferRoute`) and picks deliberately
* [ ] Occasional route reconsideration
* [ ] Humanlike strafing
* [ ] Natural jumping decisions
* [x] Contextual sprinting — sprint ratio mixing
* [ ] Stop sprinting near obstacles
* [ ] Humanlike swimming
* [ ] Humanlike climbing
* [ ] Humanlike bridge/build movement
* [x] Humanlike block interaction timing — `block_place_delay` + `humanlike/interaction.js` pauses
* [x] Variable click/interact timing — delay jitter in skills
* [x] Variable mining timing — bounded dig pause + focus before each dig (skills + baritone)
* [x] Variable placement timing
* [x] Small reaction delays — `reaction_delay_ms`
* [x] Context-dependent reaction speed — reaction context scales urgent/relaxed, hesitation, seeded reconsideration (`reactions.js`)
* [~] Natural inventory navigation — bounded container-open pauses (`window_pause_ms`); slot moves still instant
* [~] Natural hotbar selection — bounded equip/swap pauses via `naturalEquip` + `skills.equip`
* [x] Avoid unnecessary inventory rearrangement — `sortWarranted` guard skips no-op sorts
* [x] Occasionally inspect surroundings — idle staring mode
* [x] Notice nearby players — collector + radar into AI context
* [x] Notice mobs — collector entity facts
* [x] Notice dropped items — item facts + item_collecting mode
* [x] React to damage — self_preservation + entityHurt
* [x] React to explosions — `humanlike/startle.js`: loud sounds (explosions, lightning, wither, dragon, ghast, TNT) record an attention event and the camera glances at the source
* [~] React to unexpected events — attention records entityHurt/damage + loud-sound events and the gaze turns toward them; no task-level interruption yet
* [~] Retreat when surprised — cowardice is proximity-based, not surprise-based
* [ ] Hesitate before uncertain actions
* [x] Prefer safe routes when appropriate — hazard-avoiding profiles choose the lower-exposure of two viable routes (handicap keeps block-breaking paths from winning on length alone)
* [x] Occasional idle wandering — `idle_behavior` mode: hazard-checked `shortWander`, gated by restlessness + idle time
* [ ] Sit/stand behavior where applicable
* [x] Natural sleep behavior — `goToBed` skill/nighttime flow
* [x] Natural eating behavior — mineflayer-auto-eat
* [x] Food selection based on context — settle/combat/normal contexts pick different foods, saturation-aware (`reactions.js`)
* [x] Tool switching based on context — bestHarvestTool/equip
* [ ] Bring appropriate tools before leaving
* [x] Return home after completing errands — autonomy runner walks back to home after explore/farm/unload/patrol (`task_loop.js`, `return_home_after_errand`)
* [ ] Humanlike exploration patterns
* [x] Avoid constantly looking at entities through walls — idle staring now gated by `lineOfSight`
* [x] Only use information the bot could legitimately observe — legit radar posture
* [x] Perception range constraints — radar ranges + collector entity_radius
* [x] Line-of-sight-aware perception — attention scans/glances gated by `lineOfSight`
* [x] Memory decay — confidence decay with half-life
* [x] Uncertainty in remembered information — fact confidence
* [x] Behavioral personality configuration — `humanlike/personality.js`: seeded trait vectors (pace/curiosity/caution/restlessness/sociability/precision), presets, overrides
* [x] Different behavior profiles — agent profiles + movement profiles + personality presets
* [x] Conservative/aggressive exploration preferences — `exploration_profile` setting + `!setRisk`, profile drives leg lengths and hazard tolerance
* [x] Social behavior profiles — sociability/curiosity traits + dedicated presets: `guardian`, `greeter`, `scout`, `worker`
* [x] Configurable idle behavior — `humanlike.idle` settings drive the `idle_behavior` mode
* [x] Configurable risk tolerance — `!setRisk cautious|balanced|bold` maps to path profile + exploration appetite
* [x] Non-deterministic but reproducible behavior seeds — personality seeded from bot name / `humanlike.seed`; all randomness in `humanlike/rng.js` with reproducible tests

### Perception

* [x] Player radar — `src/agent/sensors/radar.js`
* [x] Mob radar — `entityIntel`
* [x] Item radar — `groundItems`
* [x] Container detection — `storageScan` + `storage/index.js`
* [x] Block detection — `getNearestBlocks`, `!searchForBlock`
* [x] Structure detection — world-model `structure` facts
* [x] Line-of-sight system — `radar.lineOfSight`
* [x] Visibility scoring — `radar.visibilityAt` factors light, line-of-sight and weather
* [x] Threat detection — collector threat classification + self_defense
* [x] Danger awareness fed to the LLM — `sensors/danger.js` puts threat-scored monsters, hazard blocks, autonomy risk level, and underground/darkness into `getFullState().danger` every turn (legit, server-reported only); `!threats` for an on-demand digest
* [x] Nearby-player awareness
* [x] Nearby-mob awareness
* [x] Sound/event awareness where Mineflayer exposes it — sound events feed attention/notables and reactions
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
* [x] Hazard detection — `navigation/hazards.js` classifies hard/soft hazards + `scanHazards`; self_preservation covers lava/fire/falling/drowning

### Navigation

* [x] Baritone-style goals — `src/agent/baritone/goals.js`
* [x] Goal composites — `GoalAny`/`GoalAll`/`GoalInvert`
* [x] Movement profiles — `baritone/settings.js` (default/legit/fast/builder/safe)
* [x] Path preview — `!previewPath`
* [ ] Path visualization
* [x] Dynamic replanning — pathfinder recompute + `GoalFollow.hasChanged`
* [x] Waypoints — memory bank places
* [x] Named locations — `!rememberHere` / `!savedPlaces`
* [x] Home location — `!sethome` / `!home`
* [x] Multi-base / outpost management — `navigation/home.js`: named outposts (`!setOutpost`/`!outposts`/`!removeOutpost`) stored like home + mental-map 'base' POIs; `nearestBase` drives return-home and base upkeep
* [x] Multi-agent outpost coordination — `navigation/shared_bases.js`: every bot publishes homes/outposts to a shared file registry (`bots/shared/bases.json`); any bot can list companions' bases (`!sharedBases`) and route to the nearest one
* [x] Storage location — container index + named storage spots (`!nameStorage`/`!storageSpots`)
* [x] Mine locations — world-model resource deposits
* [x] Village locations — world-model locations + village benchmark
* [x] Portal locations — `navigation/portals.js`: observed portal blocks clustered and remembered as 'portal' POIs per dimension (`!portals`), dimension-change arrivals anchored automatically
* [x] Build locations — persisted `npc.data.built` corners
* [ ] Safe-zone locations
* [x] Route caching — `navigation/route_cache.js`: successful paths remembered and replayed (wired into `skills.goToGoal`)
* [x] Route invalidation — replayed routes re-verified against the live world; stale/blocked entries dropped (TTL + `verifyRoute`)
* [x] Dynamic obstacle handling — pathfinder re-plans on world changes
* [x] Hazard-aware pathfinding — `safe` profile + `navigation/hazards.js` hardens Movements around magma, berry bushes, cacti, campfires, soul sand, cobwebs
* [x] Lava avoidance — `blocksToAvoid`
* [x] Water handling — liquid movements + drowning response
* [x] Fall-risk evaluation — `fallRiskAt` with lethal/water-landing classification plus per-profile `maxDropDown`
* [x] Fire avoidance — `blocksToAvoid`
* [x] Hostile-mob avoidance — `threatExposure` scored into `chooseSaferRoute`, exposure decays with distance
* [ ] Safe route scoring
* [x] Vertical navigation — pathfinder towers + `!digDown`/`!goToSurface`
* [~] Cave navigation — openings detected/remembered, mouths safety-checked, guided torch-lit entry, and a dedicated baritone `cave` posture (hazard-aware, small drops, may clear gravel) that `!enterCave` selects; low-level pathfinding stays with baritone/pathfinder, no bespoke 3D planner
* [x] Surface navigation — `goToSurface`
* [~] Nether navigation — dimension-aware + nether benchmark scenario; no dedicated logic
* [x] Portal routing — `navigation/portals.js`: 1:8 coordinate math, step-by-step guidance (`!portalPlan`) AND execution (`executePortalTrip`, `!travelViaNether`): walk to a known portal, wait out the server-side transition, follow the nether-side route — no teleporting
* [x] Return-to-base behavior — same home-return hook in the task loop; base = mental-map home, best-effort and interrupt-safe
* [x] Emergency escape behavior — `autonomy/combat.js` decideEscape (critical health or overwhelming threats) + executeEscape (shield up, back off); `!escape` on demand
* [x] Follow behavior — `followPlayer` + `GoalFollow`
* [x] Escort behavior — `!escort`/`escortPlayer`: bounded 2-min follow, per-poll pathing, combat support, gives up past 28m (`autonomy/escort.js`)
* [x] Flee behavior — cowardice + avoidEnemies
* [x] Patrol behavior — `autonomy/patrol.js`: named circuits of mental-map POIs (`patrol_pois`), risk-checked per leg, `!patrol` command, autonomous patrol need by day
* [x] Wander behavior — `!wander` with exploration-profile legs (`exploration.js`)
* [x] Search behavior — `!searchForBlock` / `!searchForEntity`

### World model

* [ ] Persistent block knowledge
* [x] Persistent chunk knowledge — `ExplorationState.notes` chunk→biome (≤512 entries, persisted) + per-chunk ore/station notables
* [x] Persistent structures
* [x] Persistent entities
* [x] Persistent containers — `storage/index.js` container index
* [x] Persistent resource locations
* [x] Persistent player sightings — `player:<name>` facts
* [x] Player last-seen position
* [ ] Player movement history
* [x] Mob sightings
* [x] Item sightings — short-TTL item facts
* [x] Exploration history — `navigation/exploration.js` persists visited chunks per bot
* [x] Known dangerous locations — combat FSM records threat coordinates, `safe_zones` danger/safe spots persisted + `!dangerSpots`/`!safeSpots`
* [ ] Known safe locations
* [x] Known useful locations — location/structure/resource facts
* [x] Known failed routes — `navigation/route_cache.js` failure ledger: failed routes skipped on replay until TTL, forgiven on success, persisted
* [x] Known successful routes — successful pathfinds cached and replayed (`navigation/route_cache.js`, TTL-bounded, verified before reuse)
* [x] World-model queries — `nearest`/`lastSeen`/`queryNearest`, `!where`/`!world`
* [x] World-model cleanup — expiry pruning + confidence floor
* [x] Save/load world model — `world_model/store.js`
* [x] Database-backed world model — adapter interface in `world_model/store.js` (`world_model.adapter` setting, pluggable backends)
* [x] Region/chunk indexing — `world_model/spatial_index.js` chunk buckets
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
* [x] Risk-aware planning — `autonomy/risk.js` assesses hostiles/night vs. posture and holds risky work; `navigation/route_choice.js` picks safer routes and steers exploration around hazard avoid-zones
* [ ] Priority handling
* [x] Interrupt handling
* [~] Background tasks — modes act as background behaviors
* [x] Scheduled tasks — `autonomy.scheduled[]` entries (dawn/day/night/HH:MM), fires once per mc-day, bypasses executor gating
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
* [x] Mining planner — `!mineBlocks` ore-priority list + target types, lava probes, nearest-first loop; pit/branch strategies still LLM-directed
* [x] Tool selection — bestHarvestTool
* [x] Tool durability awareness — `library/durability.js` reads item damage metadata (`!tools`)
* [x] Replacement tool planning — `replacementPlan` diffs recipes vs inventory (`!replaceTool`)
* [ ] Resource caching
* [x] Resource reservation — `storage/reservations.js` + `!reserveResource`/`!reservations` with TTL and persistence
* [x] Storage lookup — `!findItem` over the container index
* [x] Storage reservation — `!reserveStorage` claims a named spot for item types; unloads route matching items there

### Mining

* [x] `#mine`-style mining — `baritone.mineBlocks`
* [x] Target selection — nearest matching block
* [x] Vein-aware mining — adjacent-same-type sweep after each dig
* [ ] Ore prioritization
* [x] Tool selection
* [ ] Safe mining
* [x] Cave awareness — `navigation/caves.js`: underground detection (skylight), dark-opening scan, remembered 'cave' POIs (`!caves`); exploration legs note caves/portals they pass
* [x] Lava awareness — pathfinding avoids lava and mining probes blocks before digging (`digIsSafe` lava check)
* [x] Torch placement — torch_placing mode
* [x] Mine entrance management — `!mineBlocks returnToEntrance` records and returns to the entry point
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
* [x] Crafting verification — post-craft inventory delta check emits `craft_verified`/`craft_short` and records waste
* [x] Automatic replacement tools — `!replaceTool` equips the healthiest spare or crafts a fresh one
* [ ] Equipment preparation

### Building

* [x] Litematica import — `utils/schematic.js`
* [x] Litematica export — `utils/litematic_writer.js` + `!saveArea`
* [x] `.schem` export — `utils/sponge_writer.js` + `!saveAreaSchem`
* [x] Schematic validation — parse errors + version/unknown-block reports
* [x] Material quotation — `!buildMaterials`
* [x] Material planning — missing-material pause reports
* [x] Block dependency ordering — build_goal layer order
* [x] Build phases — project phases with checkpoints (`planning/project.js`, `saveCheckpoint`) + `build_start` structured log
* [x] Construction planner — construction tasks + projects
* [x] Placement planner
* [x] Placement verification — scanProgress/blockSatisfied
* [x] Build repair — repair passes + construction_damage detection
* [x] Resume interrupted builds
* [x] Terrain preparation — `!clearArea x1 y1 z1 x2 y2 z2` (bounded 256, reports cleared/skipped)
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
* [x] Sorting — `storage/sorting.js` full slot-order sort (category/name/count) via window clicks, `!sortChest`; `!organizeChest` consolidates stacks
* [x] Stack management — `storage/tidying.js` detects scattered partial stacks and consolidates them (withdraw + re-deposit)
* [x] Storage optimization — unload balances deposits across multiple chests by estimated free capacity (`storage/balancing.js`)
* [x] Overflow handling — `inventory_full` need auto-unloads with multi-chest balancing, reservations, and spot routing
* [x] Named storage locations — `storage/placement.js` registry, persisted per bot
* [x] Storage-aware planning — unload routes deposits to named spots / last-used chest; `!fetchItem` plans and executes retrieval from indexed containers

### Survival

* [x] Health monitoring
* [x] Hunger monitoring
* [x] Food management — auto-eat
* [x] Armor awareness
* [x] Equipment management — armor-manager
* [x] Tool durability management — durability-aware swaps in `skills.breakBlockAt`/`baritone.mineBlocks` (never dig with a nearly-dead tool)
* [x] Bed detection — goToBed
* [x] Sleep planning — autonomous `rest` need at night when a bed is known, risk-gated (never sleeps with hostiles close); `!sleep`
* [x] Respawn-point awareness — respawn events tracked in metrics; nearest bed auto-noted as respawn anchor (`!findBed`, POI types `bed`/`spawn`)
* [x] Fire/lava emergency handling — self_preservation bucket logic
* [ ] Fall-damage avoidance
* [~] Suffocation detection — unstuck mode handles being stuck
* [x] Drowning detection
* [ ] Environmental survival planner
* [x] Death detection — collector onDeath
* [x] Death recovery — last_death_position memory + world-model fact
* [ ] Item recovery after death

### Farming

* [x] Crop detection — `autonomy/farming.js` scanCrops: type + growth-age scan over server-reported blocks
* [x] Crop planting — tillAndSow + autonomous plantSeeds on open farmland
* [x] Crop harvesting — autonomous harvest gated on maturity (`cropAge` vs per-crop maxAge)
* [x] Replanting — the farm loop plants carried seeds straight after harvests
* [x] Farm maintenance — autonomous need: harvest → plant → till new plots near water when farmland runs out (`max_till`, `farm_expand`)
* [x] Animal detection — radar/entity intel
* [x] Animal feeding — `autonomy/husbandry.js`: carries breeding food and feeds adult cows/sheep/pigs/chickens/mooshrooms
* [x] Breeding — autonomy `husbandry` need pairs nearby adults (bounded per run, risk-gated, day-only); `!breedAnimals` on demand
* [x] Animal harvesting — hunting mode
* [x] Food production planning — end-to-end base-scale farm loop: harvest, replant, and expand farmland to grow the food reserve without player help

### Combat/defense

* [x] Hostile-mob detection
* [x] Threat scoring — `autonomy/combat.js`: per-mob threat table × distance falloff → scored, sorted threat list with clear/skirmish/danger/overwhelm levels
* [x] Defensive behavior — self_defense mode
* [x] Retreat behavior — cowardice mode
* [x] Shield handling — combatReady equips the best carried weapon plus a shield on the off-hand (used by the escape flow and `!escape`)
* [x] Weapon selection — equipHighestAttack
* [x] Armor selection — armor-manager
* [x] Emergency escape — same dedicated flow as emergency escape behavior (`!escape`, decideEscape/executeEscape)
* [ ] Safe-zone seeking
* [x] Combat state tracking — combat FSM (idle/engaged/skirmish/overwhelm/damage/critical) with reactive escape and threat coords (`combat.js`)
* [x] No-cheat interaction constraints — legit-only sensing and movement

### Social behavior

* [x] Player recognition
* [x] Friend/ally memory — `social/player_ledger.js`: persistent trust levels, sightings, last distance (`bots/<name>/player_ledger.json`)
* [x] Unknown-player classification — ledger classifies friend/neutral/hostile/unknown
* [x] Nearby-player reaction — radar fed to context; modes respond
* [x] Greeting behavior — bounded, personality-paced approach greetings (whispered; respects `!stfu` and conversations)
* [x] Follow trusted players — followPlayer
* [x] Stop following on request — `!stop`
* [x] Player distance preferences — elbow_room mode
* [x] Social proximity behavior — elbow_room
* [x] Conversational context memory — conversation manager
* [x] Chat response timing — speak.js pacing
* [x] Context-aware chat
* [x] Avoid speaking every tick — cooldowns + shutUp
* [x] Idle chat suppression — `!stfu`
* [~] Reaction to player actions — approach/departure/new-sighting reactions shipped; reactions to builds/attacks not yet
* [x] Shared-task behavior — multi-agent conversations
* [x] Trading behavior — showVillagerTrades/tradeWithVillager
* [x] Cooperation behavior — agent-to-agent chat + tasks

### Communication

* [x] Chat command parser — command regex + typed params
* [x] Natural-language goals — `!goal`/`!plan`
* [x] Confirmation for risky actions — confirm gate on risky actions (`commands/confirm.js`, `confirm_risky_actions` setting)
* [x] Status messages
* [x] Progress reports
* [x] Error explanations — formatted action errors
* [x] Task summaries — natural-language `summarizeProject` + `!planSummary` with confidence/uncertainty flags
* [x] Memory inspection — `!savedPlaces`, `!memory`
* [x] World-model inspection — `!world`, `!where`
* [x] Navigation inspection — `!previewPath`, `!baritoneStatus`
* [x] Plan inspection — `!planStatus`, blueprint queries
* [x] Configurable verbosity — graduated verbosity levels wired into narration (`modes.js`)

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
* [x] Remember ongoing intent — behavior FSM activity stack (interrupt→remember→resume) + npc goals persist
* [~] Contextual tool choice — bestHarvestTool for mining; general choice is LLM-driven
* [ ] Contextual route choice
* [ ] Contextual interaction choice
* [x] Change plans when circumstances change — recovery/replanning
* [x] Recover instead of immediately restarting — recovery manager
* [ ] Occasionally reconsider goals
* [x] Use remembered preferences — mental-map POI visits/favorites tracked and read back (`mental_map.js`)
* [x] Distinguish urgent vs non-urgent tasks — needs sorted by urgency desc; urgent reactions pre-empt relaxed ones
* [x] Prioritize survival when necessary — self_preservation interrupts all
* [~] Prioritize user requests appropriately — conversation interrupt handling
* [ ] Explicit uncertainty when information is incomplete

### Debugging/observability

* [x] Structured logs — `structlog.js` structured event logging with per-category toggles (`structured_logs` settings)
* [x] Navigation logs — structured `route_ok`/`route_fail`/`path_preview` events + `!showPath`
* [ ] Perception logs
* [ ] Planning logs
* [ ] Inventory logs
* [ ] Building logs
* [ ] World-model logs
* [x] LLM logs — log_all_prompts + chat trace JSONL
* [x] Event tracing — chat trace projector + mindserver UI
* [~] Task timeline — mindserver UI shows history; no Gantt-style timeline
* [x] Performance metrics — benchmark metrics module
* [x] Path metrics — `paths{ok,fail,cachedReplays}` persisted in agent metrics
* [x] Token/cost metrics — `models/token_usage.js`
* [ ] Error categorization
* [x] Debug commands — `!debug` suite (state, metrics, zones, reservations) plus `!modes`/`!setMode`
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
* [x] Exploration benchmark — `tests/exploration_benchmark.test.js`: campaign coverage growth, ring expansion, seed reproducibility, avoid-zone steering, cross-session persistence, ledger bounds
* [x] Navigation benchmark — `tests/navigation_benchmark.test.js`: replay integrity, cache hygiene, hazard hardening, safe route selection, frontier consistency
* [x] Building benchmark — shelter_build/construction scenarios
* [x] Recovery benchmark — `tests/recovery_benchmark.test.js`: interrupt-resume, death/respawn bookkeeping across restarts, route-failure campaigns, partial-failure executors, mid-patrol danger aborts, executor-crash loop survival
* [x] Storage benchmark — `tests/storage_benchmark.test.js`: unload policy at scale, balanced spreads, reservations under load, tidy plans, fetch coverage, recall ranking
* [x] Survival benchmark — `tests/survival_benchmark.test.js`: multi-day decision suite (needs + risk gating)
* [x] Multi-step task benchmark — scenario suite
* [x] Humanlike-behavior benchmark — `tests/humanlike_benchmark.test.js`: 8 deterministic scenarios (interrupt-resume, route staleness, frontier coverage, need prioritization, reaction spam resistance, delay envelopes, idle stability, glance bounds)
* [x] Efficiency metrics
* [x] Completion metrics
* [x] Death metrics — `library/metrics.js`: persistent deaths/causes/positions, `!metrics`, wired to bot death events
* [x] Replan metrics — `replans`/`lastReplan` recorded on each replan
* [x] Movement metrics — `distanceWalked` tracked via movement events (`trackMovement`)
* [x] Resource-waste metrics — waste counters incl. `tool_broken`/`craft_short` recorded in metrics
* [x] LLM-call metrics
* [x] Token-cost metrics
* [x] Seeded benchmark scenarios

### Configuration

* [x] Behavior profiles — agent profiles
* [x] Movement profiles — baritone profiles
* [x] Risk profiles — `!setRisk` applies `RISK_PRESETS` (path profile + exploration flag)
* [x] Social profiles — personality sociability drives reactions; presets `guardian`/`greeter`/`scout`/`worker`
* [ ] Exploration profiles
* [ ] Building profiles
* [ ] Resource priorities
* [x] Forbidden behaviors — blocked_actions/blacklist_commands
* [x] Server-specific configuration — settings.js
* [ ] Per-world configuration
* [x] Per-player trust configuration — `!trustPlayer`/`!distrustPlayer`
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
* [x] `!pause` — global pause; chat + sensing continue, autonomy/modes blocked
* [x] `!resume` — global resume restoring pre-pause state
* [x] `!cancel` — cancel-with-reason clears the active goal and records the reason
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
* [x] `!explore` — frontier exploration (legit/hazard-aware movement)
* [x] `!follow` — `!followPlayer`
* [x] `!stop`
* [x] `!debug` — dumps structured state/metrics overview

### Reliability

* [x] Graceful reconnect — live-tested reconnect feature
* [x] Server restart handling — reconnect
* [x] Chunk-load failure handling — chunk tracking + `waitChunksReady` gate before pathing into unloaded terrain (`library/chunks.js`)
* [x] Pathfinding failure handling — destructive fallback + error reports
* [~] Entity disappearance handling — GoalFollow guards vanished entities
* [ ] Inventory desync detection
* [x] World-state mismatch detection — construction_damage
* [x] Build mismatch detection
* [x] Network interruption recovery
* [x] LLM failure fallback — cross-provider fallback chain (`models/model_fallback.js`)
* [x] Tool timeout handling — action timeouts
* [x] Action timeout handling — code_timeout_mins
* [x] Persistent crash recovery — `crash_guard.js` heartbeat, streak detection, clean-shutdown marking
* [x] Safe shutdown — cleanKill
* [x] Resume-after-crash — crash detection on boot with resume nudge into agent history

### Long-term autonomy

* [x] Autonomous exploration — `!explore` + the autonomy loop frontier-explores when idle long enough
* [~] Autonomous resource gathering — npc item goals; not self-initiated
* [x] Autonomous crafting — npc item_goal chains
* [x] Autonomous building — npc build_goal
* [x] Autonomous farming — `autonomy/farming.js`: harvest mature wheat/carrots/potatoes/beetroots, plant seeds on farmland, and expand the farm at base scale (till soil near water when seeds outnumber farmland)
* [x] Autonomous storage management — `autonomy/unload.js`: keeps tools/armor/food/working items, deposits bulk resources to the nearest chest via `putInChest`
* [x] Autonomous base maintenance — `maintain_base` need/executor in the autonomy loop (lighting/repairs pass)
* [x] Autonomous recovery
* [x] Autonomous task selection — self-prompter + npc goals + needs-driven autonomy loop
* [x] Autonomous task loop — `src/agent/autonomy/`: idle needs scoring (tool replacement, exploration, inventory unload, reserve restock, farming) with risk-aware gating, personality-paced cooldown, bounded history, `!autonomyStatus` / `!setAutonomy` / `!setRisk`
* [x] Long-running goals — npc projects
* [~] Multiple simultaneous objectives — modes concurrent; one action at a time
* [x] Background maintenance tasks — autonomy loop replaces worn tools and explores while idle; modes handle survival
* [x] Self-maintained resource reserves — autonomy loop crafts torches (`min_torches`) and bread (`min_food`) when materials allow
* [x] Self-maintained equipment — autonomy loop auto-replaces broken/nearly-dead tools
* [x] Self-maintained food supply — crafts bread from wheat and farms crops to replenish it
* [x] Self-maintained base — proactive `maintain_base` need lights dark spots around home (`autonomy/base.js`); construction_damage repair also exists

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
exists via npc goals + self-prompter, the deliberate humanlike behavior layer
has shipped in `src/agent/humanlike/` (seeded personality, behavior state
machine, LOS-gated attention, interaction focus/timing, context-dependent
idle), navigation intelligence has landed in `src/agent/navigation/`
(hazard-aware `safe` profile, route caching with world-verified replay, and
frontier exploration), and tool durability awareness + replacement planning
is wired through mining in `src/agent/library/durability.js`, and the
autonomous task loop now runs in `src/agent/autonomy/` (idle needs scoring,
auto tool replacement, frontier exploration, inventory unload, torch/food
reserve restock, crop farming, risk-aware gating, bounded history), social
memory + reactions live in
`src/agent/social/` (persistent player ledger, approach/departure greetings,
trust commands), social/risk presets + `!setRisk` posture control are in
`src/agent/humanlike/personality.js`, and the humanlike-behavior benchmark
guards all of it deterministically in `tests/humanlike_benchmark.test.js`,
autonomous farming + named storage routing landed in batch 9
(`autonomy/farming.js`, `storage/placement.js`, `autonomy/risk.js`), and a
multi-day survival benchmark now guards the decision layer
(`tests/survival_benchmark.test.js`), storage is load-balanced and
reservation-aware (`storage/balancing.js`, `!reserveStorage`), exploration
steers around hazard avoid-zones (`navigation/route_choice.js`), deaths
are tracked persistently (`library/metrics.js`, `!metrics`), the bot keeps a
durable mental map of POIs (`memory/mental_map.js`, `!notePlace`/`!pois`),
`!fetchItem` retrieves stored items by routing to their indexed containers,
and a deterministic navigation benchmark guards the movement layer, chests
get tidied, stack-consolidated, and fully slot-sorted
(`storage/tidying.js` + `storage/sorting.js`, `!organizeChest`/`!sortChest`),
respawn points and bed anchors are tracked (`!findBed`, metrics respawns),
spatial memory is searchable (`memory/recall.js`, `!recall`), the bot sleeps
in its bed at night when it is safe to do so (autonomous `rest` need) and
keeps its home lit (`maintain_base` need), patrols named circuits between
known places (`autonomy/patrol.js`, `!patrol`), returns home after wandering
errands — to whichever base is nearest, since named outposts
(`!setOutpost`) now live alongside home (`navigation/home.js`) — and
remembers which routes failed so it does not retry them
(`navigation/route_cache.js` failure ledger). The farm feeds the bot at base
scale: harvest, replant, and till new plots near water when farmland runs
out. Real-LLM scenario runs flow through the same benchmark pipeline with
call/retry/timeout/cost limits (`scripts/benchmark_llm.js`), and exploration
and recovery each have their own campaign-level benchmark suites. Spatial
recall accepts an optional embedding provider (`agent._embedding_provider`)
to blend vector similarity into keyword search. The base now raises animals
too (`autonomy/husbandry.js`, `!breedAnimals`), hazard-aware navigation picks
deliberately between viable routes with a seeded touch of variety
(`navigation/route_choice.js`), and loud sounds startle the bot into looking
(`humanlike/startle.js`). Caves and portals enter the world knowledge:
dark openings are detected and remembered (`navigation/caves.js`, `!caves`),
observed nether portals become per-dimension POIs with arrival anchors
(`navigation/portals.js`, `!portals`), and the 1:8 shortcut is planned
step-by-step (`!portalPlan`). Multiple bots coordinate through a shared base
registry (`navigation/shared_bases.js`, `!sharedBases`). Cave mouths are
safety-checked and entered with a torch (`!enterCave`), the nether shortcut
is not just planned but executed leg by leg (`!travelViaNether`), and combat
is polished defensively: per-mob threat scoring, weapon + shield readiness,
and an explicit emergency-escape flow (`autonomy/combat.js`, `!escape`).
Danger is no longer invisible to the planner either: threat-scored monsters,
hazard blocks, risk level, and underground/darkness ride along in the LLM's
full state every turn (`sensors/danger.js`, `!threats`), and caving uses a
dedicated baritone `cave` posture instead of bespoke pathfinding. The
comprehensive sweep then closed out the remaining frontier: a full combat
state machine with reactive escape and safe-zone seeking
(`autonomy/combat.js`, `navigation/safe_zones.js`, `!safeSpots`/`!dangerSpots`),
persistent danger maps in the world model, scheduled tasks
(`autonomy.scheduled[]`), global pause/resume/cancel with reason, escort and
wander behaviors, resource reservations, terrain preparation (`!clearArea`),
crash detection and recovery (`library/crash_guard.js`), a cross-provider LLM
fallback chain (`models/model_fallback.js`), structured event logs with
category toggles (`library/structlog.js`), graduated verbosity, per-player
trust, risky-action confirmation, chunk-readiness gating
(`library/chunks.js`), inventory desync verification, mining lava probes and
entrance management, crafting verification, exploration-profile wander legs,
and path/replan/movement/waste metrics. A 30-simulated-day agent stability
suite (`tests/longrun_agent.test.js`) plus dedicated sweep suites guard the
perception, humanlike, and systems layers. Remaining frontier: low-level
pathfinding internals (sprint/jump/swim decisions belong to baritone or
mineflayer-pathfinder, configured via profiles, never reimplemented),
cave/nether 3D route planning, build rollback and temporary-block lifecycle,
mining interruption resume, entity-vanish handling, and reactions to player
builds.
