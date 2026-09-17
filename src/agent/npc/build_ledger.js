/**
 * build_ledger.js — build cancellation bookkeeping, rollback, and
 * temporary-block management (GO list).
 *
 * Every build registers here with start/finish/cancel records, placements
 * land in a bounded ring, and any block the bot removes on purpose (terrain
 * prep, scaffolding) is tracked as a *temporary block* that can be restored.
 * Persisted per bot in bots/<name>/build_ledger.json.
 */

import fs from 'fs';
import path from 'path';

const MAX_PLACEMENTS = 512;
const MAX_TEMP = 256;

export class BuildLedger {
    /** @param {{botName?:string, dir?:string, now?:()=>number}} [opts] */
    constructor({ botName = 'bot', dir = 'bots', now = () => Date.now() } = {}) {
        this.botName = botName;
        this.dir = path.join(dir, botName);
        this.fp = path.join(this.dir, 'build_ledger.json');
        this._now = now;
        /** currently active build: { name, position, startedAt } | null */
        this.active = null;
        /** bounded ring of placements, oldest first */
        this.placements = [];
        /** temporary blocks removed on purpose: { pos, original, t } */
        this.tempBlocks = [];
        /** dedicated cancel bookkeeping: { name, reason, t, placements } */
        this.cancellations = [];
        this.load();
    }

    load() {
        try {
            const data = JSON.parse(fs.readFileSync(this.fp, 'utf8'));
            this.active = data?.active ?? null;
            this.placements = Array.isArray(data?.placements) ? data.placements.slice(-MAX_PLACEMENTS) : [];
            this.tempBlocks = Array.isArray(data?.tempBlocks) ? data.tempBlocks.slice(-MAX_TEMP) : [];
            this.cancellations = Array.isArray(data?.cancellations) ? data.cancellations.slice(-8) : [];
        } catch { /* fresh ledger */ }
        return this;
    }

    persist() {
        try {
            fs.mkdirSync(this.dir, { recursive: true });
            const tmp = `${this.fp}.tmp`;
            fs.writeFileSync(tmp, JSON.stringify({
                active: this.active,
                placements: this.placements.slice(-MAX_PLACEMENTS),
                tempBlocks: this.tempBlocks.slice(-MAX_TEMP),
                cancellations: this.cancellations.slice(-8)
            }, null, 2));
            fs.renameSync(tmp, this.fp);
            return true;
        } catch { return false; }
    }

    startBuild(name, position = null) {
        this.active = {
            name: String(name ?? 'build').slice(0, 64),
            position: position ? { x: Math.round(position.x), y: Math.round(position.y), z: Math.round(position.z) } : null,
            startedAt: this._now()
        };
        this.placements = [];
        this.persist();
        return this.active;
    }

    /** Record one placed block (bounded ring). */
    recordPlacement(pos, blockName, replacedName = null) {
        if (!pos || typeof pos.x !== 'number') return;
        this.placements.push({
            x: Math.round(pos.x), y: Math.round(pos.y), z: Math.round(pos.z),
            block: String(blockName ?? 'unknown').slice(0, 48),
            replaced: replacedName ? String(replacedName).slice(0, 48) : null,
            t: this._now()
        });
        if (this.placements.length > MAX_PLACEMENTS) {
            this.placements.splice(0, this.placements.length - MAX_PLACEMENTS);
        }
        // durable on purpose: a crash mid-build must not lose rollback data
        this.persist();
    }

    finishBuild(name, { completed = true } = {}) {
        const was = this.active;
        this.active = null;
        this.persist();
        return { ...was, name: name ?? was?.name, completed };
    }

    /**
     * Build cancellation (GO list): dedicated bookkeeping — who/what/why and
     * how many placements are now rollback candidates.
     */
    cancelBuild(name, reason = 'user cancelled') {
        const record = {
            name: String(name ?? this.active?.name ?? 'build').slice(0, 64),
            reason: String(reason ?? 'cancelled').slice(0, 120),
            t: this._now(),
            placements: this.placements.length
        };
        this.cancellations.push(record);
        if (this.cancellations.length > 8) this.cancellations.splice(0, this.cancellations.length - 8);
        this.active = null;
        this.persist();
        return record;
    }

    /** Temporary-block management: a block removed on purpose, restorable. */
    registerTempBlock(pos, originalName) {
        if (!pos || typeof pos.x !== 'number') return;
        this.tempBlocks.push({
            x: Math.round(pos.x), y: Math.round(pos.y), z: Math.round(pos.z),
            original: String(originalName ?? 'air').slice(0, 48),
            t: this._now()
        });
        if (this.tempBlocks.length > MAX_TEMP) this.tempBlocks.splice(0, this.tempBlocks.length - MAX_TEMP);
        this.persist();
    }

