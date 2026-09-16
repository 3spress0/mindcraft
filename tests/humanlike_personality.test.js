import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createPersonality, TRAITS, PRESETS } from '../src/agent/humanlike/personality.js';

describe('humanlike personality', () => {
    it('derives a stable seed from the bot name', () => {
        const p1 = createPersonality({ name: 'Frostbite' });
        const p2 = createPersonality({ name: 'Frostbite' });
        assert.equal(p1.seed, p2.seed);
        assert.deepEqual(p1.traits, p2.traits);
        const p3 = createPersonality({ name: 'Ember' });
        assert.notDeepEqual(p1.traits, p3.traits);
    });

    it('all traits stay within their declared bounds', () => {
        for (let i = 0; i < 40; i++) {
            const p = createPersonality({ name: `bot-${i}` });
            for (const [key, [lo, hi]] of Object.entries(TRAITS)) {
                const v = p.traits[key];
                assert.ok(v >= lo && v <= hi, `${key}=${v} outside [${lo},${hi}]`);
            }
        }
    });

    it('presets bias traits toward their targets', () => {
        let curiousTotal = 0, cautiousTotal = 0;
        const N = 30;
        for (let i = 0; i < N; i++) {
            curiousTotal += createPersonality({ name: `c${i}`, preset: 'curious' }).traits.curiosity;
            cautiousTotal += createPersonality({ name: `c${i}`, preset: 'cautious' }).traits.caution;
        }
        assert.ok(curiousTotal / N > 0.65, 'curious preset should be curious');
        assert.ok(cautiousTotal / N > 0.6, 'cautious preset should be cautious');
        assert.ok(Object.keys(PRESETS).includes('laidback'));
        assert.ok(Object.keys(PRESETS).includes('social'));
        assert.ok(Object.keys(PRESETS).includes('energetic'));
    });

    it('overrides win and get clamped to bounds', () => {
        const p = createPersonality({
            name: 'x',
            overrides: { curiosity: 0.95, caution: 99, pace: -5 }
        });
        assert.equal(p.traits.curiosity, 0.95);
        assert.equal(p.traits.caution, TRAITS.caution[1]);
        assert.equal(p.traits.pace, TRAITS.pace[0]);
    });

    it('delay() is bounded by [min,max]*pace and reproducible', () => {
        const p1 = createPersonality({ name: 'Digger' });
        const p2 = createPersonality({ name: 'Digger' });
        for (let i = 0; i < 200; i++) {
            const d1 = p1.delay(100, 400);
            const d2 = p2.delay(100, 400);
            assert.equal(d1, d2);
            const hi = 400 * TRAITS.pace[1] + 1;
            assert.ok(d1 >= 100 * TRAITS.pace[0] - 1 && d1 <= hi, `delay ${d1} out of envelope`);
        }
    });

    it('timing() jitters within the bounded spread', () => {
        const p = createPersonality({ name: 'Clock' });
        for (let i = 0; i < 200; i++) {
            const t = p.timing(1000, 0.25);
            assert.ok(t >= 750 && t <= 1250, `timing ${t} out of jitter bounds`);
        }
    });

    it('tendency() is deterministic for a seed', () => {
        const p1 = createPersonality({ name: 'T' });
        const p2 = createPersonality({ name: 'T' });
        for (let i = 0; i < 50; i++) {
            assert.equal(p1.tendency(0.5, 'curiosity'), p2.tendency(0.5, 'curiosity'));
        }
    });

    it('toJSON captures the identity', () => {
        const p = createPersonality({ name: 'J', preset: 'cautious' });
        const j = p.toJSON();
        assert.equal(j.preset, 'cautious');
        assert.equal(j.seed, p.seed);
        assert.deepEqual(j.traits, p.traits);
    });
});
