/**
 * store.js — atomic JSON persistence for a bot's WorldModel.
 *
 * File: bots/<name>/world_model.json. Writes go through a temp file + rename so
 * a crash mid-write can never corrupt the model, and a corrupt model file is
 * quarantined instead of taking the agent down (mirrors ProjectStore's role
 * for active projects).
 */

import fs from 'fs';
import path from 'path';
import { WorldModel } from './world_model.js';

export class WorldModelStore {
    constructor(botName, dir = './bots') {
        this.dir = path.join(dir, botName);
        this.fp = path.join(this.dir, 'world_model.json');
        this.lastSave = 0;
    }

    save(model, { force = false, minIntervalMs = 0 } = {}) {
        const now = Date.now();
        if (!force && minIntervalMs > 0 && now - this.lastSave < minIntervalMs) return false;
        try {
            fs.mkdirSync(this.dir, { recursive: true });
            const tmp = `${this.fp}.${process.pid}.tmp`;
            fs.writeFileSync(tmp, JSON.stringify(model.toJSON(), null, 2));
            fs.renameSync(tmp, this.fp);
            this.lastSave = now;
            return true;
        } catch (err) {
            console.error(`[world-model] save failed: ${err.message}`);
            return false;
        }
    }

    load() {
        try {
            if (!fs.existsSync(this.fp)) return null;
            const data = JSON.parse(fs.readFileSync(this.fp, 'utf8'));
            const model = WorldModel.fromJSON(data);
            // The world may have changed while we were offline: drop facts that
            // were already due to expire; durable facts survive restarts.
            model.tick(Date.now());
            return model;
        } catch (err) {
            console.error(`[world-model] failed to load model (quarantining): ${err.message}`);
            try {
                if (fs.existsSync(this.fp)) {
                    fs.renameSync(this.fp, `${this.fp}.corrupt-${Date.now()}`);
                }
            } catch { /* best effort */ }
            return null;
        }
    }

    clear() {
        try {
            if (fs.existsSync(this.fp)) fs.unlinkSync(this.fp);
        } catch (err) {
            console.error(`[world-model] clear failed: ${err.message}`);
        }
    }
}