    /** Consume and clear the temporary-block list (for restoring). */
    takeTempBlocks() {
        const list = this.tempBlocks;
        this.tempBlocks = [];
        this.persist();
        return list;
    }

    /**
     * Rollback plan (GO list: build rollback where practical): the placed
     * blocks in reverse order — dig last-placed first. Bounded.
     * @param {number} [max]
     */
    rollbackPlan(max = 128) {
        return this.placements.slice(-Math.min(max, MAX_PLACEMENTS)).reverse();
    }

    summary() {
        const lines = ['Build ledger:'];
        lines.push(this.active
            ? `- active: ${this.active.name} (${this.placements.length} placement(s) recorded)`
            : '- active: none');
        lines.push(`- placements on record: ${this.placements.length}`);
        lines.push(`- temporary blocks pending restore: ${this.tempBlocks.length}`);
        if (this.cancellations.length) {
            const last = this.cancellations[this.cancellations.length - 1];
            lines.push(`- last cancel: ${last.name} — ${last.reason} (${last.placements} placement(s))`);
        }
        return lines.join('\n');
    }
}

let _ledgerCache = new Map();

/** Get (or create) the ledger for an agent/bot name. Never throws. */
export function getBuildLedger(agent) {
    try {
        const botName = agent?.bot?.username ?? agent?.name ?? 'bot';
        if (!_ledgerCache.has(botName)) _ledgerCache.set(botName, new BuildLedger({ botName }));
        return _ledgerCache.get(botName);
    } catch { return null; }
}

/**
 * Build rollback where practical (GO list): dig the recorded placements in
 * reverse order, bounded per call. Returns { rolledBack, failed }.
 */
export async function rollbackBuild(agent, { max = 64 } = {}) {
    const ledger = getBuildLedger(agent);
    const bot = agent?.bot;
    if (!ledger || !bot) return { rolledBack: 0, failed: 0 };
    const plan = ledger.rollbackPlan(max);
    let rolledBack = 0;
    let failed = 0;
    for (const p of plan) {
        if (bot.interrupt_code) break;
        try {
            const block = bot.blockAt?.({ x: p.x, y: p.y, z: p.z }, false);
            if (!block || block.name === 'air' || block.name !== p.block) {
                // already gone or replaced by something else — skip, don't dig
                ledger.placements = ledger.placements.filter(q => !(q.x === p.x && q.y === p.y && q.z === p.z));
                continue;
            }
            const skills = await import('../library/skills.js');
            const ok = await skills.breakBlockAt?.(bot, p.x, p.y, p.z);
            if (ok !== false) {
                rolledBack++;
                ledger.placements = ledger.placements.filter(q => !(q.x === p.x && q.y === p.y && q.z === p.z));
            } else {
                failed++;
            }
        } catch {
            failed++;
        }
        if (rolledBack + failed >= max) break;
    }
    ledger.persist();
    return { rolledBack, failed };
}

/**
 * Restore temporary blocks where practical (GO list: temporary-block
 * management): put back the original blocks that terrain prep removed,
 * bounded per call. Returns { restored, failed, remaining }.
 */
export async function restoreTempBlocks(agent, { max = 64 } = {}) {
    const ledger = getBuildLedger(agent);
    const bot = agent?.bot;
    if (!ledger || !bot) return { restored: 0, failed: 0, remaining: 0 };
    const list = ledger.tempBlocks;
    if (!list.length) return { restored: 0, failed: 0, remaining: 0 };
    const skills = await import('../library/skills.js');
    let restored = 0;
    let failed = 0;
    const keep = [];
    for (const tb of list) {
        if (restored + failed >= max) { keep.push(tb); continue; }
        if (bot.interrupt_code) { keep.push(tb); continue; }
        try {
            const current = bot.blockAt?.({ x: tb.x, y: tb.y, z: tb.z }, false);
            // only restore into air so we never clobber a real block
            if (current && current.name !== 'air' && current.name !== 'cave_air') { failed++; continue; }
            const ok = await skills.placeBlock?.(bot, tb.original, tb.x, tb.y, tb.z) ?? false;
            if (ok) restored++; else failed++;
        } catch { failed++; }
    }
    ledger.tempBlocks = keep;
    ledger.persist();
    return { restored, failed, remaining: keep.length };
}
