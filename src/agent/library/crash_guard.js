/**
 * crash_guard.js — crash detection + restart backoff.
 * (GO list: persistent crash recovery, resume-after-crash.)
 *
 * The agent touches a heartbeat file while alive. On startup we check
 * whether the previous session died without a clean shutdown: if the last
 * heartbeat is recent-ish and no clean-shutdown marker exists, the previous
 * run crashed. A streak counter escalates an autonomy backoff so a
 * crash-looping bot stops hammering the server, and the LLM is told it just
 * recovered from a crash so it can resume deliberately.
 */

import fs from 'fs';
import path from 'path';

function guardPath(botName, dir = 'bots') {
    return path.join(dir, botName, 'crash_guard.json');
}

function readState(botName, dir) {
    try {
        return JSON.parse(fs.readFileSync(guardPath(botName, dir), 'utf8'));
    } catch {
        return null;
    }
}

function writeState(botName, dir, state) {
    try {
        const fp = guardPath(botName, dir);
        fs.mkdirSync(path.dirname(fp), { recursive: true });
        const tmp = `${fp}.${process.pid}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
        fs.renameSync(tmp, fp);
        return true;
    } catch {
        return false;
    }
}

/**
 * Detect whether the previous session crashed. Call once at startup.
 * @param {object} opts { botName, dir, staleAfterMs, now }
 * @returns {{crashed, streak, lastBeat, backoffMs}}
 */
export function detectPreviousCrash(botName, { dir = 'bots', staleAfterMs = 120_000, now = () => Date.now() } = {}) {
    const t = now();
    const prev = readState(botName, dir);
    if (!prev) {
        writeState(botName, dir, { streak: 0, lastBeat: t, clean: false });
        return { crashed: false, streak: 0, lastBeat: null, backoffMs: 0 };
    }
    if (prev.clean) {
        // last session shut down cleanly: reset the streak
        writeState(botName, dir, { streak: 0, lastBeat: t, clean: false });
        return { crashed: false, streak: 0, lastBeat: prev.lastBeat ?? null, backoffMs: 0 };
    }
    const age = t - (prev.lastBeat ?? 0);
    if (age > staleAfterMs || !(prev.lastBeat > 0)) {
        // stale or never heartbeated: treat as a crash
        const streak = Math.min(8, (prev.streak ?? 0) + 1);
        writeState(botName, dir, { streak, lastBeat: t, clean: false });
        return { crashed: true, streak, lastBeat: prev.lastBeat ?? null, backoffMs: autonomyBackoffMs(streak) };
    }
    // heartbeat is fresh but no clean shutdown — process was killed; count it
    const streak = Math.min(8, (prev.streak ?? 0) + 1);
    writeState(botName, dir, { streak, lastBeat: t, clean: false });
    return { crashed: true, streak, lastBeat: prev.lastBeat ?? null, backoffMs: autonomyBackoffMs(streak) };
}

/** Escalating backoff: 30s, 60s, 120s ... capped at 5 minutes. */
export function autonomyBackoffMs(streak) {
    if (streak <= 0) return 0;
    return Math.min(5 * 60_000, 30_000 * 2 ** (Math.max(1, streak) - 1));
}

/** Touch the heartbeat. Cheap; call throttled (e.g. every few seconds). */
export function touchHeartbeat(botName, { dir = 'bots', now = () => Date.now() } = {}) {
    const prev = readState(botName, dir) ?? { streak: 0 };
    return writeState(botName, dir, { ...prev, lastBeat: now(), clean: false });
}

/** Mark a clean shutdown (call from cleanKill / graceful exit). */
export function markCleanShutdown(botName, { dir = 'bots', now = () => Date.now() } = {}) {
    const prev = readState(botName, dir) ?? { streak: 0 };
    return writeState(botName, dir, { ...prev, streak: 0, lastBeat: now(), clean: true });
}

/** Readable status for !debug. */
export function crashGuardStatus(botName, { dir = 'bots' } = {}) {
    const state = readState(botName, dir);
    if (!state) return 'crash-guard: no state yet';
    const ago = Math.round((Date.now() - (state.lastBeat ?? 0)) / 1000);
    return `crash-guard: streak ${state.streak ?? 0}, last heartbeat ${ago}s ago, clean shutdown ${state.clean ? 'yes' : 'no'}`;
}
