/**
 * danger.js — legit danger awareness for the AI context (GO list: feed
 * monsters/danger into the LLM).
 *
 * Collects everything that could hurt the bot — hostile mobs with threat
 * scores, local hazards (lava, fire, berries...), darkness/underground
 * state, and the autonomy risk assessment — into one compact, bounded
 * summary. All of it is server-reported data a player could see; nothing
 * here reads packets the bot shouldn't have.
 */

import { scoreThreats } from '../autonomy/combat.js';
import { assessLocalRisk } from '../autonomy/risk.js';
import { scanHazards } from '../navigation/hazards.js';
import { isUnderground, lightLevelAt } from '../navigation/caves.js';

/**
 * Build a bounded danger summary for the LLM context. Never throws — any
 * broken sensor degrades to a missing field, never to a crash.
 * @param {object} bot
 * @param {object} [opts] { threatRadius, hazardRadius, maxThreats, maxHazards }
 * @returns {{risk: object, threats: Array, hazardCount: number, hazards: Array,
 *            underground: boolean, light: number|null}}
 */
export function dangerSummary(bot, { threatRadius = 16, hazardRadius = 12, maxThreats = 8, maxHazards = 6 } = {}) {
    const summary = {
        risk: { level: 'unknown', score: 0 },
        threats: [],
        threatTotal: 0,
        threatLevel: 'clear',
        hazards: [],
        hazardCount: 0,
        underground: false,
        light: null
    };
    if (!bot) return summary;

    try {
        const risk = assessLocalRisk(bot, { posture: bot._risk_profile ?? null });
        summary.risk = { level: risk.level, score: risk.score, posture: risk.posture };
    } catch { /* risk sensor optional */ }

    try {
        const scored = scoreThreats(bot, { radius: threatRadius });
        summary.threats = scored.threats.slice(0, maxThreats)
            .map(t => ({ name: t.name, dist: t.dist, score: t.score }));
        summary.threatTotal = scored.total;
        summary.threatLevel = scored.level;
        if (scored.threats.length > maxThreats) summary.threatsMore = scored.threats.length - maxThreats;
    } catch { /* threat sensor optional */ }

    try {
        const hazards = scanHazards(bot, { radius: hazardRadius }) ?? [];
        summary.hazardCount = hazards.length;
        // nearest first, dedupe by block name for a compact read
        const seen = new Map();
        for (const h of hazards) {
            const key = h.name;
            const dist = Math.round(Math.hypot(h.x - (bot.entity?.position?.x ?? 0), h.z - (bot.entity?.position?.z ?? 0)));
            if (!seen.has(key) || dist < seen.get(key).dist) seen.set(key, { name: key, dist, tier: h.tier ?? 'soft' });
        }
        summary.hazards = [...seen.values()]
            .sort((a, b) => a.dist - b.dist)
            .slice(0, maxHazards);
    } catch { /* hazard sensor optional */ }

    try { summary.underground = isUnderground(bot); } catch { /* optional */ }
    try {
        const pos = bot.entity?.position;
        if (pos) summary.light = lightLevelAt(bot, pos);
    } catch { /* optional */ }

    return summary;
}

/** One-paragraph human-readable digest (chat commands, logs, tests). */
export function dangerReport(bot, opts = {}) {
    const d = dangerSummary(bot, opts);
    const bits = [];
    bits.push(`risk ${d.risk.level} (${d.risk.score ?? 0})`);
    if (d.threats.length) {
        bits.push(`hostiles: ${d.threats.map(t => `${t.name} ${t.dist}m`).join(', ')} (score ${d.threatTotal}, ${d.threatLevel})`);
    } else {
        bits.push('no hostiles in range');
    }
    if (d.hazards.length) {
        bits.push(`hazards: ${d.hazards.map(h => `${h.name} ~${h.dist}m`).join(', ')}${d.hazardCount > d.hazards.length ? ` (+${d.hazardCount - d.hazards.length} more)` : ''}`);
    }
    if (d.underground) bits.push('underground');
    if (d.light != null && d.light <= 4) bits.push(`dark (light ${d.light})`);
    return bits.join('; ');
}
