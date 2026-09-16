import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRng, hashString, mulberry32, sleep } from '../src/agent/humanlike/rng.js';

describe('humanlike rng', () => {
    it('hashString is deterministic and 32-bit', () => {
        assert.equal(hashString('mindcraft'), hashString('mindcraft'));
        assert.notEqual(hashString('mindcraft'), hashString('mindcrafu'));
        const h = hashString('some bot name');
        assert.ok(h >= 0 && h <= 0xFFFFFFFF);
        assert.ok(Number.isInteger(h));
    });

    it('same seed produces identical sequences', () => {
        const a = createRng('bot-1');
        const b = createRng('bot-1');
        for (let i = 0; i < 50; i++) assert.equal(a.next(), b.next());
    });

    it('different seeds diverge', () => {
        const a = createRng('bot-1');
        const b = createRng('bot-2');
        let same = 0;
        for (let i = 0; i < 20; i++) if (a.next() === b.next()) same++;
        assert.ok(same < 5, 'sequences should differ');
    });

    it('next() stays in [0, 1)', () => {
        const rng = createRng(42);
        for (let i = 0; i < 2000; i++) {
            const v = rng.next();
            assert.ok(v >= 0 && v < 1);
        }
    });

    it('range/int are hard-bounded', () => {
        const rng = createRng(7);
        for (let i = 0; i < 2000; i++) {
            const r = rng.range(2.5, 3.5);
            assert.ok(r >= 2.5 && r <= 3.5);
            const n = rng.int(-2, 3);
            assert.ok(Number.isInteger(n) && n >= -2 && n <= 3);
        }
        assert.throws(() => rng.range(5, 2), /Invalid bounds/);
    });

    it('chance respects 0 and 1', () => {
        const rng = createRng(9);
        for (let i = 0; i < 100; i++) {
            assert.equal(rng.chance(0), false);
            assert.equal(rng.chance(1), true);
        }
        // out-of-range p is clamped, not a crash
        assert.equal(rng.chance(-1), false);
        assert.equal(rng.chance(2), true);
    });

    it('pick handles arrays and empties', () => {
        const rng = createRng(3);
        const arr = ['a', 'b', 'c'];
        for (let i = 0; i < 50; i++) assert.ok(arr.includes(rng.pick(arr)));
        assert.equal(rng.pick([]), undefined);
        assert.equal(rng.pick(null), undefined);
    });

    it('triangular stays in bounds and clusters near peak', () => {
        const rng = createRng(11);
        let sum = 0;
        const N = 3000;
        for (let i = 0; i < N; i++) {
            const v = rng.triangular(100, 300, 220);
            assert.ok(v >= 100 && v <= 300);
            sum += v;
        }
        const mean = sum / N;
        assert.ok(Math.abs(mean - 200) < 20, `mean ${mean} should sit near the triangular midpoint`);
    });

    it('jitter is bounded by spread', () => {
        const rng = createRng(13);
        for (let i = 0; i < 1000; i++) {
            const v = rng.jitter(1000, 0.2);
            assert.ok(v >= 800 && v <= 1200);
        }
        // spread is clamped at 0.9
        const big = rng.jitter(100, 5);
        assert.ok(big >= 10 && big <= 190);
    });

    it('bell stays clamped to its bounds', () => {
        const rng = createRng(17);
        for (let i = 0; i < 2000; i++) {
            const v = rng.bell(500, 100, 400, 600);
            assert.ok(v >= 400 && v <= 600);
        }
    });

    it('mulberry32 is a pure function of its seed', () => {
        const g1 = mulberry32(12345);
        const g2 = mulberry32(12345);
        for (let i = 0; i < 10; i++) assert.equal(g1(), g2());
    });

    it('sleep resolves and respects the cap', async () => {
        const start = Date.now();
        const ok = await sleep(30);
        assert.equal(ok, true);
        assert.ok(Date.now() - start >= 25);
        // interrupt flag surfaces as false
        const fakeBot = { interrupt_code: 1 };
        const ok2 = await sleep(5, fakeBot);
        assert.equal(ok2, false);
    });
});
