import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    GoalBlock,
    GoalNear,
    GoalXZ,
    GoalNearXZ,
    GoalY,
    GoalGetToBlock,
    GoalFollow,
    GoalRunAway,
    GoalAny,
    GoalAll,
    GoalInvert,
} from '../src/agent/baritone/goals.js';

const node = (x, y, z) => ({ x, y, z });

// ---------- GoalBlock ----------

test('GoalBlock is satisfied only on the exact block', () => {
    const g = new GoalBlock(10, 64, -3);
    assert.ok(g.isEnd(node(10, 64, -3)));
    assert.ok(!g.isEnd(node(10, 65, -3)));
    assert.ok(!g.isEnd(node(11, 64, -3)));
    assert.equal(g.heuristic(node(10, 64, -3)), 0);
    assert.equal(g.heuristic(node(12, 64, 0)), 2 + 3); // manhattan
    assert.match(g.describe(), /GoalBlock/);
});

// ---------- GoalNear ----------

test('GoalNear accepts everything within manhattan range', () => {
    const g = new GoalNear(0, 64, 0, 2);
    assert.ok(g.isEnd(node(0, 64, 0)));
    assert.ok(g.isEnd(node(2, 64, 0)));
    assert.ok(g.isEnd(node(1, 64, 1))); // manhattan 2
    assert.ok(g.isEnd(node(0, 66, 0))); // vertical counts too
});

test('GoalNear rejects out-of-range nodes', () => {
    const g = new GoalNear(0, 64, 0, 2);
    assert.ok(!g.isEnd(node(1, 65, 1))); // manhattan 3
    assert.ok(!g.isEnd(node(3, 64, 0)));
    assert.equal(g.heuristic(node(4, 64, 0)), 2); // 4 - range 2
    assert.equal(g.heuristic(node(1, 64, 0)), 0);
});

// ---------- GoalXZ / GoalNearXZ / GoalY ----------

test('GoalXZ ignores height', () => {
    const g = new GoalXZ(5, -5);
    assert.ok(g.isEnd(node(5, 0, -5)));
    assert.ok(g.isEnd(node(5, 300, -5)));
    assert.ok(!g.isEnd(node(6, 64, -5)));
    assert.equal(g.heuristic(node(8, 200, -5)), 3);
});

test('GoalNearXZ works at any height', () => {
    const g = new GoalNearXZ(0, 0, 3);
    assert.ok(g.isEnd(node(2, 100, 1))); // manhattan 3, any height
    assert.ok(g.isEnd(node(0, -60, 0)));
    assert.ok(!g.isEnd(node(2, 100, 2))); // manhattan 4
});

test('GoalY only checks height', () => {
    const g = new GoalY(70);
    assert.ok(g.isEnd(node(123, 70, -42)));
    assert.ok(!g.isEnd(node(123, 71, -42)));
    assert.equal(g.heuristic(node(0, 60, 0)), 10);
});

// ---------- GoalGetToBlock ----------

test('GoalGetToBlock: adjacent, on top and same-cell all satisfy', () => {
    const g = new GoalGetToBlock(10, 64, 10);
    assert.ok(g.isEnd(node(10, 64, 10)), 'same cell (slabs)');
    assert.ok(g.isEnd(node(10, 65, 10)), 'standing on top');
    assert.ok(g.isEnd(node(11, 64, 10)), 'adjacent east');
    assert.ok(g.isEnd(node(10, 64, 9)), 'adjacent north');
    assert.ok(!g.isEnd(node(11, 65, 10)), 'diagonal above is not reachable');
    assert.ok(!g.isEnd(node(12, 64, 10)), 'two blocks away');
});

test('GoalGetToBlock heuristic is admissible (never overestimates end-distance)', () => {
    const g = new GoalGetToBlock(10, 64, 10);
    for (const n of [node(10, 65, 10), node(11, 64, 10), node(10, 64, 10)]) {
        assert.ok(g.isEnd(n));
        assert.equal(g.heuristic(n), 0);
    }
    assert.ok(g.heuristic(node(15, 64, 10)) > 0);
});

