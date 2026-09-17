/**
 * mine_state.js — mining interruption recovery (GO list).
 *
 * When a mining run is interrupted (user !stop, inventory full, night...),
 * what was being mined and how much is left gets persisted per bot, so the
 * next run can resume where it left off instead of starting blind.
 */

import fs from 'fs';
import path from 'path';

function filePath(botName, dir = 'bots') {
    return path.join(dir, String(botName ?? 'bot'), 'mine_state.json');
}

/** Persist the interrupted mining run. Never throws. */
export function recordMineInterrupt(botName, { types = null, remaining = 0, entrance = null, reason = 'interrupted' } = {}, dir = 'bots') {
    try {
        const fp = filePath(botName, dir);
        fs.mkdirSync(path.dirname(fp), { recursive: true });
        fs.writeFileSync(fp, JSON.stringify({
            types: Array.isArray(types) ? types.map(String).slice(0, 8) : null,
            remaining: Math.max(0, Math.round(Number(remaining) || 0)),
            entrance: entrance && typeof entrance.x === 'number'
                ? { x: Math.round(entrance.x), y: Math.round(entrance.y), z: Math.round(entrance.z) }
                : null,
            reason: String(reason).slice(0, 48),
            t: Date.now()
        }, null, 2));
        return true;
    } catch { return false; }
}

/** Load the last interrupted run (null when none/expired). @param {number} [maxAgeMs] */
export function loadMineInterrupt(botName, { dir = 'bots', maxAgeMs = 6 * 3600 * 1000 } = {}) {
    try {
        const data = JSON.parse(fs.readFileSync(filePath(botName, dir), 'utf8'));
        if (!data || typeof data !== 'object') return null;
        if (Date.now() - (data.t ?? 0) > maxAgeMs) return null;
        return data;
    } catch { return null; }
}

/** Clear the recorded interrupt (run completed or superseded). Never throws. */
export function clearMineInterrupt(botName, dir = 'bots') {
    try { fs.rmSync(filePath(botName, dir), { force: true }); return true; } catch { return false; }
}

/** Human-readable one-liner for !mineStatus. */
export function mineStatusLine(botName, dir = 'bots') {
    const s = loadMineInterrupt(botName, { dir });
    if (!s) return 'No interrupted mining run on record.';
    const what = Array.isArray(s.types) && s.types.length ? s.types.join('/') : 'blocks';
    const where = s.entrance ? ` (entrance ${s.entrance.x}, ${s.entrance.y}, ${s.entrance.z})` : '';
    const mins = Math.max(0, Math.round((Date.now() - (s.t ?? Date.now())) / 60000));
    return `Interrupted run: ${what}, ${s.remaining} left${where} — ${s.reason}, ${mins} min ago. Re-run the same !mineBlocks to resume.`;
}
