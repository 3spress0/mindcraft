import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import minecraftData from 'minecraft-data';
import {
    CHUNK_SIZE, chunkKey, ExplorationState, nextFrontierGoal, explore
} from '../src/agent/navigation/exploration.js';
import { createRng } from '../src/agent/humanlike/rng.js';

const registry = minecraftData('1.20.1');
const TMP_BOT = 'NavExploreTestBot';

function vec(x, y, z) {
    return {
        x, y, z,
        distanceTo(o) { return Math.sqrt((x - o.x) ** 2 + (y - o.y) ** 2 + (z - o.z) ** 2); }
    };
}

describe('exploration state', () => {
    it('chunkKey buckets by 16x16', () => {
        assert.equal(chunkKey(0, 0), '0,0');
        assert.equal(chunkKey(15.9, -1), '0,-1');
        assert.equal(chunkKey(16, 33), '1,2');
    });

    it('markVisited / isVisited / prune', () => {
        const s = new ExplorationState();
        s.markVisited({ x: 10, y: 64, z: 10 }, 100);
        assert.ok(s.isVisited(10, 10));
        assert.ok(s.isVisited(15, 15));   // still chunk (0,0)
        assert.ok(!s.isVisited(16, 10));  // chunk (1,0)
        for (let i = 0; i < 2100; i++) s.markVisited({ x: i * 16, z: 0 }, 1000 + i);
        assert.ok(s.visitedCount <= 2048, 'pruned to cap');
    });

    it('JSON round-trip and file persistence', () => {
        try {
            const s = new ExplorationState({ origin: { x: 5, z: -5 }, ring: 2, legs: 3 });
            s.markVisited({ x: 5, z: -5 }, 42);
            const back = ExplorationState.fromJSON(JSON.parse(JSON.stringify(s.toJSON())));
            assert.deepEqual(back.origin, { x: 5, z: -5 });
            assert.equal(back.ring, 2);
            assert.equal(back.legs, 3);
            assert.ok(back.isVisited(5, -5));

            assert.ok(s.persist(TMP_BOT));
            const loaded = ExplorationState.load(TMP_BOT);
            assert.ok(loaded.isVisited(5, -5));
            assert.equal(loaded.ring, 2);
        } finally {
            fs.rmSync(`bots/${TMP_BOT}`, { recursive: true, force: true });
        }
    });

    it('load tolerates corrupt files', () => {
        try {
            fs.mkdirSync(`bots/${TMP_BOT}`, { recursive: true });
            fs.writeFileSync(`bots/${TMP_BOT}/exploration.json`, '{oops');
            const s = ExplorationState.load(TMP_BOT);
            assert.equal(s.visitedCount, 0);
            assert.equal(s.ring, 1);
        } finally {
            fs.rmSync(`bots/${TMP_BOT}`, { recursive: true, force: true });
        }
    });
});

describe('frontier goal selection', () => {
    it('is deterministic for a seed and avoids visited chunks', () => {
        const state = new ExplorationState({ origin: { x: 0, z: 0 } });
        const r1 = createRng('A');
        const r2 = createRng('A');
        const g1 = nextFrontierGoal(state, { rng: r1 });
        const g2 = nextFrontierGoal(new ExplorationState({ origin: { x: 0, z: 0 } }), { rng: r2 });
        assert.deepEqual(g1, g2);

        // mark every chunk in the ring-1 box visited -> must move outward
        for (let cx = -2; cx <= 2; cx++) {
            for (let cz = -2; cz <= 2; cz++) {
                state.markVisited({ x: cx * CHUNK_SIZE + 8, z: cz * CHUNK_SIZE + 8 });
            }
        }
        const g3 = nextFrontierGoal(state, { rng: createRng('B') });
        const dist = Math.sqrt(g3.x ** 2 + g3.z ** 2);
        assert.ok(dist > CHUNK_SIZE * 1.2, `expected outer ring, got dist ${dist}`);
    });

    it('ringOverride pins the distance', () => {
        const state = new ExplorationState({ origin: { x: 100, z: 100 } });
        const g = nextFrontierGoal(state, { rng: createRng('C'), ringOverride: 3 });
        const dist = Math.sqrt((g.x - 100) ** 2 + (g.z - 100) ** 2);
        assert.ok(Math.abs(dist - 3 * CHUNK_SIZE) < 8, `dist ${dist} should be ~48`);
        assert.equal(g.ring, 3);
    });
});

describe('explore()', () => {
    function explorerBot() {
        const visitedGoals = [];
        const bot = {
            username: TMP_BOT,
            registry,
            interrupt_code: false,
            entity: { position: vec(0, 64, 0) },
            blockAt: () => ({ name: 'air', boundingBox: 'empty' }),
            pathfinder: {
                setMovements() {},
                goto: async (goal) => {
                    visitedGoals.push({ x: goal.x, z: goal.z });
                    // teleport-arrive like a perfect pathfinder
                    bot.entity.position = vec(goal.x, 64, goal.z);
                },
            },
        };
        return { bot, visitedGoals };
    }

    it('walks the requested legs, records chunks, persists state', async () => {
        try {
            const { bot, visitedGoals } = explorerBot();
            const agent = {
                bot,
                name: TMP_BOT,
                personality: { rng: createRng('explorer-test') }
            };
            const summary = await explore(agent, { legs: 2 });
            assert.match(summary, /Explored 2\/2 leg\(s\)/);
            assert.equal(visitedGoals.length, 2);
            assert.ok(agent._exploration_state.visitedCount >= 3, 'origin + arrivals recorded');
            assert.ok(fs.existsSync(ExplorationState.filePath(TMP_BOT)), 'persisted per leg');
        } finally {
            fs.rmSync(`bots/${TMP_BOT}`, { recursive: true, force: true });
        }
    });

    it('stops cleanly on interruption', async () => {
        try {
            const { bot } = explorerBot();
            bot.pathfinder.goto = async (goal) => {
                bot.entity.position = vec(goal.x, 64, goal.z);
                bot.interrupt_code = true;
            };
            const agent = { bot, name: TMP_BOT, personality: { rng: createRng('x') } };
            const summary = await explore(agent, { legs: 3 });
            assert.match(summary, /1\/3/);
        } finally {
            fs.rmSync(`bots/${TMP_BOT}`, { recursive: true, force: true });
        }
    });

    it('reports pathfinding failures without throwing', async () => {
        try {
            const { bot } = explorerBot();
            bot.pathfinder.goto = async () => { throw new Error('no path'); };
            const agent = { bot, name: TMP_BOT, personality: { rng: createRng('y') } };
            const summary = await explore(agent, { legs: 1 });
            assert.match(summary, /Stopped: leg 1: no path/);
        } finally {
            fs.rmSync(`bots/${TMP_BOT}`, { recursive: true, force: true });
        }
    });

    it('reuses persisted state across calls', async () => {
        try {
            const { bot } = explorerBot();
            const agent = { bot, name: TMP_BOT, personality: { rng: createRng('z') } };
            await explore(agent, { legs: 1 });
            const legsAfterFirst = agent._exploration_state.legs;
            // simulate a restart: drop in-memory state, keep the file
            agent._exploration_state = null;
            const state2 = ExplorationState.load(TMP_BOT);
            assert.equal(state2.legs, legsAfterFirst);
        } finally {
            fs.rmSync(`bots/${TMP_BOT}`, { recursive: true, force: true });
        }
    });
});
