// Seeded, bounded randomness for the humanlike behavior layer.
//
// Architectural rule: randomness must live here (and in personality.js), never
// scattered as bare Math.random() inside skills or commands. Every helper is
// deterministic for a given seed and hard-bounded so behavior stays reliable.

const HASH_OFFSET = 0x811c9dc5;
const HASH_PRIME = 0x01000193;

/** FNV-1a hash of a string into an unsigned 32-bit integer (seed factory). */
export function hashString(str) {
    let h = HASH_OFFSET >>> 0;
    const s = String(str ?? '');
    for (let i = 0; i < s.length; i++) {
        h ^= s.charCodeAt(i);
        h = Math.imul(h, HASH_PRIME) >>> 0;
    }
    return h >>> 0;
}

/** mulberry32 — small, fast, seedable PRNG returning [0, 1). */
export function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
        a = (a + 0x6D2B79F5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

function assertBounds(min, max) {
    if (!(Number.isFinite(min) && Number.isFinite(max)) || min > max)
        throw new Error(`Invalid bounds: [${min}, ${max}]`);
}

/**
 * Create a seeded RNG with bounded sampling helpers.
 * @param {number|string} seed - numeric seed or string hashed via FNV-1a.
 */
export function createRng(seed) {
    const numericSeed = typeof seed === 'string' ? hashString(seed) : (Number.isFinite(seed) ? seed >>> 0 : 0);
    const next = mulberry32(numericSeed);

    return {
        seed: numericSeed,
        /** Next uniform float in [0, 1). */
        next,
        /** Uniform float in [min, max]. */
        range(min, max) {
            assertBounds(min, max);
            return min + (max - min) * next();
        },
        /** Uniform integer in [min, max] inclusive. */
        int(min, max) {
            assertBounds(min, max);
            return Math.floor(min + (max - min + 1) * next());
        },
        /** True with probability p in [0, 1]. */
        chance(p) {
            const cp = Math.min(1, Math.max(0, p));
            return next() < cp;
        },
        /** Pick a random element from a non-empty array (or undefined). */
        pick(arr) {
            if (!Array.isArray(arr) || arr.length === 0) return undefined;
            return arr[Math.floor(next() * arr.length)];
        },
        /**
         * Triangular distribution on [min, max] peaking at `peak` (default midpoint).
         * Natural for delays: values cluster around a typical value but vary.
         */
        triangular(min, max, peak) {
            assertBounds(min, max);
            const p = peak == null ? (min + max) / 2 : Math.min(max, Math.max(min, peak));
            const u = next();
            const fc = (p - min) / (max - min || 1);
            if (u < fc) return min + Math.sqrt(u * (max - min) * (p - min));
            return max - Math.sqrt((1 - u) * (max - min) * (max - p));
        },
        /**
         * Multiply `value` by a factor in [1 - spread, 1 + spread].
         * spread is clamped to [0, 0.9] so output stays close to the input.
         */
        jitter(value, spread) {
            const s = Math.min(0.9, Math.max(0, spread));
            return value * (1 + (next() * 2 - 1) * s);
        },
        /**
         * Rough bell curve: mean of two uniforms, hard clamped to [lo, hi].
         * Good enough for humanlike timing; fully bounded and reproducible.
         */
        bell(mean, sd, lo, hi) {
            const u = (next() + next()) / 2; // triangular-ish on [0,1]
            const v = mean + (u - 0.5) * 2 * sd * 1.732; // approx spread of ±1 sd
            const low = lo == null ? mean - 3 * sd : lo;
            const high = hi == null ? mean + 3 * sd : hi;
            return Math.min(high, Math.max(low, v));
        }
    };
}

/** Sleep helper honoring bot interruption between checks. */
export function sleep(ms, bot = null) {
    const t = Math.max(0, Math.min(10000, Math.round(ms)));
    return new Promise(resolve => {
        setTimeout(() => resolve(), t);
    }).then(() => {
        // if the bot has been interrupted while sleeping, surface it cheaply
        if (bot && bot.interrupt_code) return false;
        return true;
    });
}
