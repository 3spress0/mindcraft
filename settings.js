const settings = {
    "minecraft_version": "auto", // or specific version like "1.21.6"
    "host": "127.0.0.1", // or "localhost", "your.ip.address.here"
    "port": 55916, // set to -1 to automatically scan for open ports
    "auth": "offline", // or "microsoft"

    // the mindserver manages all agents and hosts the UI
    "mindserver_port": 8080,
    "auto_open_ui": true, // opens UI in browser on startup

    "base_profile": "assistant", // survival, assistant, creative, or god_mode
    "load_memory": true, // load memory from previous session

    "init_message": "Respond with hello world and your name", // sends to all on spawn
    "only_chat_with": [], // users that the bots listen to and send general messages to. if empty it will chat publicly

    "speak": false,
    // allows all bots to speak through text-to-speech.
    // specify speech model inside each profile with format: {provider}/{model}/{voice}.
    // if set to "system" it will use basic system text-to-speech.
    // Works on windows and mac, but linux requires you to install the espeak package through your package manager eg: `apt install espeak` `pacman -S espeak`.

    "chat_ingame": true, // bot responses are shown in minecraft chat
    "render_bot_view": false, // show bot's view in browser at localhost:3000, 3001...

    "allow_insecure_coding": false, // allows newAction command and model can write/run code on your computer. enable at own risk
    "allow_agent_coding_tools": false, // allows !read/!write/!edit/!multiEdit/!grep/!glob/!ls/!execute/!lint/!todoWrite/!finishCoding commands. !execute runs code, same risk class as allow_insecure_coding
    "allow_vision": true, // allows vision model to interpret screenshots as inputs
    "blocked_actions" : ["!checkBlueprint", "!checkBlueprintLevel", "!getBlueprint", "!getBlueprintLevel"] , // commands to disable and remove from docs. Ex: ["!setMode"]
    "code_timeout_mins": -1, // minutes code is allowed to run. -1 for no timeout
    "relevant_docs_count": 5, // number of relevant code function docs to select for prompting. -1 for all

    // Workspace roots the coding-agent tools (Read/Write/Edit/MultiEdit/Grep/Glob/LS/Execute/Lint) are
    // strictly sandboxed to. {BOT_NAME} is substituted with the active bot's name. Relative to project root.
    "code_workspaces": [
        "bots/{BOT_NAME}/action-code",
        "bots/{BOT_NAME}/learnedSkills",
        "bots/{BOT_NAME}/"
    ],

    "max_messages": 120, // message-count context window; compact considers messages after the latest compact boundary
    "compact_message_threshold_percent": 80, // compact the whole active context when it reaches this percent of max_messages
    "max_commands": -1, // max number of commands that can be used in consecutive responses. -1 for no limit
    "show_command_syntax": "full", // "full", "shortened", or "none"
    "narrate_behavior": true, // chat simple automatic actions ('Picking up item!')
    "chat_bot_messages": true, // publicly chat messages to other bots

    "spawn_timeout": 30, // num seconds allowed for the bot to spawn before throwing error. Increase when spawning takes a while.
    "block_place_delay": 0, // delay between placing blocks (ms) if using newAction. helps avoid bot being kicked by anti-cheat mechanisms on servers.

    // Folder (relative to project root) where the bot looks for build files:
    // Litematica .litematic, Sponge/WorldEdit .schem (Baritone's format too),
    // vanilla structure .nbt, and mindcraft blueprint .json. Browse with
    // !listBuilds, quote materials with !buildMaterials, build with !buildSchematic.
    "schematic_library": "schematics",

    // Planner -> executor -> observer -> critic -> replanner loop (!plan).
    // A long-horizon goal is turned into an ordered, verifiable step plan; each
    // step is executed via the normal ReAct/tool machinery, the world is
    // observed before/after, and deterministic + model critics decide whether
    // the step really succeeded and whether to retry, replan, or ask for help.
    "planning": {
        "planner_attempts": 2,     // model JSON retries before falling back to a single-step plan
        "max_step_attempts": 2,    // retries of the same step before the planner revises the plan
        "max_replans": 3,         // plan revisions before escalating to a human
        "max_executions": 60,     // safety cap on total step executions per project
        "executor_max_responses": 6, // ReAct turns per step (tool/command rounds)
        "step_cooldown_ms": 1500, // pause between steps
        "freeform_critic": true,  // use the model to judge non-deterministic expectations
        "autoresume": true,       // resume an unfinished project after restart
        // Recovery policy profile: default, explorer (search aggressively),
        // builder (route to known deposits, escalate material issues), or
        // survival (safety-first retreats). Profiles live in
        // src/agent/planning/policies.js and consume WorldModel facts
        // (depleted deposits, alternative sources, nearby threats, retreats).
        "recovery_profile": "default",
        "recovery_policies": null, // optional {profile: {failureClass: action}} overrides
        "danger_health_threshold": 6, // health <= this with threats nearby -> retreat/human
        "threat_radius": 16,       // world-model threats within this range count as danger
    },

    // Persistent world model (bots/<name>/world_model.json). The observer layer
    // records timestamped, confidence-rated facts (locations, mobs, resource
    // deposits, structures, threats, proven recipes) from live Minecraft events
    // and from verified plan steps. The planner reads them as "KNOWN WORLD
    // FACTS" so it stops rediscovering villages/resources and routes around
    // threats and depleted sources. Inspect with !world [category|query].
    "world_model": {
        "enabled": true,           // master switch for the event collector
        "persist": true,           // save facts to disk (survives restarts)
        "entity_radius": 48,       // only record entities within this many blocks
        "player_refresh_ms": 2000, // how often position/health/hunger are snapshotted
        "scan_interval_ms": 5000,  // full entity sweep + confidence decay interval
        "save_interval_ms": 15000, // throttle for automatic saves
        "threat_ttl_ms": 120000,   // unseen hostile mobs expire after 2 minutes
        "entity_ttl_ms": 600000,   // unseen passive mobs/npcs kept for 10 minutes
        "item_ttl_ms": 30000,      // dropped item facts expire after 30 seconds
        "confidence_floor": 0.15,  // volatile facts decaying below this are pruned
        "volatile_half_life_ms": 120000, // confidence halves every 2 minutes unseen
        "village_radius": 48,      // block grid size for merging villager sightings
        "summary_max_lines": 40,   // facts injected into planner prompts
    },

    // Navigation: hazard-aware movement, route caching, and frontier exploration.
    // See src/agent/navigation/.
    "navigation": {
        "route_cache": {
            "enabled": true,        // remember successful routes and replay them (verified against the world first)
            "ttl_minutes": 15,      // cached routes older than this are ignored
            "max_entries": 64       // bounded LRU-style prune
        },
        "exploration": {
            "default_legs": 3,      // outward trips per !explore when no count is given
            "max_ring": 12,         // frontier ring cap (ring * 16 blocks out)
            "profile": "legit"      // movement profile used while exploring
        }
    },

    // Humanlike locomotion layered on top of mineflayer-pathfinder (the mineflayer
    // equivalent of Baritone). Removes robotic movement tells: instant head snaps
    // with a perfectly level stare, nonstop sprinting, zero reaction time, and a
    // frozen stance while idle. Interaction timing (dig/place/equip/chest) is
    // humanized separately by src/agent/humanlike/interaction.js.
    "humanlike": {
        "enabled": true,          // master switch; can also be toggled at runtime via bot.humanizer.setEnabled()
        "smooth_gaze": true,      // ease/rate-limit head turns, add micro-jitter and natural vertical gaze wander
        "max_turn_rate_deg": 17,  // max yaw change per game tick (20 ticks/s) while traveling
        "gaze_turn_gain": 0.42,   // how quickly the head eases toward the travel heading (0..1)
        "gaze_jitter_deg": 0.7,   // random gaze noise per tick, in degrees
        "gaze_pitch_var": 0.13,   // radians of vertical gaze wander while walking
        "varied_pace": true,      // mix walking and sprinting instead of sprinting everywhere
        "sprint_ratio": 0.72,     // approx share of travel time spent sprinting (0..1)
        "reaction_delay_ms": 220, // max startup reaction delay, jittered between 0 and this
        "hesitations": true,      // brief 50-150ms "thinking" pauses mid-route (flat ground only)
        "hesitation_min_s": 6,    // min seconds between hesitation pauses
        "hesitation_max_s": 20,   // max seconds between hesitation pauses
        "idle_glances": true,     // occasionally look around while standing still
        "idle_min_s": 3,          // min seconds between idle glances
        "idle_max_s": 10,         // max seconds between idle glances
        "idle_arm_swing": false,  // occasionally swing the arm while idle (off by default)
        "external_look_hold_ms": 2500, // don't idle-glance for this long after a scripted look/lookAt

        // ---- deliberate behavior layer (seeded, bounded; see src/agent/humanlike/) ----
        "seed": null,             // optional fixed seed; defaults to a hash of the bot's name
        "personality": {
            "preset": "default",  // default | curious | cautious | energetic | laidback | social
            "overrides": {}       // exact trait values, e.g. { "curiosity": 0.9 }
        },
        "interaction": {
            "enabled": true,                 // humanize dig/place/equip/chest timing & focus
            "focus_before_action": true,     // glance at the block before digging/placing
            "focus_dwell_ms": [120, 450],    // pre-action glance hold
            "focus_offset": 0.18,            // bounded glance imprecision (blocks)
            "dig_pause_ms": [80, 280],
            "place_pause_ms": [60, 220],
            "equip_pause_ms": [50, 250],
            "window_pause_ms": [150, 450],
            "post_action_pause_ms": [60, 200]
        },
        "idle": {
            "enabled": true,
            "wander": true,         // short walks to a safe nearby spot when idle a while
            "inspect": true,        // occasionally "check the bag" (look-down pause)
            "min_idle_ms": 5000,    // settle before idling after an activity
            "wander_after_ms": 12000,
            "radius": 4
        }
    },

    // Autonomous task loop (src/agent/autonomy/). While the bot is idle it
    // periodically scores its needs and acts on the most urgent one through
    // the normal action manager, so everything stays interruptible.
    "autonomy": {
        "enabled": true,            // master switch; !setAutonomy toggles it at runtime
        "cooldown_s": [20, 60],     // personality-paced seconds between loop runs
        "action_timeout_s": 180,    // hard cap on a single autonomous action
        "history_limit": 16,        // bounded history kept for !autonomyStatus
        "needs": {
            "tool_replace_threshold": 0.15, // durability fraction that triggers replacement
            "explore_when_idle": true,      // frontier-explore when idle long enough
            "explore_idle_s": 60,           // seconds of idle before exploring
            "explore_legs": 2,              // outward legs per autonomous exploration
            "free_slot_alert": 2            // advisory when inventory has <= this many free slots
        }
    },


    "log_all_prompts": false, // log ALL prompts to file
    "show_chat_history": true, // stream and persist Runtime chat/tool events for the web UI
    "log_chat_trace": false, // write trace JSONL even when Runtime UI history is disabled

    "llm_providers": "settings_llm_providers.json", // project-level LLM keys/model/embedding registry
    "profiles": [
        // Default enabled agent. Using more than one profile requires you to /msg each bot individually.
        "andy.json",                  // Default Andy profile at the project root

        // Mainstream preset profiles. Uncomment one or more to launch them.
        // Protocol representative native-tool smoke profiles
        // "profiles/gpt.json",       // OpenAI Responses: openai:gpt-5.5
        // "profiles/codex.json",     // Codex ChatGPT login: codex:gpt-5.5
        // "profiles/openrouter.json",// OpenRouter / OpenAI Chat Completions: moonshotai/kimi-k2.6
        // "profiles/kimi.json",      // Kimi Anthropic-compatible: kimi-k2.6
        // "profiles/gemini.json",    // Gemini / google-generative-ai: gemini-2.5-flash

        // OpenAI / ChatGPT
        // "profiles/gpt.json",
        // "profiles/codex.json",         // Use a ChatGPT account login; Plus/Pro has higher limits, free accounts may have limited quota.
        // "profiles/azure.json",

        // Anthropic / Claude-compatible
        // "profiles/claude.json",
        // "profiles/claude_thinker.json",
        // "profiles/kimi.json",
        // "profiles/minimax-cn.json",
        // "profiles/minimax-intl.json",

        // Google / Gemini
        // "profiles/gemini.json",

        // OpenAI-compatible providers and model routers
        // "profiles/openrouter.json",
        // "profiles/deepseek.json",
        // "profiles/qwen-cn.json",
        // "profiles/siliconflow.json",
        // "profiles/mistral.json",
        // "profiles/grok.json",
        // "profiles/groq.json",
        // "profiles/cerebras.json",
        // "profiles/mercury.json",
        // "profiles/novita.json",
        // "profiles/ollama.json",

        // Replicate and local/custom runtimes
        // "profiles/replicate.json",
        // "profiles/llama.json",
        // "profiles/vllm.json",
        // "profiles/andy-4.2.json",      // Andy 4.2 via local LM Studio OpenAI-compatible server
        // "profiles/freeguy.json",
    ],
};

export default settings;