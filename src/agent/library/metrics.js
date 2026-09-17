/**
 * metrics.js — survival metrics (GO list: death metrics / performance
 * metrics). Tracks the bot's deaths — count, causes, positions — across
 * sessions, plus session uptime, so benchmarks can assert on survival and
 * the player can ask "how am I doing?".
 *
 * Persisted per bot at bots/<botName>/metrics.json; atomic, corrupt-tolerant.
 */

import fs from 'fs';
import path from 'path';

export class MetricsTracker {
    /**
     * @param {object} opts { botName, dir = 'bots', now = Date.now }
     */
    constructor({ botName = 'bot', dir = 'bots', now = () => Date.now() } = {}) {
        this.botName = botName;
        this.dir = dir;
        this._now = now;
        this.sessionStart = now();
        /** cumulative across sessions */
        this.deaths = 0;
        this.respawns = 0;
        /** cause -> count */
        this.causes = {};
        /** { t, cause, x, y, z } */
        this.lastDeath = null;
        /** { t, x, y, z } */
        this.lastRespawn = null;
        /** sessions observed (increments on construction with a persisted file) */
        this.sessions = 1;
        /** replan / movement / waste metrics */
        this.replans = 0;
        this.lastReplan = null;
        this.paths = { ok: 0, fail: 0, cachedReplays: 0 };
        this.distanceWalked = 0;
        this.waste = {};
        /** error categorization: category -> count (GO list) */
        this.errors = {};
        this._dirty = false;
        this.load();
    }

    filePath() {
        return path.join(this.dir, this.botName, 'metrics.json');
    }

    /**
     * Record a death. Cause may be refined later via setLastCause.
     * @param {object} [opts] { cause, pos }
     */
    recordDeath({ cause = 'unknown', pos = null, inventory = null } = {}) {
        this.deaths += 1;
        const c = String(cause || 'unknown').slice(0, 48);
        this.causes[c] = (this.causes[c] ?? 0) + 1;
        this.lastDeath = {
            t: this._now(),
            cause: c,
            x: pos?.x != null ? Math.round(pos.x * 10) / 10 : null,
            y: pos?.y != null ? Math.round(pos.y * 10) / 10 : null,
            z: pos?.z != null ? Math.round(pos.z * 10) / 10 : null
        };
        // Item recovery after death (GO list): snapshot what the bot was
        // carrying so it can go back for the dropped items on respawn.
        if (inventory && typeof inventory === 'object') {
            const items = Object.entries(inventory)
                .filter(([k, v]) => v > 0)
                .sort((a, b) => b[1] - a[1])
                .slice(0, 12)
                .map(([k, v]) => `${k} x${v}`);
            this.lastDeath.inventory = items;
        }
        this.persist();
        return this.lastDeath;
    }

    /** Refine the cause of the most recent death (e.g. from the death message). */
    setLastCause(cause) {
        if (!this.lastDeath || !cause) return false;
        const old = this.lastDeath.cause;
        const c = String(cause).slice(0, 48);
        if (old === c) return false;
        if (this.causes[old] != null) {
            this.causes[old] -= 1;
            if (this.causes[old] <= 0) delete this.causes[old];
        }
        this.causes[c] = (this.causes[c] ?? 0) + 1;
        this.lastDeath.cause = c;
        this.persist();
        return true;
    }

    /** Record a respawn (server moved the bot to a spawn point). */
    recordRespawn({ pos = null } = {}) {
        this.respawns += 1;
        const prev = this.lastRespawn ?? {};
        this.lastRespawn = {
            t: this._now(),
            x: pos?.x != null ? Math.round(pos.x * 10) / 10 : prev.x ?? null,
            y: pos?.y != null ? Math.round(pos.y * 10) / 10 : prev.y ?? null,
            z: pos?.z != null ? Math.round(pos.z * 10) / 10 : prev.z ?? null
        };
        this.persist();
        return this.lastRespawn;
    }

