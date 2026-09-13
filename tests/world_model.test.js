import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';

import {
    WorldModel, Fact, CATEGORY, SOURCE,
} from '../src/agent/world_model/world_model.js';
import { WorldModelStore } from '../src/agent/world_model/store.js';

const pos = (x, y = 64, z = 0) => ({ x, y, z });

test('facts merge by key instead of duplicating, and re-observation strengthens them', () => {
    const m = new WorldModel();
    const a = m.record(CATEGORY.THREAT, { name: 'zombie', kind: 'zombie', pos: pos(5) }, { expiresIn: 100_000 });
    const before = a.lastSeen;
    const b = m.record(CATEGORY.THREAT, {
        name: 'zombie', kind: 'zombie', pos: pos(5), detail: { attackedBot: true }, source: SOURCE.OBSERVED,
    }, { expiresIn: 100_000 });
    assert.equal(a.id, b.id);
    assert.equal(m.all(CATEGORY.THREAT).length, 1);
    assert.equal(b.detail.attackedBot, true);
    assert.ok(b.lastSeen >= before);
});

test('different positions of the same named resource are separate deposits', () => {
    const m = new WorldModel();
    m.record(CATEGORY.RESOURCE, { name: 'iron_ore', kind: 'deposit', pos: pos(10, 64, 10), confidence: 0.6 });
    m.record(CATEGORY.RESOURCE, { name: 'iron_ore', kind: 'deposit', pos: pos(-20, 64, 4), confidence: 0.6 });
    assert.equal(m.all(CATEGORY.RESOURCE).length, 2);
});

test('volatile facts decay with time and expire; durable facts are kept', () => {
    const m = new WorldModel();
    const now = 1_000_000;
    const threat = m.record(CATEGORY.THREAT, { name: 'creeper', kind: 'creeper', pos: pos(3), confidence: 1 });
    const loc = m.record(CATEGORY.LOCATION, { name: 'village', kind: 'village', pos: pos(100), confidence: 0.6 });
    threat.lastSeen = now;
    threat.expiresAt = now + 60_000;
    loc.lastSeen = now;
    loc.expiresAt = null;
    // ~7 minutes later: threat confidence decayed below the floor and expired
    m.tick(now + 400_000, { halfLifeMs: 120_000, confidenceFloor: 0.15 });
    assert.equal(m.all(CATEGORY.THREAT).length, 0, 'old threat should decay/prune');
    assert.equal(m.all(CATEGORY.LOCATION).length, 1, 'locations survive');

    // Explicit expiry prunes even at high confidence
    const item = m.record(CATEGORY.RESOURCE, { name: 'dirt', kind: 'ground_item', pos: pos(1), confidence: 1 });
    item.lastSeen = now;
    item.expiresAt = now + 1000;
    m.tick(now + 301_000);
    assert.ok(!m.find(CATEGORY.RESOURCE, (f) => f.kind === 'ground_item').length);
});

test('nearest and keyword queries answer "where is X" without re-exploring', () => {
    const m = new WorldModel();
    m.record(CATEGORY.LOCATION, { name: 'village', kind: 'village', pos: pos(120, 64, -300), confidence: 0.6 });
    m.record(CATEGORY.LOCATION, { name: 'home_base', kind: 'base', pos: pos(5, 64, 5), confidence: 1 });
    m.record(CATEGORY.RESOURCE, { name: 'iron_ore', kind: 'deposit', pos: pos(-40, 50, 20), confidence: 0.6 });
    m.record(CATEGORY.THREAT, { name: 'zombie', kind: 'zombie', pos: pos(12), pos2: undefined }, { expiresIn: 10 ** 9 });

    const village = m.queryNearest('nearest village?', pos(0));
    assert.equal(village.fact.name, 'village');
    assert.equal(village.category, CATEGORY.LOCATION);
    assert.ok(village.distance > 300);

    const iron = m.queryNearest('where did we see iron', pos(0));
    assert.equal(iron.fact.name, 'iron_ore');
    assert.equal(iron.category, CATEGORY.RESOURCE);

    const threat = m.queryNearest('any zombie nearby', pos(0));
    assert.equal(threat.fact.name, 'zombie');
    assert.equal(threat.category, CATEGORY.THREAT);

    const base = m.nearest(CATEGORY.LOCATION, pos(0));
    assert.equal(base.fact.name, 'home_base');
});

test('lastSeen returns the freshest fact matching a fragment', async () => {
    const m = new WorldModel();
    m.record(CATEGORY.RESOURCE, { name: 'coal_ore', kind: 'deposit', pos: pos(8), confidence: 0.6 });
    await new Promise((r) => setTimeout(r, 2));
    m.record(CATEGORY.RESOURCE, { name: 'iron_ore', kind: 'deposit', pos: pos(9), confidence: 0.6 });
    const ore = m.lastSeen('ore');
    assert.equal(ore.name, 'iron_ore');
});

test('recipes are learned, deduplicated and never expire', () => {
    const m = new WorldModel();
    m.learnRecipe('hopper');
    m.learnRecipe('hopper');
    m.learnRecipe('furnace');
    assert.equal(m.all(CATEGORY.RECIPE).length, 2);
    assert.ok(m.hasRecipe('hopper'));
    m.tick(Date.now() + 10 ** 10);
    assert.equal(m.all(CATEGORY.RECIPE).length, 2);
});

