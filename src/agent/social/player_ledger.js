/**
 * player_ledger.js — persistent social memory (GO list: friend/ally memory,
 * unknown-player classification).
 *
 * The bot keeps a bounded record of every player it has seen: trust level
 * (friend / neutral / hostile), first/last seen times, and sighting counts.
 * Everything is legit — positions and names come from server entities the
 * bot can actually observe.
 */

import fs from 'fs';
import path from 'path';

export const TRUST = { FRIEND: 'friend', NEUTRAL: 'neutral', HOSTILE: 'hostile' };
export const MAX_PLAYERS = 128;

function normalizeName(name) {
    return String(name ?? '').trim().toLowerCase();
}

export class PlayerLedger {
    /**
     * @param {object} [opts] - { botName, dir, now }
     */
    constructor({ botName = 'bot', dir = './bots', now = () => Date.now() } = {}) {
        this.botName = botName;
        this.dir = path.join(dir, botName);
        this.fp = path.join(this.dir, 'player_ledger.json');
        this._now = now;
        this.players = new Map(); // name -> entry
    }

    _entry(name) {
        const key = normalizeName(name);
        if (!key) return null;
        let e = this.players.get(key);
        if (!e) {
            e = {
                name: key,
                trust: TRUST.NEUTRAL,
                firstSeen: this._now(),
                lastSeen: this._now(),
                sightings: 0,
                lastDist: null,
                note: null
            };
            this.players.set(key, e);
            this._prune();
        }
        return e;
    }

    /** Record a sighting; updates lastSeen, sightings, distance. */
    sight(name, { dist = null } = {}) {
        const e = this._entry(name);
        if (!e) return null;
        const t = this._now();
        e.lastSeen = t;
        e.sightings += 1;
        if (typeof dist === 'number') e.lastDist = Math.round(dist * 10) / 10;
        return e;
    }

    /** Set trust explicitly ('friend' | 'neutral' | 'hostile'). */
    setTrust(name, trust, { note = null } = {}) {
        const e = this._entry(name);
        if (!e) return null;
        if (!Object.values(TRUST).includes(trust)) return e;
        e.trust = trust;
        if (note != null) e.note = String(note).slice(0, 160);
        return e;
    }

    markHostile(name, reason = null) { return this.setTrust(name, TRUST.HOSTILE, { note: reason }); }
    markFriend(name, reason = null) { return this.setTrust(name, TRUST.FRIEND, { note: reason }); }

    get(name) {
        const key = normalizeName(name);
        return key ? (this.players.get(key) ?? null) : null;
    }

    /** 'friend' | 'neutral' | 'hostile' | 'unknown' */
    classify(name) {
        const e = this.get(name);
        return e ? e.trust : 'unknown';
    }

    list({ trust = null } = {}) {
        const all = [...this.players.values()];
        const filtered = trust ? all.filter(e => e.trust === trust) : all;
        return filtered.sort((a, b) => b.lastSeen - a.lastSeen);
    }

    _prune(cap = MAX_PLAYERS) {
        if (this.players.size <= cap) return;
        const ordered = [...this.players.values()].sort((a, b) => a.lastSeen - b.lastSeen);
        for (let i = 0; i < this.players.size - cap; i++) this.players.delete(ordered[i].name);
    }

    toJSON() {
        return { version: 1, players: [...this.players.values()] };
    }

    static fromJSON(data, opts = {}) {
        const ledger = new PlayerLedger(opts);
        for (const p of data?.players ?? []) {
            if (p?.name) ledger.players.set(normalizeName(p.name), p);
        }
        ledger._prune();
        return ledger;
    }

    load() {
        try {
            if (!fs.existsSync(this.fp)) return this;
            const data = JSON.parse(fs.readFileSync(this.fp, 'utf8'));
            const loaded = PlayerLedger.fromJSON(data, { botName: this.botName, dir: path.dirname(this.dir), now: this._now });
            this.players = loaded.players;
        } catch (err) {
            console.error(`[player-ledger] load failed: ${err.message}`);
        }
        return this;
    }

    persist() {
        try {
            fs.mkdirSync(this.dir, { recursive: true });
            const tmp = `${this.fp}.${process.pid}.tmp`;
            fs.writeFileSync(tmp, JSON.stringify(this.toJSON()));
            fs.renameSync(tmp, this.fp);
            return true;
        } catch (err) {
            console.error(`[player-ledger] persist failed: ${err.message}`);
            return false;
        }
    }

    /** Human-readable report for !social. */
    summarize() {
        const all = this.list();
        if (!all.length) return 'No players remembered yet.';
        const friends = all.filter(e => e.trust === TRUST.FRIEND).length;
        const hostiles = all.filter(e => e.trust === TRUST.HOSTILE).length;
        const lines = [`SOCIAL MEMORY (${all.length} player(s): ${friends} friend, ${hostiles} hostile)`];
        for (const e of all.slice(0, 12)) {
            const dist = e.lastDist != null ? `, last at ${e.lastDist}m` : '';
            const note = e.note ? ` — ${e.note}` : '';
            lines.push(`- ${e.name} [${e.trust}] seen x${e.sightings}${dist}${note}`);
        }
        if (all.length > 12) lines.push(`... and ${all.length - 12} more`);
        return lines.join('\n');
    }
}