    /** Replan metrics (GO list): count replans/recoveries across sessions. */
    recordReplan({ reason = 'unknown' } = {}) {
        this.replans = (this.replans ?? 0) + 1;
        this.lastReplan = { t: this._now(), reason: String(reason).slice(0, 64) };
        this.persist();
    }

    /** Movement metrics (GO list): path outcomes + distance walked. */
    recordPath({ status = 'ok', cached = false } = {}) {
        this.paths ??= { ok: 0, fail: 0, cachedReplays: 0 };
        if (status === 'ok') this.paths.ok++;
        else this.paths.fail++;
        if (cached) this.paths.cachedReplays++;
        // persisted with the next persist() call (cheap enough to batch)
        this._dirty = true;
    }

    addDistance(blocks) {
        if (!(blocks > 0)) return;
        this.distanceWalked = Math.round(((this.distanceWalked ?? 0) + blocks) * 10) / 10;
        this._dirty = true;
    }

    /** Resource-waste metrics (GO list): broken tools, dropped items, failed crafts. */
    recordWaste(kind, { item = null } = {}) {
        this.waste ??= {};
        const key = item ? `${kind}:${item}` : kind;
        this.waste[key] = (this.waste[key] ?? 0) + 1;
        this.persist();
    }

    /** Error categorization (GO list): count failures by stable category. */
    recordError(category, { detail = null } = {}) {
        this.errors ??= {};
        const key = String(category || 'unknown').slice(0, 32);
        this.errors[key] = (this.errors[key] ?? 0) + 1;
        this.lastError = { t: this._now(), category: key, detail: detail ? String(detail).slice(0, 120) : null };
        this.persist();
    }

    uptimeMs() {
        return Math.max(0, this._now() - this.sessionStart);
    }

    /** Deaths per hour this session (0 before a full hour). */
    deathRatePerHour() {
        const hours = this.uptimeMs() / 3.6e6;
        if (hours <= 0) return 0;
        return Math.round((this.deaths / hours) * 100) / 100;
    }

    summarize() {
        const lines = ['METRICS'];
        lines.push(`Deaths (all time): ${this.deaths}`);
        const top = Object.entries(this.causes).sort((a, b) => b[1] - a[1]).slice(0, 4);
        lines.push(top.length
            ? `Top causes: ${top.map(([c, n]) => `${c} x${n}`).join(', ')}`
            : 'Top causes: none');
        if (this.lastDeath) {
            const where = this.lastDeath.x != null ? ` at (${this.lastDeath.x}, ${this.lastDeath.y}, ${this.lastDeath.z})` : '';
            lines.push(`Last death: ${this.lastDeath.cause}${where}`);
        } else {
            lines.push('Last death: none — still alive out there');
        }
        if (this.lastRespawn) {
            const where = this.lastRespawn.x != null ? ` at (${this.lastRespawn.x}, ${this.lastRespawn.y}, ${this.lastRespawn.z})` : '';
            lines.push(`Respawns: ${this.respawns}, last${where}`);
        } else {
            lines.push(`Respawns: ${this.respawns}`);
        }
        const mins = Math.round(this.uptimeMs() / 60000);
        lines.push(`Session uptime: ${mins} min, death rate: ${this.deathRatePerHour()}/h`);
        const p = this.paths ?? { ok: 0, fail: 0, cachedReplays: 0 };
        lines.push(`Replans: ${this.replans ?? 0}; paths ok/fail: ${p.ok}/${p.fail} (${p.cachedReplays ?? 0} cached replays)`);
        lines.push(`Distance walked: ${Math.round(this.distanceWalked ?? 0)} blocks`);
        const waste = Object.entries(this.waste ?? {});
        lines.push(waste.length
            ? `Waste: ${waste.slice(0, 4).map(([k, n]) => `${k} x${n}`).join(', ')}`
            : 'Waste: none recorded');
        const errs = Object.entries(this.errors ?? {});
        lines.push(errs.length
            ? `Errors: ${errs.sort((a, b) => b[1] - a[1]).slice(0, 4).map(([k, n]) => `${k} x${n}`).join(', ')}`
            : 'Errors: none recorded');
        return lines.join('\n');
    }

