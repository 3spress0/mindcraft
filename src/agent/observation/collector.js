/**
 * collector.js — Minecraft event -> WorldModel bridge.
 *
 * This is the ONLY place in the planning/world-model stack that listens to
 * mineflayer events or inspects bot.entities. The runner and planner stay
 * minecraft-free: they consume the pure WorldModel. Facts discovered when a
 * plan step verifies are added via ingest.js (also minecraft-free, working
 * from observer captures).
 *
 * Tracked live:
 *   - player position / health / hunger / dimension (throttled)
 *   - nearby mobs/npcs/players -> entity/threat facts with TTLs
 *   - dropped item entities    -> short-lived resource facts
 *   - death position           -> durable location fact
 *   - time-based confidence decay and expiry pruning
 *
 * The collector is driven by bot events plus a throttled tick() the agent
 * update loop calls (~every 300ms).
 */

import settings from '../settings.js';
import { CATEGORY, SOURCE } from '../world_model/world_model.js';
import { classifyEntityLike } from './classify.js';

export class ObservationCollector {
    constructor(agent, model, { store = null } = {}) {
        this.agent = agent;
        this.model = model;
        this.store = store;
        this.bot = null;
        this.bound = false;
        this.handlers = [];
        this.spawnCount = 0;
        this.lastPlayerRefresh = 0;
        this.lastScan = 0;
        this.lastSave = 0;
    }

    config() {
        return {
            enabled: true,
            entity_radius: 48,
            player_refresh_ms: 2000,
            scan_interval_ms: 5000,
            save_interval_ms: 15_000,
            threat_ttl_ms: 120_000,
            entity_ttl_ms: 600_000,
            item_ttl_ms: 30_000,
            confidence_floor: 0.15,
            volatile_half_life_ms: 120_000,
            ...(settings.world_model || {}),
        };
    }

    attach(bot = this.agent?.bot) {
        if (!bot || this.bound) return;
        this.bot = bot;
        const on = (event, fn) => {
            bot.on(event, fn);
            this.handlers.push([event, fn]);
        };

        on('spawn', () => this.onSpawn());
        on('death', () => this.onDeath());
        on('entitySpawn', (entity) => this.onEntity(entity, 'spawned'));
        on('entityGone', (entity) => this.onEntityGone(entity));
        on('entityHurt', (entity) => this.onEntityHurt(entity));
        this.bound = true;
        this.refreshPlayer();
    }

    detach() {
        if (!this.bot || !this.bound) return;
        for (const [event, fn] of this.handlers) {
            try { this.bot.off(event, fn); } catch { /* shutdown race */ }
        }
        this.handlers = [];
        this.bound = false;
        this.saveNow();
    }

    // ---------- throttled update (agent.update drives this) ----------

    tick() {
        if (!this.bound) return;
        const cfg = this.config();
        if (!cfg.enabled) return;
        const now = Date.now();
        if (now - this.lastPlayerRefresh >= cfg.player_refresh_ms) {
            this.lastPlayerRefresh = now;
            this.refreshPlayer();
        }
        if (now - this.lastScan >= cfg.scan_interval_ms) {
            this.lastScan = now;
            this.scanEntities();
            this.model.tick(now, {
                halfLifeMs: cfg.volatile_half_life_ms,
                confidenceFloor: cfg.confidence_floor,
            });
        }
        if (this.store && now - this.lastSave >= cfg.save_interval_ms) {
            if (this.store.save(this.model, { minIntervalMs: cfg.save_interval_ms })) {
                this.lastSave = now;
            }
        }
    }

    saveNow() {
        if (this.store) this.lastSave = this.store.save(this.model, { force: true }) ? Date.now() : this.lastSave;
    }

    // ---------- player / world ----------

    refreshPlayer() {
        const bot = this.bot || this.agent?.bot;
        if (!bot?.entity) return;
        const pos = bot.entity.position;
        this.model.recordPlayer({
            position: { x: pos.x, y: pos.y, z: pos.z },
            health: bot.health,
            food: bot.food,
            dimension: bot.game?.dimension,
        });
    }

    onSpawn() {
        this.spawnCount += 1;
        // A respawn means the world around us changed; stale threats are invalid.
        if (this.spawnCount > 1) {
            for (const f of [...this.model.all(CATEGORY.THREAT)]) this.model.remove(CATEGORY.THREAT, f.id);
        }
        this.refreshPlayer();
        this.scanEntities();
        this.saveNow();
    }

    onDeath() {
        const bot = this.bot || this.agent?.bot;
        const pos = bot?.entity?.position;
        if (pos) {
            this.model.record(CATEGORY.LOCATION, {
                name: 'last_death_position',
                kind: 'death',
                pos: { x: pos.x, y: pos.y, z: pos.z },
                dimension: bot.game?.dimension,
                detail: { at: new Date().toISOString() },
                source: SOURCE.OBSERVED,
            });
        }
        for (const f of [...this.model.all(CATEGORY.THREAT)]) this.model.remove(CATEGORY.THREAT, f.id);
        this.model.recordPlayer({ health: 0 });
        this.saveNow();
    }

