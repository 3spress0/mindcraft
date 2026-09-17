/**
 * reservations.js — resource reservations.
 * (GO list: resource reservation.)
 *
 * Lets a bot (or a cooperating group) claim quantities of item types ahead
 * of time — "I need 16 iron_ingot for a project" — so background flows like
 * unloading don't ship the reserved stock away and two plans don't spend the
 * same iron twice. Persisted per bot, TTL-bounded, JSON-atomic like the
 * other registries.
 */

import fs from 'fs';
import path from 'path';

export class ResourceReservations {
    /**
     * @param {object} opts { botName, dir, now, ttlMs }
     */
    constructor({ botName = 'bot', dir = 'bots', now = () => Date.now(), ttlMs = 6 * 3600 * 1000 } = {}) {
        this.botName = botName;
        this.dir = dir;
        this._now = now;
        this.ttlMs = ttlMs;
        /** @type {Array<{item, qty, holder, expires}>} */
        this.entries = [];
        this.load();
    }

    filePath() {
        return path.join(this.dir, this.botName, 'resource_reservations.json');
    }

    _prune() {
        const now = this._now();
        this.entries = this.entries.filter(e => (e.expires ?? Infinity) > now);
    }

    /**
     * Reserve a quantity of an item for a holder.
     * @returns {{ok, entry}|{ok:boolean, reason:string}}
     */
    reserve(item, qty, holder = 'self', { ttlMs = null } = {}) {
        const q = Math.floor(Number(qty));
        if (!item || !(q > 0)) return { ok: false, reason: 'invalid reservation' };
        this._prune();
        const entry = {
            item: String(item),
            qty: q,
            holder: String(holder || 'self').slice(0, 48),
            expires: this._now() + (ttlMs ?? this.ttlMs)
        };
        // merge with an existing reservation for the same holder+item
        const existing = this.entries.find(e => e.item === entry.item && e.holder === entry.holder);
        if (existing) {
            existing.qty += entry.qty;
            existing.expires = entry.expires;
        } else {
            this.entries.push(entry);
        }
        this.persist();
        return { ok: true, entry: existing ?? entry };
    }

    /** Release some or all of a holder's reservation for an item. */
    release(item, holder = 'self', qty = Infinity) {
        this._prune();
        let released = 0;
        for (const e of this.entries) {
            if (e.item !== item || e.holder !== holder) continue;
            const take = Math.min(e.qty, qty === Infinity ? e.qty : Math.floor(qty));
            e.qty -= take;
            released += take;
            if (qty !== Infinity) qty -= take;
        }
        this.entries = this.entries.filter(e => e.qty > 0);
        if (released) this.persist();
        return released;
    }

    /** Total reserved quantity for an item (optionally excluding a holder). */
    reserved(item, { exceptHolder = null } = {}) {
        this._prune();
        return this.entries
            .filter(e => e.item === item && e.holder !== exceptHolder)
            .reduce((n, e) => n + e.qty, 0);
    }

    /** How much of `have` is actually free after reservations. */
    available(item, have, { exceptHolder = null } = {}) {
        return Math.max(0, (have ?? 0) - this.reserved(item, { exceptHolder }));
    }

    list() {
        this._prune();
        return this.entries.map(e => ({ ...e }));
    }

    persist() {
        try {
            const fp = this.filePath();
            fs.mkdirSync(path.dirname(fp), { recursive: true });
            const tmp = `${fp}.${process.pid}.tmp`;
            fs.writeFileSync(tmp, JSON.stringify({ entries: this.entries }, null, 2));
            fs.renameSync(tmp, fp);
            return true;
        } catch { return false; }
    }

    load() {
        try {
            const data = JSON.parse(fs.readFileSync(this.filePath(), 'utf8'));
            if (Array.isArray(data?.entries)) this.entries = data.entries;
            this._prune();
            return true;
        } catch { return false; }
    }
}

/** Cached per-agent registry. */
export function getReservations(agent) {
    const botName = agent?.bot?.username ?? agent?.name;
    if (!botName) return null;
    if (!agent._resource_reservations || agent._resource_reservations.botName !== botName) {
        agent._resource_reservations = new ResourceReservations({ botName });
    }
    return agent._resource_reservations;
}

/** Report for !reservations. */
export function reservationsReport(agent) {
    const reg = getReservations(agent);
    if (!reg) return 'No reservations registry.';
    const entries = reg.list();
    if (!entries.length) return 'No resource reservations.';
    return entries.map(e => `- ${e.qty}x ${e.item} for ${e.holder} (expires in ${Math.max(0, Math.round((e.expires - Date.now()) / 60000))} min)`).join('\n');
}
