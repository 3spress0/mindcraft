/**
 * patrol.js — patrol behavior (GO list: patrol behavior).
 *
 * The bot walks a loop between known places — mental map POIs, home, named
 * storage spots — either on demand (!patrol) or as an idle autonomy need
 * when settings.autonomy.needs.patrol_pois names the stops.
 *
 * Bounded legs, interrupt-aware, risk-checked per leg (the loop is aborted
 * when the local situation turns dangerous), and reproducible against the
 * bot's own spatial memory.
 */

import { getMentalMap } from '../memory/mental_map.js';
import { getHome } from '../navigation/home.js';
import { assessLocalRisk } from './risk.js';

/**
 * Resolve patrol stop names into concrete waypoints.
 * Special names: 'home' -> the home waypoint.
 * @returns {{stops: Array<{name, x, y, z}>, missing: string[]}}
 */
export function resolvePatrolStops(agent, names) {
    const map = getMentalMap(agent);
    const stops = [];
    const missing = [];
    for (const raw of names ?? []) {
        const name = String(raw ?? '').trim();
        if (!name) continue;
        if (name.toLowerCase() === 'home') {
            let home = null;
            try { home = getHome(agent); } catch { home = null; }
            if (home) stops.push({ name: 'home', x: home.x, y: home.y, z: home.z });
            else missing.push(name);
            continue;
        }
        const poi = map?.get?.(name);
        if (poi) stops.push({ name: poi.name, x: poi.x, y: poi.y, z: poi.z });
        else missing.push(name);
    }
    return { stops, missing };
}

/**
 * Execute one patrol round: visit each stop in order (and return to the
 * first to close the loop). Each leg is risk-checked before it starts.
 * @returns {Promise<string>} human-readable summary
 */
export async function executePatrol(agent, { stops = null, maxLegs = 8 } = {}) {
    const bot = agent?.bot;
    if (!bot) return 'patrol: no bot';
    if (!Array.isArray(stops) || stops.length < 2) {
        return 'patrol: need at least two stops (POI names or "home")';
    }

    const skills = await import('../library/skills.js');
    const legs = Math.min(stops.length + 1, Math.max(2, maxLegs)); // +1 closes the loop
    let visited = 0;
    for (let i = 0; i < legs; i++) {
        if (bot.interrupt_code) break;
        // never start a leg into known danger
        try {
            const risk = assessLocalRisk(bot, { posture: bot._risk_profile });
            if (risk.level === 'high') return `patrol: held at stop ${visited} — ${risk.hostiles.length} hostile(s) near`;
        } catch { /* risk check is best-effort */ }
        const stop = stops[i % stops.length];
        try {
            await skills.goToPosition(bot, stop.x, stop.y, stop.z, 3);
            visited++;
        } catch {
            return `patrol: could not reach "${stop.name}" (leg ${i + 1})`;
        }
    }
    const closed = visited > stops.length ? 'closed loop' : 'partial round';
    return `patrol: visited ${visited}/${legs} leg(s) (${closed})`;
}

/**
 * Patrol executor for the autonomy loop: uses the configured stop names.
 */
export async function executePatrolNeed(agent, need, cfg = {}) {
    const names = cfg.patrol_pois ?? [];
    const { stops, missing } = resolvePatrolStops(agent, names);
    if (missing.length) return `patrol: unknown stop(s): ${missing.join(', ')} (see !pois)`;
    if (stops.length < 2) return 'patrol: configure at least two patrol_pois';
    return executePatrol(agent, { stops, maxLegs: Math.max(2, Math.min(12, stops.length + 1)) });
}