    /** Full sweep of loaded entities (mineflayer already tracks these). */
    scanEntities() {
        const bot = this.bot || this.agent?.bot;
        const cfg = this.config();
        if (!bot?.entities || !bot.entity) return;
        const myPos = bot.entity.position;
        for (const entity of Object.values(bot.entities)) {
            if (!entity || entity.id === bot.entity.id || !entity.position) continue;
            const d = entity.position.distanceTo(myPos);
            if (d > cfg.entity_radius) continue;
            this.recordEntity(entity, { distance: d });
        }
    }

    onEntity(entity) {
        if (!entity) return;
        this.recordEntity(entity);
    }

    recordEntity(entity, { distance: d = null } = {}) {
        const cfg = this.config();
        const cls = classifyEntityLike(entity.name || entity.mobType, entity.type);
        if (!cls.category) return;
        const pos = entity.position ? { x: entity.position.x, y: entity.position.y, z: entity.position.z } : null;
        const base = {
            name: entity.displayName || entity.username || entity.name || cls.kind,
            kind: cls.kind,
            pos,
            dimension: this.bot?.game?.dimension,
            source: SOURCE.OBSERVED,
        };
        if (cls.category === 'threat') {
            this.model.record(CATEGORY.THREAT, base, { expiresIn: cfg.threat_ttl_ms });
        } else if (cls.category === 'entity') {
            const key = cls.kind === 'player' && entity.username
                ? `player:${entity.username}`
                : undefined;
            this.model.record(CATEGORY.ENTITY, { ...base, key }, { expiresIn: cfg.entity_ttl_ms });
        } else if (cls.category === 'resource') {
            const item = this.readDroppedItem(entity);
            if (!item) return;
            this.model.record(CATEGORY.RESOURCE, {
                name: item.name,
                kind: 'ground_item',
                pos,
                dimension: base.dimension,
                detail: { count: item.count, dropped: true, distance: d == null ? undefined : Math.round(d) },
                source: SOURCE.OBSERVED,
            }, { expiresIn: cfg.item_ttl_ms });
        }
    }

    /** Best-effort dropped-item name across mineflayer versions (metadata slot). */
    readDroppedItem(entity) {
        try {
            const stack = entity.metadata?.[8] || entity.metadata?.[7];
            if (stack && (stack.name || stack.displayName)) {
                return {
                    name: String(stack.name || stack.displayName).replace(/\s+/g, '_'),
                    count: Number(stack.count) || 1,
                };
            }
        } catch { /* metadata layout differs by version */ }
        return null;
    }

    onEntityGone(entity) {
        if (!entity) return;
        const cls = classifyEntityLike(entity.name || entity.mobType, entity.type);
        const cfg = this.config();
        const now = Date.now();
        if (cls.category === 'resource') {
            // Dropped items vanish quickly (picked up / despawned / merged).
            for (const f of this.model.find(CATEGORY.RESOURCE, (f) => f.kind === 'ground_item')) {
                if (entity.position && f.pos &&
                    Math.abs(f.pos.x - Math.round(entity.position.x)) <= 1 &&
                    Math.abs(f.pos.z - Math.round(entity.position.z)) <= 1) {
                    f.expiresAt = now + 1000;
                }
            }
            return;
        }
        const category = cls.category === 'threat' ? CATEGORY.THREAT : (cls.category === 'entity' ? CATEGORY.ENTITY : null);
        if (!category) return;
        const ttl = category === CATEGORY.THREAT ? cfg.threat_ttl_ms : cfg.entity_ttl_ms;
        const name = entity.displayName || entity.username || entity.name;
        for (const f of this.model.find(category, (f) => f.name === name && f.confidence > 0.2)) {
            // Let decay/expiry handle it naturally; leaving range is not proof it despawned.
            f.expiresAt = now + ttl;
        }
    }

    onEntityHurt(entity) {
        const bot = this.bot || this.agent?.bot;
        if (!bot?.entity || entity !== bot.entity) return;
        // Attribute the damage to the nearest known/visible hostile, if any.
        let nearest = null;
        let nearestD = 8;
        for (const other of Object.values(bot.entities || {})) {
            if (!other?.position || other.id === bot.entity.id) continue;
            const cls = classifyEntityLike(other.name || other.mobType, other.type);
            if (cls.category !== 'threat') continue;
            const d = other.position.distanceTo(bot.entity.position);
            if (d < nearestD) { nearest = other; nearestD = d; }
        }
        if (nearest) {
            this.model.record(CATEGORY.THREAT, {
                name: nearest.displayName || nearest.name,
                kind: nearest.name,
                pos: { x: nearest.position.x, y: nearest.position.y, z: nearest.position.z },
                detail: { attackedBot: true },
                source: SOURCE.OBSERVED,
            }, { expiresIn: this.config().threat_ttl_ms });
        }
        this.refreshPlayer();
    }
}
