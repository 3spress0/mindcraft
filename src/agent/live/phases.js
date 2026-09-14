/**
 * phases.js — the controlled live-test task sequence.
 *
 * Deliberately NOT "let the bot roam": each phase has one objective, one
 * deterministic verification, and one conservative timeout. The phases are
 * ordered so that cheap protocol questions are answered before expensive
 * behaviour questions, and so the failure of an early phase stops the run
 * rather than producing a misleading cascade of later failures.
 *
 * Every phase records `blindspot` — the specific thing FakeBot cannot validate
 * and which is therefore the *reason* the phase exists in a live run.
 */

export const FEATURES = {
    DIRECT: 'direct',        // mineflayer/pathfinder/inventory only, zero LLM calls
    PIPELINE: 'pipeline',     // planner -> executor -> observer -> critic
    RECOVERY: 'recovery',     // injected interruption + recovery decision
    RECONNECT: 'reconnect',   // real disconnect/reconnect + persistence
};

export const ALL_FEATURES = Object.values(FEATURES);

/** Base timeouts, in ms. Intentionally generous; scale down only once green. */
const T = {
    CONNECT: 45_000,
    OBSERVE: 30_000,
    REPORT: 10_000,
    GATHER: 180_000,
    CRAFT: 120_000,
    BUILD: 180_000,
    RECOVERY: 240_000,
    PERSIST: 150_000,
};

export const PHASES = [
    {
        id: 'connect',
        title: 'Connect and authenticate',
        action: 'connect',
        requires: [FEATURES.DIRECT],
        timeoutMs: T.CONNECT,
        mutating: false,
        stopsRun: true, // nothing downstream is meaningful if we cannot even log in
        objective: 'Complete the handshake, log in, and receive a spawn position.',
        blindspot: 'mineflayer protocol handshake, auth mode, version match, server whitelist/queue, keep-alive timing',
        verify: { kind: 'connected', minLatencyRecorded: true },
    },
    {
        id: 'observe',
        title: 'Observe the nearby world',
        action: 'observe',
        requires: [FEATURES.DIRECT],
        timeoutMs: T.OBSERVE,
        mutating: false,
        objective: 'Load chunks around the spawn point and read real block/entity state.',
        blindspot: 'chunk streaming, bot.blockAt correctness, entity tracking, world.getNearby* scans',
        verify: { kind: 'observation', minChunks: 4, minNearbyBlockTypes: 3 },
    },
    {
        id: 'report',
        title: 'Report position, health, inventory, entities',
        action: 'report',
        requires: [FEATURES.DIRECT],
        timeoutMs: T.REPORT,
        mutating: false,
        objective: 'Produce the same telemetry the planner/observer consumes in production.',
        blindspot: 'inventory slot decoding, health/food freshness, dimension naming, observer captureState against a live bot',
        verify: { kind: 'telemetry', required: ['position', 'health', 'food', 'inventory', 'nearbyEntities'] },
    },
    {
        id: 'gather',
        title: 'Gather a simple resource',
        action: 'gather',
        requires: [FEATURES.DIRECT],
        timeoutMs: T.GATHER,
        mutating: true,
        objective: 'Walk to a resource block, mine it with a valid tool, pick the drop up.',
        blindspot: 'pathfinding on real terrain, reach/facing, dig speed, drop pickup, server-side block updates',
        verify: { kind: 'inventory_gain', itemFrom: 'gather.item', gainedFrom: 'gather.count' },
        defaults: { item: 'oak_log', count: 1, blockType: 'oak_log' },
    },
    {
        id: 'craft',
        title: 'Craft an item',
        action: 'craft',
        requires: [FEATURES.DIRECT],
        timeoutMs: T.CRAFT,
        mutating: true,
        objective: 'Craft the configured target from gathered materials using the real recipe table.',
        blindspot: 'recipe resolution for the live server version, 2x2 vs 3x3 grid, crafting-table placement/use, inventory transaction atomicity',
        verify: { kind: 'inventory_have', itemFrom: 'craft.item', atLeastFrom: 'craft.count' },
        defaults: { item: 'crafting_table', count: 1 },
    },
    {
        id: 'build',
        title: 'Build a small structure',
        action: 'build',
        requires: [FEATURES.DIRECT],
        timeoutMs: T.BUILD,
        mutating: true,
        objective: 'Place a small known set of blocks at absolute coordinates.',
        blindspot: 'placement face/adjacency rules, physics collisions, block-state updates, pathfinder re-routing around own build',
        verify: { kind: 'blocks_placed', minBlocks: 4 },
        defaults: { block: 'oak_planks', size: 2 },
    },
    {
        id: 'recovery',
        title: 'Recover from an intentionally interrupted task',
        action: 'interrupt',
        requires: [FEATURES.RECOVERY],
        timeoutMs: T.RECOVERY,
        mutating: true,
        objective: 'Interrupt an in-flight step mid-way, then show the pipeline classifies and resumes it instead of reporting a false success.',
        blindspot: 'real in-flight cancellation (pathfinder.stop / collectBlock cancel), state after partial execution, critic refusing to bless a half-done step',
        verify: { kind: 'recovery', mustNotCrash: true, requireAnyOf: ['retried', 'replanned', 'resumed'], finalGoal: { itemFrom: 'gather.item', gainedFrom: 'recovery.count' } },
        defaults: { count: 2 },
    },
    {
        id: 'persist',
        title: 'Verify resulting world state (and reconnect persistence)',
        action: 'verify_world_state',
        requires: [FEATURES.DIRECT],
        timeoutMs: T.PERSIST,
        mutating: false,
        objective: 'Re-read the world after everything above and confirm the collected/crafted/built results are actually true server-side; with --features reconnect, do it across a real disconnect.',
        blindspot: 'server-authoritative state vs client cache, reconnect latency, persistence of project/world-model files across a process-level disconnect',
        verify: { kind: 'world_state', minBlocks: 4 },
        defaults: {},
    },
];

