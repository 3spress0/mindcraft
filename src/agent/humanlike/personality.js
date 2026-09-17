// Personality profiles for the humanlike layer.
// A personality is a set of bounded trait values derived deterministically
// from a seed (typically the bot's name) plus an optional preset and
// overrides. Same seed -> same personality, so behavior is reproducible.

import { createRng, hashString } from './rng.js';

/** Trait definitions: key -> [min, max, default] */
export const TRAITS = {
    pace: [0.6, 1.4, 1.0],          // timing multiplier: <1 quicker, >1 more deliberate
    curiosity: [0.0, 1.0, 0.5],     // how often it glances at novel things
    caution: [0.0, 1.0, 0.4],       // pre-action focus/verification tendency
    restlessness: [0.0, 1.0, 0.25], // wandering during idle
    sociability: [0.0, 1.0, 0.5],   // attention weight on players vs mobs/items
    precision: [0.3, 1.0, 0.7]      // gaze steadiness: higher = less look-jitter
};

/** Presets bias trait generation. Values are targets the rng pulls toward. */
export const PRESETS = {
    default: {},
    curious: { curiosity: 0.85, sociability: 0.6, restlessness: 0.4 },
    cautious: { caution: 0.8, pace: 1.2, precision: 0.85, restlessness: 0.1 },
    energetic: { pace: 0.7, restlessness: 0.6, curiosity: 0.7 },
    laidback: { pace: 1.25, restlessness: 0.15, caution: 0.3, curiosity: 0.35 },
    social: { sociability: 0.9, curiosity: 0.65 },
    // social/risk-flavored profiles
    guardian: { caution: 0.85, sociability: 0.45, restlessness: 0.1, precision: 0.9, pace: 1.1 },
    greeter: { sociability: 0.95, curiosity: 0.75, restlessness: 0.3, pace: 0.9 },
    scout: { curiosity: 0.9, restlessness: 0.75, pace: 0.75, caution: 0.25 },
    worker: { precision: 0.9, caution: 0.6, sociability: 0.25, restlessness: 0.1, pace: 1.05 }
};

/** Risk posture presets: path profile + exploration appetite. */
export const RISK_PRESETS = {
    cautious: { path_profile: 'safe', explore_when_idle: false, description: 'hazard-aware paths, stays put when idle' },
    balanced: { path_profile: 'default', explore_when_idle: true, description: 'default paths, explores while idle' },
    bold: { path_profile: 'fast', explore_when_idle: true, description: 'fast paths (may dig), explores while idle' }
};

function clampTo(key, value) {
    const [lo, hi, def] = TRAITS[key] ?? [0, 1, 0.5];
    if (!Number.isFinite(value)) return def;
    return Math.min(hi, Math.max(lo, value));
}

/**
 * Create a personality.
 * @param {object} opts
 * @param {string|number} [opts.seed] - seed; defaults to hash of opts.name or 'mindcraft'.
 * @param {string} [opts.name] - bot name used to derive the seed when not given.
 * @param {string} [opts.preset] - one of PRESETS keys.
 * @param {object} [opts.overrides] - exact trait values (clamped to bounds).
 * @param {object} [opts.rng] - inject an rng for testing.
 */
export function createPersonality({ seed, name, preset = 'default', overrides = {}, rng = null } = {}) {
    const usedSeed = seed != null ? seed : hashString(name || 'mindcraft');
    const _rng = rng || createRng(usedSeed);
    const biases = PRESETS[preset] || {};

    const traits = {};
    for (const [key, [lo, hi, def]] of Object.entries(TRAITS)) {
        if (overrides[key] != null) { traits[key] = clampTo(key, overrides[key]); continue; }
        const bias = biases[key] != null ? biases[key] : def;
        // pull a noisy sample around the bias, bounded inside [lo, hi]
        const noise = (_rng.range(-1, 1)) * (hi - lo) * 0.18;
        traits[key] = clampTo(key, bias + noise);
    }

    return {
        seed: typeof usedSeed === 'string' ? hashString(usedSeed) : usedSeed >>> 0,
        preset,
        traits,
        rng: _rng,

        /**
         * Humanlike delay in ms within [min, max], triangular around a
         * typical value, scaled by pace (deliberate personalities wait longer).
         */
        delay(min, max) {
            const peak = min + (max - min) * 0.55;
            return Math.round(_rng.triangular(min, max, peak) * traits.pace);
        },
        /** True with probability p scaled by trait t (both in [0,1]). */
        tendency(p, trait = null) {
            const t = trait != null && traits[trait] != null ? traits[trait] : 0.5;
            const scaled = p * (0.3 + t);
            return _rng.chance(Math.min(1, Math.max(0, scaled)));
        },
        /** Small timing jitter around a nominal value (ms). */
        timing(nominalMs, spread = 0.25) {
            return Math.round(_rng.jitter(nominalMs, spread));
        },
        toJSON() {
            return { seed: this.seed, preset, traits };
        }
    };
}
