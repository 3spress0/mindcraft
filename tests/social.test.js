import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import { PlayerLedger, TRUST, MAX_PLAYERS } from '../src/agent/social/player_ledger.js';
import {
    detectSocialEvents, ReactionGate, reactionMessage,
    APPROACH_DIST, DEPART_DIST, SIGHTING_RANGE
} from '../src/agent/social/reactions.js';
import { createPersonality } from '../src/agent/humanlike/personality.js';

const TMP = 'SocialTestBot';

describe('player ledger', () => {
    it('records sightings with distance and counts', () => {
        let now = 1000;
        const ledger = new PlayerLedger({ now: () => now });
        ledger.sight('Alice', { dist: 12.34 });
        now += 500;
        ledger.sight('alice', { dist: 8 }); // case-insensitive
        const e = ledger.get('ALICE');
        assert.equal(e.sightings, 2);
        assert.equal(e.lastSeen, 1500);
        assert.equal(e.firstSeen, 1000);
        assert.equal(e.lastDist, 8);
        assert.equal(e.trust, TRUST.NEUTRAL);
    });

    it('trust management and classification', () => {
        const ledger = new PlayerLedger({});
        assert.equal(ledger.classify('stranger'), 'unknown');
        ledger.sight('bob');
        assert.equal(ledger.classify('bob'), 'neutral');
        ledger.markFriend('bob', 'helped me build');
        assert.equal(ledger.classify('bob'), 'friend');
        assert.equal(ledger.get('bob').note, 'helped me build');
        ledger.markHostile('bob', 'griefed base');
        assert.equal(ledger.classify('bob'), 'hostile');
        // invalid trust values are ignored
        ledger.setTrust('bob', 'bestie');
        assert.equal(ledger.classify('bob'), 'hostile');
    });

    it('lists sorted by recency and filters by trust', () => {
        let now = 0;
        const ledger = new PlayerLedger({ now: () => now });
        ledger.sight('old');
        now += 100;
        ledger.sight('new');
        ledger.markFriend('old');
        const all = ledger.list();
        assert.deepEqual(all.map(e => e.name), ['new', 'old']);
        assert.deepEqual(ledger.list({ trust: 'friend' }).map(e => e.name), ['old']);
    });

    it('prunes to the cap keeping most recent', () => {
        let now = 0;
        const ledger = new PlayerLedger({ now: () => now });
        for (let i = 0; i < MAX_PLAYERS + 20; i++) {
            now += 1;
            ledger.sight(`player${i}`);
        }
        assert.ok(ledger.players.size <= MAX_PLAYERS);
        assert.ok(ledger.get(`player${MAX_PLAYERS + 19}`), 'newest survives');
        assert.equal(ledger.get('player0'), null, 'oldest pruned');
    });

    it('persists and reloads atomically', () => {
        try {
            const a = new PlayerLedger({ botName: TMP });
            a.sight('persist_me', { dist: 4 });
            a.markFriend('persist_me', 'test');
            assert.ok(a.persist());
            const b = new PlayerLedger({ botName: TMP }).load();
            const e = b.get('persist_me');
            assert.ok(e);
            assert.equal(e.trust, 'friend');
            assert.equal(e.note, 'test');
            assert.equal(e.sightings, 1);
        } finally {
            fs.rmSync(`bots/${TMP}`, { recursive: true, force: true });
        }
    });

    it('tolerates corrupt files', () => {
        try {
            fs.mkdirSync(`bots/${TMP}`, { recursive: true });
            fs.writeFileSync(`bots/${TMP}/player_ledger.json`, '{nope');
            const ledger = new PlayerLedger({ botName: TMP }).load();
            assert.equal(ledger.players.size, 0);
        } finally {
            fs.rmSync(`bots/${TMP}`, { recursive: true, force: true });
        }
    });

    it('summarize formats a report', () => {
        const ledger = new PlayerLedger({});
        assert.equal(ledger.summarize(), 'No players remembered yet.');
        ledger.sight('alice', { dist: 7 });
        ledger.markFriend('alice');
        const s = ledger.summarize();
        assert.match(s, /SOCIAL MEMORY \(1 player/);
        assert.match(s, /alice \[friend\]/);
        assert.match(s, /last at 7m/);
    });
});

describe('social event detection', () => {
    it('detects first sightings near and far', () => {
        const events = detectSocialEvents({}, { alice: 5, bob: 30 });
        const alice = events.filter(e => e.name === 'alice');
        assert.ok(alice.some(e => e.kind === 'first_sighting'));
        assert.ok(alice.some(e => e.kind === 'approach'), 'near sighting counts as approach');
        const bob = events.filter(e => e.name === 'bob');
        assert.deepEqual(bob.map(e => e.kind), ['first_sighting']);
    });

    it('detects threshold crossings as approach/depart', () => {
        const events = detectSocialEvents(
            { alice: APPROACH_DIST + 5, bob: 5 },
            { alice: APPROACH_DIST - 1, bob: DEPART_DIST + 5 }
        );
        assert.ok(events.some(e => e.kind === 'approach' && e.name === 'alice'));
        assert.ok(events.some(e => e.kind === 'depart' && e.name === 'bob'));
    });

    it('no events when nothing changes', () => {
        const snap = { alice: 5, bob: 20 };
        assert.deepEqual(detectSocialEvents(snap, { ...snap }), []);
    });

    it('ignores players beyond sighting range', () => {
        const events = detectSocialEvents({}, { far: SIGHTING_RANGE + 10 });
        assert.deepEqual(events, []);
    });

    it('depart fires when a nearby player disappears', () => {
        const events = detectSocialEvents({ alice: 4 }, {});
        assert.deepEqual(events, [{ kind: 'depart', name: 'alice', dist: null }]);
    });

    it('accepts Map snapshots', () => {
        const events = detectSocialEvents(new Map(), new Map([['zoe', 3]]));
        assert.ok(events.some(e => e.name === 'zoe' && e.kind === 'approach'));
    });
});

describe('reaction gate', () => {
    it('allows once, blocks during cooldown, allows after', () => {
        let now = 0;
        const gate = new ReactionGate({ now: () => now, cooldowns: { approach: 1000 } });
        assert.equal(gate.allow('approach', 'alice'), true);
        assert.equal(gate.allow('approach', 'alice'), false);
        assert.equal(gate.allow('approach', 'bob'), true, 'per-player separation');
        now += 1500;
        assert.equal(gate.allow('approach', 'alice'), true);
    });
});

describe('reaction messages', () => {
    it('is deterministic for a seeded personality', () => {
        const ev = { kind: 'approach', name: 'alice', dist: 6 };
        const p1 = createPersonality({ name: 'Social1', overrides: { sociability: 1 } });
        const p2 = createPersonality({ name: 'Social1', overrides: { sociability: 1 } });
        for (let i = 0; i < 20; i++) {
            assert.equal(
                reactionMessage(ev, { trust: 'neutral' }, { personality: p1 }),
                reactionMessage(ev, { trust: 'neutral' }, { personality: p2 })
            );
        }
    });

    it('greets neutrals with the player name in the message', () => {
        const ev = { kind: 'approach', name: 'alice', dist: 6 };
        let greeted = 0;
        for (let seed = 0; seed < 30; seed++) {
            const p = createPersonality({ name: `g${seed}`, overrides: { sociability: 1 } });
            const msg = reactionMessage(ev, { trust: 'neutral' }, { personality: p });
            if (msg) {
                greeted++;
                assert.match(msg, /alice/);
            }
        }
        assert.ok(greeted >= 15, `sociable bot should greet often (got ${greeted}/30)`);
    });

    it('warns hostile players instead of greeting', () => {
        const ev = { kind: 'approach', name: 'griefer', dist: 6 };
        const msgs = new Set();
        for (let seed = 0; seed < 30; seed++) {
            const p = createPersonality({ name: `h${seed}`, overrides: { sociability: 1 } });
            const msg = reactionMessage(ev, { trust: 'hostile' }, { personality: p });
            if (msg) {
                msgs.add(msg);
                assert.match(msg, /watching|distance|remember/, `hostile notice expected, got: ${msg}`);
                assert.match(msg, /griefer/);
            }
        }
        assert.ok(msgs.size > 0);
    });

    it('never says farewell to hostiles; sometimes to friends', () => {
        const ev = { kind: 'depart', name: 'griefer', dist: null };
        for (let seed = 0; seed < 10; seed++) {
            const p = createPersonality({ name: `d${seed}`, overrides: { sociability: 1 } });
            assert.equal(reactionMessage(ev, { trust: 'hostile' }, { personality: p }), null);
        }
        let farewells = 0;
        for (let seed = 0; seed < 30; seed++) {
            const p = createPersonality({ name: `f${seed}`, overrides: { sociability: 1 } });
            const msg = reactionMessage({ kind: 'depart', name: 'pal', dist: null }, { trust: 'friend' }, { personality: p });
            if (msg) {
                farewells++;
                assert.match(msg, /pal/);
            }
        }
        assert.ok(farewells >= 3, 'sociable bot should sometimes wave goodbye');
    });

    it('unknown kinds produce nothing', () => {
        assert.equal(reactionMessage({ kind: 'weird', name: 'x' }, null, {}), null);
        assert.equal(reactionMessage(null, null, {}), null);
    });
});
