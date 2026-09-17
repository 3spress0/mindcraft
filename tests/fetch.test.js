import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { planFetch, executeFetch } from '../src/agent/storage/fetch.js';
import { StorageIndex } from '../src/agent/storage/index.js';

function agentWithIndex(records) {
    const index = new StorageIndex();
    for (const [pos, items] of records) index.record('chest', pos, items);
    return { name: 'FetchBot', bot: { username: 'FetchBot' }, storage_index: index };
}

describe('planFetch', () => {
    it('builds targets from the storage index, nearest handled by index order', () => {
        const agent = agentWithIndex([
            [{ x: 10, y: 64, z: 0 }, [{ name: 'iron_ingot', count: 32 }]],
            [{ x: 50, y: 64, z: 0 }, [{ name: 'iron_ingot', count: 64 }, { name: 'gold_ingot', count: 8 }]]
        ]);
        const plan = planFetch(agent, 'iron_ingot', 40);
        assert.equal(plan.targets.length, 2);
        assert.equal(plan.total, 96);
        assert.equal(plan.want, 40);
        assert.equal(plan.covered, true);
    });

    it('reports when not enough is stored', () => {
        const agent = agentWithIndex([[{ x: 1, y: 64, z: 1 }, [{ name: 'diamond', count: 2 }]]]);
        const plan = planFetch(agent, 'diamond', 10);
        assert.equal(plan.covered, false);
        assert.equal(plan.total, 2);
    });

    it('handles unknown items and case', () => {
        const agent = agentWithIndex([[{ x: 1, y: 64, z: 1 }, [{ name: 'iron_ingot', count: 4 }]]]);
        assert.equal(planFetch(agent, 'nothing_here').targets.length, 0);
        const plan = planFetch(agent, 'IRON_INGOT', 2);
        assert.equal(plan.targets.length, 1);
    });
});

describe('executeFetch', () => {
    it('requires a bot', async () => {
        assert.match(await executeFetch({ name: 'x' }, 'iron_ingot'), /no bot/);
    });

    it('reports when nothing is stored', async () => {
        const agent = agentWithIndex([]);
        agent.bot = { username: 'FetchBot' };
        const msg = await executeFetch(agent, 'iron_ingot', 4);
        assert.match(msg, /no stored iron_ingot on record/);
    });
});
