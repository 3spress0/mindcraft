/**
 * world_config.js — per-world configuration (GO list: per-world
 * configuration).
 *
 * settings.worlds can carry overrides keyed by server host ("localhost",
 * "play.example.org") plus an "any" entry applied everywhere. Matching
 * entries are deep-merged over the base settings so one world can, say,
 * disable autonomous exploration while everything else stays identical.
 */

import settings from '../../../settings.js';

/** Deep-merge plain objects (arrays and scalars replace). */
export function deepMerge(base, override) {
    if (override == null) return base;
    if (typeof base !== 'object' || Array.isArray(base) || base == null) return override;
    if (typeof override !== 'object' || Array.isArray(override)) return override;
    const out = { ...base };
    for (const key of Object.keys(override)) {
        out[key] = key in base ? deepMerge(base[key], override[key]) : override[key];
    }
    return out;
}

/** The server host for an agent (from settings or the live bot). */
export function worldHost(agent) {
    try {
        return agent?.bot?.host ?? settings.host ?? null;
    } catch {
        return settings.host ?? null;
    }
}

/**
 * Settings with per-world overrides applied. Returns a merged object; the
 * base settings module is never mutated.
 */
export function worldSettings(agent) {
    const worlds = settings.worlds;
    if (!worlds || typeof worlds !== 'object') return settings;
    const host = worldHost(agent);
    let merged = settings;
    if (worlds.any) merged = deepMerge(merged, worlds.any);
    if (host && worlds[host]) merged = deepMerge(merged, worlds[host]);
    return merged;
}