export function phaseById(id) {
    return PHASES.find((p) => p.id === id) || null;
}

/**
 * Resolve which phases run, in order, with what timeouts.
 *
 * @param {{features?:string[], task?:object, timeoutScale?:number,
 *          only?:string[], deadlineMs?:number}} opts
 * @returns {{phases:object[], features:string[], budgetMs:number,
 *            task:object, warnings:string[], problems:string[]}}
 */
export function resolvePlan(opts = {}) {
    const warnings = [];
    const problems = [];
    let features = opts.features
        ? (Array.isArray(opts.features) ? opts.features : String(opts.features).split(/[,\s]+/).filter(Boolean))
        : [FEATURES.DIRECT];
    features = [...new Set(features.map((f) => String(f).trim().toLowerCase()).filter(Boolean))];

    for (const f of features) {
        if (!ALL_FEATURES.includes(f)) problems.push(`unknown feature "${f}" (known: ${ALL_FEATURES.join(', ')})`);
    }
    // `direct` is the floor: every other feature is an increment on top of it.
    if (!features.includes(FEATURES.DIRECT)) {
        features.unshift(FEATURES.DIRECT);
        warnings.push('enabled the mandatory "direct" feature');
    }
    // A reconnect check without the persistence phase would be inert.
    if (features.includes(FEATURES.RECONNECT) && !features.includes(FEATURES.DIRECT)) {
        warnings.push('reconnect implies the final verification phase');
    }

    const scale = Number(opts.timeoutScale ?? 1);
    if (!Number.isFinite(scale) || scale <= 0) problems.push('--timeout-scale must be a positive number');
    if (scale < 1) warnings.push(`--timeout-scale ${scale} shortens live timeouts; only do this on a known-good local server`);

    const baseTask = {
        gather: { ...PHASES.find((p) => p.id === 'gather').defaults, ...(opts.task?.gather || {}) },
        craft: { ...PHASES.find((p) => p.id === 'craft').defaults, ...(opts.task?.craft || {}) },
        build: { ...PHASES.find((p) => p.id === 'build').defaults, ...(opts.task?.build || {}) },
        recovery: { ...PHASES.find((p) => p.id === 'recovery').defaults, ...(opts.task?.recovery || {}) },
    };
    // mining an item-named target (e.g. "oak_log") needs a block name; keep them
    // in sync here so both drivers get the same, already-resolved task object.
    baseTask.gather.blockType = opts.task?.gather?.blockType ?? baseTask.gather.item;
    // build(size) -> concrete block list, anchored later at the bot's position
    const n = Math.max(1, Math.floor(Number(baseTask.build.size) || 2));
    baseTask.build.plan = [];
    for (let i = 0; i < n * n; i++) baseTask.build.plan.push({ dx: i % n, dz: Math.floor(i / n), dy: 0 });
    if (n * n < 4) warnings.push(`build plan is only ${n * n} blocks; the phase needs >= 4 placed blocks to verify — raise --build-size`);

    let phases = PHASES.filter((p) => p.requires.every((req) => features.includes(req)));
    if (opts.only && opts.only.length) {
        const only = new Set(opts.only);
        phases = phases.filter((p) => only.has(p.id));
        if (!phases.length) problems.push('--only selected no runnable phases');
    }

    const scaleOr = (ms) => Math.max(1000, Math.round(ms * (Number.isFinite(scale) && scale > 0 ? scale : 1)));
    phases = phases.map((p) => ({
        ...p,
        timeoutMs: scaleOr(p.timeoutMs),
        features: p.requires.filter((r) => r !== FEATURES.DIRECT),
    }));

    const budgetMs = phases.reduce((acc, p) => acc + p.timeoutMs, 0);
    let deadlineMs = opts.deadlineMs == null ? null : Number(opts.deadlineMs);
    if (deadlineMs != null && (!Number.isFinite(deadlineMs) || deadlineMs <= 0)) problems.push('--deadline must be a positive number of ms');
    if (deadlineMs != null && deadlineMs < budgetMs) {
        warnings.push(`global deadline ${deadlineMs}ms is below the phase budget ${budgetMs}ms; late phases will be cut off`);
    }

    if (!features.includes(FEATURES.PIPELINE)) warnings.push('pipeline feature OFF: the LLM planner/executor/critic are not exercised, this run tests the protocol layer only');
    if (!features.includes(FEATURES.RECOVERY)) warnings.push('recovery feature OFF: the interruption phase (step 7) is skipped');

    return { phases, features, budgetMs, task: baseTask, warnings, problems, deadlineMs, timeoutScale: scale };
}

/** Resolve a `xxxFrom` reference in a verify spec against the plan's task config. */
export function bindVerifySpec(spec, task) {
    const out = { ...spec };
    // The final world-state phase re-checks everything earlier phases claimed:
    // the crafted item must still be held, and the gathered resource must be
    // either still held or materialised in the world (a gap = voiding/dupe).
    if (out.kind === 'world_state' && !out.expectItems) {
        const items = {};
        if (task?.craft?.item) items[task.craft.item] = Number(task.craft.count) || 1;
        out.expectItems = items;
        if (task?.gather?.item) out.gatherAccounting = { item: task.gather.item, min: Number(task.gather.count) || 1 };
    }
    for (const [key, value] of Object.entries(spec)) {
        if (!key.endsWith('From')) continue;
        const target = key.slice(0, -'From'.length);
        const [group, field] = String(value).split('.');
        out[target] = task?.[group]?.[field] ?? null;
        delete out[key];
    }
    if (out.gainedFrom) delete out.gainedFrom;
    if (out.itemFrom) delete out.itemFrom;
    if (out.atLeastFrom) delete out.atLeastFrom;
    if (out.finalGoal) out.finalGoal = bindVerifySpec(out.finalGoal, task);
    return out;
}
