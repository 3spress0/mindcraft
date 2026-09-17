/**
 * store.js — atomic persistence for a bot's WorldModel.
 *
 * Default backend: bots/<name>/world_model.json. Writes go through a temp
 * file + rename so a crash mid-write can never corrupt the model, and a
 * corrupt model file is quarantined instead of taking the agent down.
 *
 * Database-backed world model (GO list): persistence goes through a small
 * storage-adapter interface — { read(), write(json), remove() } — so a real
 * database (SQLite, etc.) can be swapped in without touching the model or
 * its callers. JSONFileAdapter is the default; pass a custom adapter via
 * settings.world_model.adapter or the constructor.
 */

import fs from 'fs';
import path from 'path';
import { WorldModel } from './world_model.js';

/** Default adapter: one JSON file per bot, atomic writes. */
export class JSONFileAdapter {
    constructor(fp) {
        this.fp = fp;
    }

    /** @returns {object|null} parsed data or null when nothing stored */
    read() {
        if (!fs.existsSync(this.fp)) return null;
        return JSON.parse(fs.readFileSync(this.fp, 'utf8'));
    }

    write(json) {
        fs.mkdirSync(path.dirname(this.fp), { recursive: true });
        const tmp = `${this.fp}.${process.pid}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify(json, null, 2));
        fs.renameSync(tmp, this.fp);
        return true;
    }

    remove() {
        if (fs.existsSync(this.fp)) fs.unlinkSync(this.fp);
        return true;
    }

    /** Optional hook: quarantine a corrupt payload. Adapters may ignore it. */
    quarantine() {
        try {
            if (fs.existsSync(this.fp)) fs.renameSync(this.fp, `${this.fp}.corrupt-${Date.now()}`);
        } catch { /* best effort */ }
    }
}

export class WorldModelStore {
    constructor(botName, dir = './bots', { adapter = null } = {}) {
        this.dir = path.join(dir, botName);
        this.fp = path.join(this.dir, 'world_model.json');
        this.lastSave = 0;
        this.adapter = adapter ?? new JSONFileAdapter(this.fp);
    }

    save(model, { force = false, minIntervalMs = 0 } = {}) {
        const now = Date.now();
        if (!force && minIntervalMs > 0 && now - this.lastSave < minIntervalMs) return false;
        try {
            this.adapter.write(model.toJSON());
            this.lastSave = now;
            return true;
        } catch (err) {
            console.error(`[world-model] save failed: ${err.message}`);
            return false;
        }
    }

    load() {
        try {
            const data = this.adapter.read();
            if (data == null) return null;
            const model = WorldModel.fromJSON(data);
            // The world may have changed while we were offline: drop facts that
            // were already due to expire; durable facts survive restarts.
            model.tick(Date.now());
            return model;
        } catch (err) {
            console.error(`[world-model] failed to load model (quarantining): ${err.message}`);
            try { this.adapter.quarantine?.(); } catch { /* best effort */ }
            return null;
        }
    }

    clear() {
        try {
            this.adapter.remove();
        } catch (err) {
            console.error(`[world-model] clear failed: ${err.message}`);
        }
    }
}
