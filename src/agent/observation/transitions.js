/**
 * transitions.js — deterministic verification of expected STATE TRANSITIONS.
 *
 * A plan step may declare exactly how the world should change while it runs:
 *
 *   "expected_delta": { "inventory.hopper": 1, "inventory.iron_ingot": -5 }
 *
 * Positive numbers mean "gains at least N" (side gains are fine); negative
 * numbers mean "consumes exactly |N|" by default (crafting recipes are exact),
 * with an optional per-path tolerance:
 *
 *   "inventory.iron_ingot": { "delta": -5, "tolerance": 1 }
 *
 * This catches the failure that hurts most: the LLM reports success but the
 * Minecraft state did not actually transition (craft silently failed, block
 * was never placed, item never picked up). The observer captures before/after
 * and the transition spec turns "the command didn't throw" into "the claimed
 * world change happened".
 *
 * Pure and minecraft-free: it only compares capture objects produced by
 * planning/observer.js.
 */

const KNOWN_SCALARS = new Set(['health', 'food']);

/**
 * Normalize model JSON into ordered, validated entries.
 * Accepts the map form (numbers or {delta,tolerance,mode}) and returns
 * { entries, problems }. Unknown paths are kept but flagged undecidable by the
 * checker rather than throwing, so a model typo can never crash the loop.
 */
export function normalizeDelta(raw) {
    const problems = [];
    const entries = [];
    if (raw == null) return { entries, problems };
    if (Array.isArray(raw)) {
        for (const item of raw) {
            if (item && typeof item === 'object' && item.path) {
                pushEntry(entries, problems, item.path, item);
            }
        }
        return { entries, problems };
    }
    if (typeof raw !== 'object') {
        return { entries, problems: ['expected_delta must be an object of path -> delta'] };
    }
    for (const [path, spec] of Object.entries(raw)) {
        pushEntry(entries, problems, path, typeof spec === 'object' && spec !== null ? spec : { delta: spec });
    }
    return { entries, problems };
}

function pushEntry(entries, problems, path, spec) {
    const delta = Number(spec.delta);
    if (!Number.isFinite(delta)) {
        problems.push(`expected_delta["${path}"] has no numeric delta`);
        return;
    }
    const known = KNOWN_SCALARS.has(path) || path.startsWith('inventory.');
    if (!known) problems.push(`expected_delta path "${path}" is not verifiable (ignored)`);
    const mode = spec.mode || (delta >= 0 ? 'atLeast' : 'exact');
    entries.push({
        path: String(path),
        delta,
        mode,
        tolerance: Number.isFinite(Number(spec.tolerance)) ? Number(spec.tolerance) : 0,
        verifiable: known,
    });
}

/** Read a dotted capture path: inventory.<item>, health, food. */
export function readPath(capture, path) {
    if (!capture) return undefined;
    if (KNOWN_SCALARS.has(path)) return Number(capture[path]);
    if (path.startsWith('inventory.')) {
        const item = path.slice('inventory.'.length);
        return Number(capture.inventory?.[item] || 0);
    }
    return undefined;
}

/**
 * Check a normalized delta spec against before/after captures.
 * Returns { decidable, satisfied, results, evidence }.
 *  - no entries / no captures -> decidable:false (caller falls back)
 *  - any verifiable entry wrong -> satisfied:false with per-path evidence
 */
export function checkTransition(specOrEntries, before, after) {
    const entries = Array.isArray(specOrEntries) ? specOrEntries : (specOrEntries?.entries || []);
    if (entries.length === 0) return { decidable: false, satisfied: false, results: [], evidence: null };
    if (!after) {
        return { decidable: true, satisfied: false, results: [], evidence: 'no post-action state (bot disconnected?)' };
    }

    const results = [];
    let sawVerifiable = false;
    for (const entry of entries) {
        if (!entry.verifiable) {
            results.push({ path: entry.path, ok: null, detail: 'path not verifiable' });
            continue;
        }
        sawVerifiable = true;
        const afterVal = readPath(after, entry.path);
        const beforeVal = readPath(before, entry.path);
        if (!Number.isFinite(afterVal) || (before == null && entry.delta !== 0)) {
            results.push({ path: entry.path, ok: null, actual: null, expected: entry.delta, detail: 'value unavailable' });
            continue;
        }
        const actual = afterVal - (Number.isFinite(beforeVal) ? beforeVal : 0);
        let ok;
        let detail;
        if (entry.mode === 'atLeast') {
            ok = actual >= entry.delta;
            detail = `changed ${signed(actual)}, expected at least ${signed(entry.delta)}`;
        } else if (entry.mode === 'atMost') {
            ok = actual <= entry.delta;
            detail = `changed ${signed(actual)}, expected at most ${signed(entry.delta)}`;
        } else {
            ok = Math.abs(actual - entry.delta) <= entry.tolerance;
            detail = `changed ${signed(actual)}, expected ${signed(entry.delta)}` +
                (entry.tolerance ? ` (±${entry.tolerance})` : '');
        }
        results.push({ path: entry.path, ok, actual, expected: entry.delta, detail });
    }

    if (!sawVerifiable) return { decidable: false, satisfied: false, results, evidence: null };
    const failures = results.filter((r) => r.ok === false);
    const satisfied = failures.length === 0;
    const evidence = results
        .filter((r) => r.ok !== null)
        .map((r) => `${r.path}: ${r.detail} ${r.ok ? 'OK' : 'MISMATCH'}`)
        .join('; ');
    return { decidable: true, satisfied, results, evidence };
}

function signed(n) {
    return n > 0 ? `+${n}` : `${n}`;
}

/** Human/model-facing description of the required transition for step prompts. */
export function describeDelta(specOrEntries) {
    const entries = Array.isArray(specOrEntries) ? specOrEntries : (specOrEntries?.entries || []);
    if (!entries.length) return null;
    const parts = entries.filter((e) => e.verifiable).map((e) => {
        const label = e.path.startsWith('inventory.') ? e.path.slice('inventory.'.length) : e.path;
        if (e.mode === 'atLeast') return `${label} ${signed(e.delta)} or more`;
        if (e.mode === 'atMost') return `${label} ${signed(e.delta)} or less`;
        return `${label} ${signed(e.delta)}${e.tolerance ? ` ±${e.tolerance}` : ''}`;
    });
    return parts.length ? `required state change: ${parts.join(', ')}` : null;
}

/** Canonical JSON form for persistence: map path -> number (or spec object). */
export function deltaToJSON(entries) {
    const out = {};
    for (const e of entries || []) {
        if (e.mode !== 'atLeast' && e.delta >= 0) {
            out[e.path] = { delta: e.delta, mode: e.mode, tolerance: e.tolerance };
        } else if (e.tolerance || (e.mode !== 'exact' && e.delta < 0)) {
            out[e.path] = { delta: e.delta, mode: e.mode, tolerance: e.tolerance };
        } else {
            out[e.path] = e.delta;
        }
    }
    return out;
}
