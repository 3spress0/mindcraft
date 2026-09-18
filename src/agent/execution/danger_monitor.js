import { scoreThreats } from '../autonomy/combat.js';
import { scanHazards, fallRiskAt } from '../navigation/hazards.js';

/** Deterministic safety sensor. It never asks the model to interpret danger. */
export class DangerMonitor {
    constructor({ bot, eventBus, pollMs = 250, threatRadius = 16, hazardRadius = 8, healthThreshold = 6 } = {}) {
        this.bot = bot;
        this.eventBus = eventBus;
        this.pollMs = Math.max(100, pollMs);
        this.threatRadius = threatRadius;
        this.hazardRadius = hazardRadius;
        this.healthThreshold = healthThreshold;
        this.timer = null;
        this.active = new Map();
        this.lastSnapshot = null;
    }

    _danger(key, severity, reason, data = {}) {
        return { key, severity, reason, ...data };
    }

    scan() {
        const bot = this.bot;
        const dangers = new Map();
        if (!bot?.entity?.position) return dangers;
        const health = Number(bot.health);
        if (Number.isFinite(health) && health > 0 && health <= this.healthThreshold) {
            dangers.set('health.low', this._danger('health.low', 'critical', 'low_health', { health }));
        }
        let threats = scoreThreats(bot, { radius: this.threatRadius }).threats;
        // Unit-test doubles and early-spawn adapters may expose plain position
        // objects rather than Vec3. Keep the monitor authoritative in both
        // cases instead of silently losing hostile-entity danger.
        if (!threats.length && typeof bot.entity.position.distanceTo !== 'function') {
            const origin = bot.entity.position;
            threats = Object.values(bot.entities ?? {}).flatMap(entity => {
                if (!entity?.position || !['mob', 'hostile'].includes(entity.type) && !/zombie|skeleton|creeper|spider|enderman|witch|phantom/i.test(entity.name ?? '')) return [];
                const dx = entity.position.x - origin.x;
                const dy = entity.position.y - origin.y;
                const dz = entity.position.z - origin.z;
                const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
                return dist <= this.threatRadius ? [{ name: entity.name, dist, score: 1 }] : [];
            });
        }
        for (const threat of threats.slice(0, 8)) {
            const key = `hostile:${threat.name}:${Math.round(threat.dist)}`;
            dangers.set(key, this._danger(key, threat.dist <= 5 ? 'high' : 'medium', 'hostile_entity', {
                entity: threat.name, distance: threat.dist, score: threat.score,
            }));
        }
        for (const hazard of scanHazards(bot, { radius: this.hazardRadius, includeSoft: false })) {
            const key = `hazard:${hazard.name}:${hazard.x},${hazard.y},${hazard.z}`;
            dangers.set(key, this._danger(key, hazard.tier === 'hard' ? 'high' : 'medium', hazard.name, {
                block: hazard.name, position: { x: hazard.x, y: hazard.y, z: hazard.z }, distance: hazard.dist,
            }));
        }
        try {
            const feet = bot.blockAt(bot.entity.position, false);
            const head = bot.blockAt({ x: bot.entity.position.x, y: bot.entity.position.y + 1, z: bot.entity.position.z }, false);
            if (feet?.name === 'lava' || feet?.name === 'fire' || head?.name === 'lava' || head?.name === 'fire') {
                dangers.set('environment:fire', this._danger('environment:fire', 'critical', 'fire_or_lava'));
            }
            const headName = head?.name ?? '';
            if (headName === 'water' || headName === 'bubble_column') {
                const air = Number(bot.air ?? bot.oxygenLevel ?? 20);
                if (air <= 8 || Number(bot.oxygenLevel) <= 5) dangers.set('environment:drowning', this._danger('environment:drowning', 'critical', 'drowning', { air }));
            }
            const body = bot.blockAt(bot.entity.position, false);
            if (body && !['air', 'cave_air', 'water', 'lava'].includes(body.name) && body.name !== 'powder_snow') {
                dangers.set('environment:suffocation', this._danger('environment:suffocation', 'critical', 'suffocation', { block: body.name }));
            }
        } catch { /* world may be incomplete during spawn */ }
        try {
            const fall = fallRiskAt(bot, bot.entity.position, { maxCheck: 16 });
            if (fall.risk === 'lethal' || fall.risk === 'void') dangers.set('environment:void', this._danger('environment:void', 'critical', fall.risk, { drop: fall.drop }));
        } catch { /* optional sensor */ }
        return dangers;
    }

    async tick() {
        const next = this.scan();
        for (const [key, danger] of next) {
            if (!this.active.has(key)) await this.eventBus?.publish('danger.detected', danger, { source: 'danger-monitor' });
        }
        for (const [key, danger] of this.active) {
            if (!next.has(key)) await this.eventBus?.publish('danger.cleared', { ...danger, key }, { source: 'danger-monitor' });
        }
        this.active = next;
        this.lastSnapshot = [...next.values()];
        return this.lastSnapshot;
    }

    start() {
        if (this.timer) return this;
        this.timer = setInterval(() => this.tick().catch(() => {}), this.pollMs);
        void this.tick();
        return this;
    }

    stop() {
        if (this.timer) clearInterval(this.timer);
        this.timer = null;
        this.active.clear();
    }

    snapshot() {
        return { active: [...this.active.values()], lastScan: this.lastSnapshot };
    }
}
