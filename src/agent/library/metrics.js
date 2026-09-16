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
        /** cause -> count */
        this.causes = {};
        /** { t, cause, x, y, z } */
        this.lastDeath = null;
        /** sessions observed (increments on construction with a persisted file) */
        this.sessions = 1;
        this.load();
    }

    filePath() {
        return path.join(this.dir, this.botName, 'metrics.json');
    }

    /**
     * Record a death. Cause may be refined later via setLastCause.
     * @param {object} [opts] { cause, pos }
     */
    recordDeath({ cause = 'unknown', pos = null } = {}) {
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
        const mins = Math.round(this.uptimeMs() / 60000);
        lines.push(`Session uptime: ${mins} min, death rate: ${this.deathRatePerHour()}/h`);
        return lines.join('\n');
    }

    persist() {
        try {
            const fp = this.filePath();
            fs.mkdirSync(path.dirname(fp), { recursive: true });
            const tmp = `${fp}.tmp`;
            fs.writeFileSync(tmp, JSON.stringify({
                deaths: this.deaths,
                causes: this.causes,
                lastDeath: this.lastDeath,
                sessions: this.sessions
            }, null, 2));
            fs.renameSync(tmp, fp);
            return true;
        } catch { return false; }
    }

    load() {
        try {
            const data = JSON.parse(fs.readFileSync(this.filePath(), 'utf8'));
            this.deaths = Number(data?.deaths) || 0;
            this.causes = (data?.causes && typeof data.causes === 'object') ? data.causes : {};
            this.lastDeath = data?.lastDeath ?? null;
            this.sessions = (Number(data?.sessions) || 0) + 1;
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