test('active project snapshot is mirrored and cleared', () => {
    const m = new WorldModel();
    const project = {
        goal: 'build iron farm', status: 'active',
        progress: () => ({ done: 2, total: 5, pct: 40 }),
    };
    m.setProject(project);
    m.setProject(project);
    assert.equal(m.activeProjects.length, 1);
    assert.equal(m.activeProjects[0].pct, 40);
    m.clearProject('build iron farm');
    assert.equal(m.activeProjects.length, 0);
});

test('player state is updated field by field', () => {
    const m = new WorldModel();
    m.recordPlayer({ position: pos(1), health: 20, food: 18, dimension: 'overworld' });
    m.recordPlayer({ health: 14 });
    assert.equal(m.player.health, 14);
    assert.equal(m.player.position.x, 1);
    assert.equal(m.player.food, 18);
});

test('serialization round-trips every category', () => {
    const m = new WorldModel();
    m.recordPlayer({ position: pos(1), health: 20, food: 20, dimension: 'overworld' });
    m.record(CATEGORY.LOCATION, { name: 'village', kind: 'village', pos: pos(70), confidence: 0.6 });
    m.record(CATEGORY.STRUCTURE, { name: 'workbench spot', kind: 'crafting_table', pos: pos(2), confidence: 0.9 });
    m.learnRecipe('sticks');
    const json = JSON.parse(JSON.stringify(m.toJSON()));
    const m2 = WorldModel.fromJSON(json);
    assert.equal(m2.all(CATEGORY.LOCATION).length, 1);
    assert.equal(m2.all(CATEGORY.RECIPE)[0].name, 'sticks');
    assert.equal(m2.player.health, 20);
    assert.equal(m2.all(CATEGORY.LOCATION)[0].constructor.name, 'Fact');
});

test('summary for the planner lists durable facts but omits pruned threats', () => {
    const m = new WorldModel();
    m.recordPlayer({ position: pos(0), health: 20, food: 20, dimension: 'overworld' });
    m.record(CATEGORY.LOCATION, { name: 'village', kind: 'village', pos: pos(40), confidence: 0.6 });
    m.record(CATEGORY.RESOURCE, { name: 'iron_ore', kind: 'deposit', pos: pos(-10), confidence: 0.6 });
    m.record(CATEGORY.THREAT, { name: 'zombie', kind: 'zombie', pos: pos(6), confidence: 1 }, { expiresIn: 5000 });
    m.tick(Date.now() + 10_000);
    const text = m.summaryForPlanner({ pos: pos(0) });
    assert.match(text, /village/);
    assert.match(text, /iron_ore/);
    assert.doesNotMatch(text, /zombie/);
});

test('render: category filter lists facts; unknown query reports none', () => {
    const m = new WorldModel();
    m.record(CATEGORY.RESOURCE, { name: 'iron_ore', kind: 'deposit', pos: pos(4), confidence: 0.6 });
    const res = m.render('resources');
    assert.match(res, /iron_ore/);
    const miss = m.render('diamond');
    assert.match(miss, /No known facts/);
});

test('WorldModelStore round-trips, survives a corrupt file and prunes expired facts on load', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mindcraft-wm-'));
    try {
        const store = new WorldModelStore('testbot', dir);
        const m = new WorldModel();
        m.record(CATEGORY.LOCATION, { name: 'village', kind: 'village', pos: pos(90), confidence: 0.6 });
        m.record(CATEGORY.THREAT, { name: 'zombie', kind: 'zombie', pos: pos(2), confidence: 1 }, { expiresIn: -1 });
        assert.equal(store.save(m, { force: true }), true);

        const loaded = store.load();
        assert.ok(loaded);
        assert.equal(loaded.all(CATEGORY.LOCATION).length, 1);
        // expired threat already pruned on load
        assert.equal(loaded.all(CATEGORY.THREAT).length, 0);

        // corrupt file is quarantined rather than thrown
        fs.writeFileSync(path.join(dir, 'testbot', 'world_model.json'), '{not json');
        const recovered = store.load();
        assert.equal(recovered, null);
        const backups = fs.readdirSync(path.join(dir, 'testbot')).filter((f) => f.includes('corrupt'));
        assert.equal(backups.length, 1);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('deposits can be marked depleted so the planner routes elsewhere', () => {
    const m = new WorldModel();
    m.recordPlayer({ position: pos(0) });
    m.record(CATEGORY.RESOURCE, { name: 'iron_ore', kind: 'deposit', pos: pos(5), confidence: 0.6 });
    const hit = m.nearest(CATEGORY.RESOURCE, pos(0), { name: 'iron_ore', maxDistance: 20 });
    hit.fact.detail.depleted = true;
    hit.fact.confidence = 0.2;
    const text = m.summaryForPlanner({ pos: pos(0) });
    assert.match(text, /depleted=true/);
    const again = m.nearest(CATEGORY.RESOURCE, pos(0), { name: 'iron_ore', maxDistance: 20 });
    assert.equal(again.fact.detail.depleted, true);
});

test('Fact defaults: confidence follows source and keys are stable', () => {
    const told = new Fact(CATEGORY.LOCATION, { name: 'village', pos: pos(1), source: SOURCE.TOLD });
    assert.ok(Math.abs(told.confidence - 0.7) < 1e-9);
    const inferred = new Fact(CATEGORY.RECIPE, { name: 'torch', source: SOURCE.INFERRED });
    assert.equal(inferred.key, 'torch');
    const located = new Fact(CATEGORY.LOCATION, { name: 'village', pos: pos(2) });
    assert.match(located.key, /^village@2,64,0$/);
});