    /** Throttled flush of dirty high-frequency counters (movement/paths). */
    flushIfDirty({ minIntervalMs = 60_000 } = {}) {
        if (!this._dirty) return false;
        const now = this._now();
        if (now - (this._lastFlush ?? 0) < minIntervalMs) return false;
        this._lastFlush = now;
        this._dirty = false;
        return this.persist();
    }

    persist() {
        try {
            const fp = this.filePath();
            fs.mkdirSync(path.dirname(fp), { recursive: true });
            const tmp = `${fp}.tmp`;
            fs.writeFileSync(tmp, JSON.stringify({
                deaths: this.deaths,
                respawns: this.respawns,
                causes: this.causes,
                lastDeath: this.lastDeath,
                lastRespawn: this.lastRespawn,
                sessions: this.sessions,
                replans: this.replans ?? 0,
                lastReplan: this.lastReplan ?? null,
                paths: this.paths ?? { ok: 0, fail: 0, cachedReplays: 0 },
                distanceWalked: this.distanceWalked ?? 0,
                waste: this.waste ?? {},
                errors: this.errors ?? {},
                lastError: this.lastError ?? null
            }, null, 2));
            fs.renameSync(tmp, fp);
            return true;
        } catch { return false; }
    }

    load() {
        try {
            const data = JSON.parse(fs.readFileSync(this.filePath(), 'utf8'));
            this.deaths = Number(data?.deaths) || 0;
            this.respawns = Number(data?.respawns) || 0;
            this.causes = (data?.causes && typeof data.causes === 'object') ? data.causes : {};
            this.lastDeath = data?.lastDeath ?? null;
            this.lastRespawn = data?.lastRespawn ?? null;
            this.sessions = (Number(data?.sessions) || 0) + 1;
            this.replans = Number(data?.replans) || 0;
            this.lastReplan = data?.lastReplan ?? null;
            this.paths = data?.paths && typeof data.paths === 'object'
                ? { ok: Number(data.paths.ok) || 0, fail: Number(data.paths.fail) || 0, cachedReplays: Number(data.paths.cachedReplays) || 0 }
                : { ok: 0, fail: 0, cachedReplays: 0 };
            this.distanceWalked = Number(data?.distanceWalked) || 0;
            this.waste = data?.waste && typeof data.waste === 'object' ? data.waste : {};
            this.errors = data?.errors && typeof data.errors === 'object' ? data.errors : {};
            this.lastError = data?.lastError ?? null;
            return true;
        } catch { return false; }
    }
}

/** Shared helper: tracker for an agent's bot, cached on the agent. */
export function getMetrics(agent) {
    const botName = agent?.bot?.username ?? agent?.name;
    if (!botName) return null;
    if (!agent._metrics || agent._metrics.botName !== botName) {
        agent._metrics = new MetricsTracker({ botName });
    }
    return agent._metrics;
}

/** Extract a coarse cause from a Minecraft death message. */
export function causeFromDeathMessage(message, botName = '') {
    const m = String(message ?? '');
    const strip = m.replace(botName, '').trim();
    if (/slain by (\w+)/i.test(strip)) return `slain by ${strip.match(/slain by (\w+)/i)[1]}`;
    if (/shot by (\w+)/i.test(strip)) return `shot by ${strip.match(/shot by (\w+)/i)[1]}`;
    if (/fell/i.test(strip)) return 'fell';
    if (/drowned/i.test(strip)) return 'drowned';
    if (/burned|burnt|fire|lava/i.test(strip)) return 'fire';
    if (/explod|blew up|creeper/i.test(strip)) return 'explosion';
    if (/starved/i.test(strip)) return 'starved';
    if (/void/i.test(strip)) return 'void';
    return 'unknown';
}