// ---------- GoalFollow ----------

test('GoalFollow tracks a moving entity', () => {
    const entity = { position: { x: 0, y: 64, z: 0 }, username: 'Steve' };
    const g = new GoalFollow(entity, 3);

    assert.ok(g.isEnd(node(1, 64, 1)));
    assert.ok(!g.hasChanged(), 'no movement yet');

    entity.position = { x: 0.4, y: 64, z: 0 }; // sub-block wiggle
    assert.ok(!g.hasChanged(), 'sub-block movement should not force re-planning');

    entity.position = { x: 10, y: 64, z: 0 }; // ran away
    assert.ok(g.hasChanged(), 'a full block of movement triggers re-planning');
    assert.ok(!g.hasChanged(), 'change is consumed');

    assert.ok(!g.isEnd(node(1, 64, 1)), 'goal moved with the entity');
    assert.ok(g.isEnd(node(9, 64, 1)));
    assert.match(g.describe(), /Steve/);
});

test('GoalFollow handles vanished entities gracefully', () => {
    const entity = { position: { x: 0, y: 64, z: 0 } };
    const g = new GoalFollow(entity, 2);
    entity.position = null;
    assert.ok(!g.isEnd(node(0, 64, 0)));
    assert.equal(g.heuristic(node(0, 64, 0)), 0);
    assert.ok(!g.hasChanged());
});

// ---------- GoalRunAway ----------

test('GoalRunAway is satisfied beyond the radius', () => {
    const g = new GoalRunAway({ x: 0, y: 64, z: 0 }, 10);
    assert.ok(!g.isEnd(node(3, 64, 3)));
    assert.ok(g.isEnd(node(12, 64, 0)));
    assert.ok(g.heuristic(node(0, 64, 0)) >= 9);
    assert.equal(g.heuristic(node(50, 64, 0)), 0);
});

test('GoalRunAway also works from an entity reference', () => {
    const entity = { position: { x: 5, y: 64, z: 5 } };
    const g = new GoalRunAway(entity, 8);
    assert.ok(!g.isEnd(node(6, 64, 6)));
    assert.ok(g.isEnd(node(14, 64, 5)));
});

// ---------- composites ----------

test('GoalAny is satisfied by any sub-goal', () => {
    const g = new GoalAny(new GoalBlock(0, 64, 0), new GoalBlock(5, 64, 5));
    assert.ok(g.isEnd(node(0, 64, 0)));
    assert.ok(g.isEnd(node(5, 64, 5)));
    assert.ok(!g.isEnd(node(2, 64, 2)));
    assert.equal(g.heuristic(node(1, 64, 0)), 1); // min of both
    assert.match(g.describe(), /GoalAny/);
});

test('GoalAll requires every sub-goal', () => {
    const g = new GoalAll(new GoalXZ(3, 3), new GoalY(64));
    assert.ok(g.isEnd(node(3, 64, 3)));
    assert.ok(!g.isEnd(node(3, 65, 3)));
    assert.ok(!g.isEnd(node(4, 64, 3)));
    assert.equal(new GoalAll().isEnd(node(0, 0, 0)), false, 'empty GoalAll is never satisfied');
    assert.match(g.describe(), /GoalAll/);
});

test('GoalInvert flips satisfaction', () => {
    const inner = new GoalNear(0, 64, 0, 2);
    const g = new GoalInvert(inner);
    assert.ok(!g.isEnd(node(0, 64, 0)));
    assert.ok(g.isEnd(node(10, 64, 10)));
    assert.ok(g.heuristic(node(0, 64, 0)) <= 0);
    assert.match(g.describe(), /GoalInvert/);
});

test('composites propagate hasChanged from dynamic children', () => {
    const entity = { position: { x: 0, y: 64, z: 0 } };
    const follow = new GoalFollow(entity, 2);
    const any = new GoalAny(new GoalBlock(100, 100, 100), follow);
    assert.ok(!any.hasChanged());
    entity.position = { x: 5, y: 64, z: 0 };
    assert.ok(any.hasChanged());
});
