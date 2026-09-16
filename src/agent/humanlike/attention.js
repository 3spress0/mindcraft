// Attention tracking for the humanlike layer.
// Remembers what entities the bot has recently *seen* (line-of-sight gated,
// unlike raw nearestEntity staring), detects novel sightings, records sudden
// events (sounds/damage) worth turning toward, and performs bounded glances.

import { lineOfSight } from '../sensors/radar.js';
import { sleep } from './rng.js';

const SEEN_TTL_MS = 60000;      // keep sightings for a minute
const EVENT_TTL_MS = 4000;      // sudden events stay "fresh" for 4s
const MAX_SEEN = 128;

export class AttentionTracker {
    /**
     * @param {function():number} [now] injectable clock for tests.
     */
    constructor(now = () => Date.now()) {
        this._now = now;
        this.seen = new Map();   // id -> { kind, name, x, y, z, firstSeen, lastSeen, novel }
        this.events = [];        // { x, y, z, kind, t }
        this.lastScan = 0;
    }

    _entityKind(entity) {
        if (!entity) return null;
        if (entity.type === 'player') return 'player';
        if (entity.type === 'mob') return 'mob';
        if (entity.type === 'object' && entity.name === 'item') return 'item';
        return null;
    }

    /**
     * Scan entities within `range` that the bot can actually see.
     * @returns {Array<{id,kind,name,pos,dist,isNew,isReappearing}>} sightings this scan,
     *   sorted by novelty (new/reappearing first) then distance.
     */
    scan(bot, { range = 24, now = this._now() } = {}) {
        const self = bot.entity?.position;
        if (!self) return [];
        const results = [];
        const seenThisScan = new Set();

        const consider = (entity) => {
            if (!entity || entity === bot.entity) return;
            const kind = this._entityKind(entity);
            if (!kind) return;
            const pos = entity.position;
            if (!pos) return;
            const dist = pos.distanceTo(self);
            if (dist > range) return;
            if (!lineOfSight(bot, pos, { maxDistance: dist + 1 })) return;

            const id = entity.id ?? `${kind}:${Math.round(pos.x)},${Math.round(pos.y)},${Math.round(pos.z)}`;
            if (seenThisScan.has(id)) return;
            seenThisScan.add(id);
            const prev = this.seen.get(id);
            const isNew = !prev;
            const isReappearing = !!prev && (now - prev.lastSeen > SEEN_TTL_MS);
            const rec = {
                kind,
                name: entity.name || entity.username || kind,
                x: pos.x, y: pos.y, z: pos.z,
                firstSeen: prev ? prev.firstSeen : now,
                lastSeen: now,
                novel: isNew || isReappearing
            };
            this.seen.set(id, rec);

            const name = entity.name || entity.username || kind;
            results.push({ id, kind, name, pos: { x: pos.x, y: pos.y, z: pos.z }, dist, isNew, isReappearing });
        };

        // players
        for (const p of Object.values(bot.players || {})) {
            if (p && p.entity) consider(p.entity);
        }
        // mobs and items via objectModeMap if present, else entity array fallback
        const pool = [];
        if (typeof bot.objectModeMap === 'function') {
            try { pool.push(...Object.values(bot.objectModeMap())); } catch (e) { /* best effort */ }
        } else if (bot.nearestEntity) {
            const near = bot.nearestEntity(() => true);
            if (near) pool.push(near);
        }
        for (const e of pool) consider(e);

        // prune
        if (this.seen.size > MAX_SEEN) {
            const entries = [...this.seen.entries()].sort((a, b) => a[1].lastSeen - b[1].lastSeen);
            for (const [k] of entries.slice(0, this.seen.size - MAX_SEEN)) this.seen.delete(k);
        }
        this.lastScan = now;

        results.sort((a, b) => {
            const na = a.isNew || a.isReappearing ? 0 : 1;
            const nb = b.isNew || b.isReappearing ? 0 : 1;
            return na - nb || a.dist - b.dist;
        });
        return results;
    }

    /** Novel sightings only (new or reappeared since expiry). */
    novelSights(bot, opts) {
        return this.scan(bot, opts).filter(s => s.isNew || s.isReappearing);
    }

    /** When did we last see a player by name (username), or null. */
    lastSeen(name) {
        for (const rec of this.seen.values()) {
            if (rec.kind === 'player' && rec.name === name) return rec;
        }
        return null;
    }

    /** Record a sudden event worth turning toward (damage taken, explosion, loud sound). */
    recordEvent(x, y, z, kind = 'event') {
        this.events.push({ x, y, z, kind, t: this._now() });
        if (this.events.length > 8) this.events.shift();
    }

    /** Most recent fresh event, or null. */
    freshEvent(withinMs = EVENT_TTL_MS) {
        const now = this._now();
        while (this.events.length && now - this.events[0].t > EVENT_TTL_MS) this.events.shift();
        if (!this.events.length) return null;
        const e = this.events[this.events.length - 1];
        return (now - e.t) <= withinMs ? e : null;
    }

    summarize() {
        const now = this._now();
        const active = [...this.seen.values()].filter(r => now - r.lastSeen <= SEEN_TTL_MS);
        const players = active.filter(r => r.kind === 'player').length;
        const mobs = active.filter(r => r.kind === 'mob').length;
        const items = active.filter(r => r.kind === 'item').length;
        return { players, mobs, items, freshEvents: this.events.length };
    }
}

/**
 * Humanlike glance: look toward a point with bounded imprecision and dwell.
 * Never uses forced looks (so pathfinding keeps camera control if active).
 * @param {object} bot
 * @param {{x:number,y:number,z:number}} pos
 * @param {object} personality - from personality.js
 * @param {object} [opts] - { maxOffset=0.25, minDwellMs=150, maxDwellMs=700, returnAfterMs }
 * @returns {Promise<{yaw:number,pitch:number,dwellMs:number}>}
 */
export async function glance(bot, pos, personality, opts = {}) {
    const self = bot.entity?.position;
    if (!self) return null;
    const { maxOffset = 0.25, minDwellMs = 150, maxDwellMs = 700 } = opts;
    const rng = personality?.rng;

    const offset = () => rng ? rng.range(-maxOffset, maxOffset) : 0;
    const target = { x: pos.x + offset(), y: pos.y + offset(), z: pos.z + offset() };

    const dx = target.x - self.x;
    const dy = target.y - (self.y + 1.62);
    const dz = target.z - self.z;
    const groundDist = Math.sqrt(dx * dx + dz * dz);
    const yaw = Math.atan2(-dx, dz);
    const pitch = Math.atan2(dy, groundDist);

    // precision trait reduces jitter on the final look
    const steadiness = personality?.traits?.precision ?? 0.7;
    const jitterScale = (1 - steadiness) * 0.05;
    const jy = rng ? rng.range(-jitterScale, jitterScale) : 0;
    const jp = rng ? rng.range(-jitterScale, jitterScale) : 0;

    await bot.look(yaw + jy, pitch + jp, false);
    const dwellMs = personality
        ? personality.delay(minDwellMs, maxDwellMs)
        : Math.round((minDwellMs + maxDwellMs) / 2);
    await sleep(dwellMs, bot);
    return { yaw: yaw + jy, pitch: pitch + jp, dwellMs };
}
