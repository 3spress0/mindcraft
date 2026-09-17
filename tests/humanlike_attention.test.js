import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Vec3 } from 'vec3';
import { AttentionTracker, glance } from '../src/agent/humanlike/attention.js';
import { createPersonality } from '../src/agent/humanlike/personality.js';

function mockBot({ wall = false } = {}) {
    const looks = [];
    return {
        looks,
        entity: { position: new Vec3(0, 64, 0), yaw: 0.4, pitch: -0.1 },
        players: {
            alice: {
                username: 'alice',
                entity: { id: 7, type: 'player', name: 'alice', position: new Vec3(5, 64, 3) }
            }
        },
        objectModeMap: () => ({
            12: { id: 12, type: 'mob', name: 'zombie', position: new Vec3(-3, 64, 2) }
        }),
        blockAt: (p) => {
            if (wall && p.x > 1 && p.x < 4.5) return { name: 'stone', boundingBox: 'block' };
            return { name: 'air', boundingBox: 'empty' };
        },
        look: async (yaw, pitch, force) => { looks.push({ yaw, pitch, force }); }
    };
}

describe('humanlike attention tracker', () => {
    it('detects visible players and mobs as novel on first sight', () => {
        let now = 1000;
        const tracker = new AttentionTracker(() => now);
        const bot = mockBot();
        const sights = tracker.scan(bot, { range: 24 });
        assert.equal(sights.length, 2);
        assert.ok(sights.every(s => s.isNew));
        const kinds = sights.map(s => s.kind).sort();
        assert.deepEqual(kinds, ['mob', 'player']);
    });

    it('marks repeated sightings as not novel, and reappearing after expiry', () => {
        let now = 1000;
        const tracker = new AttentionTracker(() => now);
        const bot = mockBot();
        tracker.scan(bot);
        now += 5000;
        const second = tracker.scan(bot);
        assert.ok(second.every(s => !s.isNew && !s.isReappearing));
        now += 70000; // past the 60s seen-TTL
        const third = tracker.scan(bot);
        assert.ok(third.some(s => s.isReappearing));
    });

    it('line-of-sight gates sightings (no staring through walls)', () => {
        const tracker = new AttentionTracker();
        const bot = mockBot({ wall: true });
        const sights = tracker.scan(bot, { range: 24 });
        // the player at x=5 is behind the stone wall between x=1..4.5
        assert.ok(!sights.some(s => s.kind === 'player'));
        // the mob at x=-3 is on this side of the wall
        assert.ok(sights.some(s => s.kind === 'mob'));
    });

    it('respects range', () => {
        const tracker = new AttentionTracker();
        const bot = mockBot();
        assert.equal(tracker.scan(bot, { range: 3 }).length, 0);
        assert.ok(tracker.scan(bot, { range: 24 }).length >= 2);
    });

    it('novelSights filters to new/reappearing only', () => {
        const tracker = new AttentionTracker();
        const bot = mockBot();
        assert.ok(tracker.novelSights(bot).length >= 2);
        assert.equal(tracker.novelSights(bot).length, 0);
    });

    it('lastSeen finds players by name', () => {
        const tracker = new AttentionTracker();
        const bot = mockBot();
        tracker.scan(bot);
        const rec = tracker.lastSeen('alice');
        assert.ok(rec);
        assert.equal(rec.kind, 'player');
        assert.equal(tracker.lastSeen('nobody'), null);
    });

    it('records events and expires them', () => {
        let now = 0;
        const tracker = new AttentionTracker(() => now);
        tracker.recordEvent(10, 65, -4, 'explosion');
        const e = tracker.freshEvent();
        assert.ok(e);
        assert.equal(e.kind, 'explosion');
        assert.deepEqual([e.x, e.y, e.z], [10, 65, -4]);
        now += 10000;
        assert.equal(tracker.freshEvent(), null);
    });

    it('summarize counts recently seen kinds', () => {
        const tracker = new AttentionTracker();
        const bot = mockBot();
        tracker.scan(bot);
        const s = tracker.summarize();
        assert.equal(s.players, 1);
        assert.equal(s.mobs, 1);
        assert.equal(s.items, 0);
    });

    it('never double-counts entities returned by multiple sources', () => {
        const tracker = new AttentionTracker();
        const bot = mockBot();
        // alice's entity also shows up in objectModeMap
        bot.objectModeMap = () => ({
            7: bot.players.alice.entity,
            12: { id: 12, type: 'mob', name: 'zombie', position: new Vec3(-3, 64, 2) }
        });
        const sights = tracker.scan(bot);
        assert.equal(sights.filter(s => s.name === 'alice').length, 1);
    });
});

describe('humanlike glance', () => {
    it('looks toward the target with bounded dwell and no forced look', async () => {
        const bot = mockBot();
        const personality = createPersonality({ name: 'Glancey' });
        const res = await glance(bot, { x: 5, y: 64, z: 3 }, personality, { minDwellMs: 100, maxDwellMs: 300 });
        assert.equal(bot.looks.length, 1);
        assert.equal(bot.looks[0].force, false);
        assert.ok(res.dwellMs >= 100 * 0.6 - 1, `dwell ${res.dwellMs} below pace-scaled floor`);
        assert.ok(res.dwellMs <= 300 * 1.4 + 1, `dwell ${res.dwellMs} above pace-scaled ceiling`);
        // yaw should roughly point at +x/+z target: yaw = atan2(-dx, dz) ~ atan2(-5,3)
        const expectedYaw = Math.atan2(-5, 3);
        assert.ok(Math.abs(res.yaw - expectedYaw) < 0.4, `yaw ${res.yaw} not near ${expectedYaw}`);
    });

    it('is deterministic for a fixed personality', async () => {
        const bot = mockBot();
        const p1 = createPersonality({ name: 'Same' });
        const p2 = createPersonality({ name: 'Same' });
        const r1 = await glance(bot, { x: 2, y: 64, z: 2 }, p1);
        const r2 = await glance(bot, { x: 2, y: 64, z: 2 }, p2);
        assert.equal(r1.yaw, r2.yaw);
        assert.equal(r1.pitch, r2.pitch);
        assert.equal(r1.dwellMs, r2.dwellMs);
    });

    it('returns null without an entity position', async () => {
        const res = await glance({}, { x: 1, y: 1, z: 1 }, createPersonality({ name: 'x' }));
        assert.equal(res, null);
    });
});
