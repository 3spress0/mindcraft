/**
 * structlog.js — structured JSONL event logging + error categorization.
 * (GO list: structured logs, navigation/perception/planning/inventory/
 * building/world-model logs, error categorization.)
 *
 * Every subsystem can emit tiny, machine-readable events without changing
 * the chat/console flow: navigation route outcomes, world-model fact churn,
 * planning steps, inventory operations, build events, combat phases. Logs
 * are appended to bots/<name>/events.jsonl (size-bounded, self-trimming),
 * queryable with !debug log and readable by external tooling.
 *
 * Design guardrails:
 *   - never throws: a broken log must never break the agent,
 *   - lazy + cached per agent (getLogger / logEvent),
 *   - disabled entirely when settings.structured_logs.enabled === false.
 */

import fs from 'fs';
import path from 'path';
import settings from '../../../settings.js';

/** Known categories; unknown ones are still logged (free-form). */
export const LOG_CATEGORIES = [
    'navigation', 'perception', 'planning', 'inventory', 'building',
    'world_model', 'combat', 'autonomy', 'social', 'error', 'lifecycle'
];

/** Coarse error taxonomy used across logs and action error reporting. */
export function classifyError(e) {
    const msg = String(e?.message ?? e ?? '').toLowerCase();
    if (!msg) return 'unknown';
    if (/interrupt|cancel|abort|stopped/.test(msg)) return 'interrupt';
    if (/timeout|timed out|etimedout/.test(msg)) return 'timeout';
    if (/econnreset|econnrefused|socket|network|fetch failed|enotfound|eai_again/.test(msg)) return 'network';
    if (/rate.?limit|429|quota|overloaded|5\d\d /.test(msg)) return 'provider';
    if (/no (such|matching)|not found|missing|unknown item|no recipe|cannot find|invalid|must be|expected/.test(msg)) return 'resource';
    if (/not allowed|forbidden|blocked|denied|permission/.test(msg)) return 'validation';
    return 'unknown';
}

export class StructuredLogger {
    /**
     * @param {object} opts { botName, dir, enabled, categories (null=all),
     *                 maxSizeBytes, keepBytes, now }
     */
    constructor({
        botName = 'bot', dir = 'bots', enabled = true, categories = null,
        maxSizeBytes = 512 * 1024, keepBytes = 128 * 1024, now = () => Date.now()
    } = {}) {
        this.botName = botName;
        this.dir = dir;
        this.enabled = enabled;
        this.categories = Array.isArray(categories) && categories.length ? new Set(categories) : null;
        this.maxSizeBytes = maxSizeBytes;
        this.keepBytes = keepBytes;
        this._now = now;
        this._written = 0; // lines written this process lifetime
        this._lastSizeCheck = 0;
    }

    filePath() {
        return path.join(this.dir, this.botName, 'events.jsonl');
    }

    /**
     * Append one event. `data` is shallow-merged; keep payloads small.
     * Never throws.
     */
    log(category, event, data = {}) {
        if (!this.enabled) return false;
        if (this.categories && !this.categories.has(category)) return false;
        try {
            const line = JSON.stringify({ t: this._now(), category, event, ...data });
            fs.mkdirSync(path.dirname(this.filePath()), { recursive: true });
            fs.appendFileSync(this.filePath(), line + '\n');
            this._written++;
            this._maybeTrim();
            return true;
        } catch {
            return false;
        }
    }

    /** Guarded error logging with automatic categorization. */
    logError(where, err, data = {}) {
        return this.log('error', where, { ...data, category2: classifyError(err), message: String(err?.message ?? err).slice(0, 240) });
    }

    _maybeTrim() {
        // cheap cadence: size-check at most every 50 writes
        if (this._written % 50 !== 0 && this._written - this._lastSizeCheck < 50) return;
        this._lastSizeCheck = this._written;
        try {
            const fp = this.filePath();
            const st = fs.statSync(fp);
            if (st.size <= this.maxSizeBytes) return;
            const buf = fs.readFileSync(fp, 'utf8');
            const tail = buf.slice(-this.keepBytes);
            const nl = tail.indexOf('\n');
            fs.writeFileSync(fp, nl >= 0 ? tail.slice(nl + 1) : '');
        } catch { /* trimming is best-effort */ }
    }

    /** Read the last `n` events, optionally filtered by category. */
    tail(n = 20, { category = null } = {}) {
        try {
            const raw = fs.readFileSync(this.filePath(), 'utf8').trim();
            if (!raw) return [];
            let lines = raw.split('\n');
            if (category) {
                lines = lines.filter(l => {
                    try { return JSON.parse(l).category === category; } catch { return false; }
                });
            }
            return lines.slice(-n).map(l => {
                try { return JSON.parse(l); } catch { return null; }
            }).filter(Boolean);
        } catch {
            return [];
        }
    }

    /** Human-readable digest for !debug log. */
    summarize(n = 10) {
        const events = this.tail(n);
        if (!events.length) return 'No structured events logged yet.';
        return events.map(e => {
            const data = { ...e };
            delete data.t; delete data.category; delete data.event;
            const extra = Object.entries(data).map(([k, v]) => `${k}=${typeof v === 'object' ? JSON.stringify(v) : v}`).join(' ');
            return `- [${e.category}] ${e.event}${extra ? ` ${extra}` : ''}`;
        }).join('\n');
    }
}

/**
 * Lazy, cached logger honoring settings.structured_logs.
 * Accepts an agent OR a bare bot (bot-level call sites like skills).
 */
export function getLogger(agentOrBot) {
    if (!agentOrBot) return null;
    if (agentOrBot._structlog) return agentOrBot._structlog;
    const block = settings.structured_logs ?? {};
    const botName = agentOrBot?.bot?.username ?? agentOrBot?.username ?? agentOrBot?.name ?? 'bot';
    agentOrBot._structlog = new StructuredLogger({
        botName,
        enabled: block.enabled !== false,
        categories: Array.isArray(block.categories) ? block.categories : null
    });
    return agentOrBot._structlog;
}

/** One-shot guarded logger: logEvent(agentOrBot, 'navigation', 'route', {...}). */
export function logEvent(agentOrBot, category, event, data = {}) {
    try {
        const logger = getLogger(agentOrBot);
        if (logger) logger.log(category, event, data);
    } catch { /* never break the caller */ }
}
