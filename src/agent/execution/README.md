# Execution layer

The execution layer is the boundary between high-level planning and Mineflayer.
A planner submits one named skill to `ExecutionController`; it should not own
pathfinder goals or issue a long sequence of low-level controls.

- `EventBus` normalizes Mineflayer/world/runtime events.
- `InterruptManager` classifies events as low, medium, high, or critical.
- `SkillRegistry` stores deterministic skill contracts.
- `ExecutionController` owns one active skill, cancellation, progress,
  interruption, completion/failure events, and state snapshots.
- `FileExecutionStateStore` keeps the active snapshot under the bot directory
  so a crash can be detected and a future runner can resume it.
- `builtin_skills.js` adapts existing navigation, mining, crafting, combat,
  exploration, and schematic helpers without moving their low-level logic into
  the planner.

The controller is deliberately usable without a live bot, which makes skill
contracts and interruption behavior testable with ordinary Node tests.
