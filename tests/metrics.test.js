import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { MetricsTracker, getMetrics, causeFromDeathMessage } from '../src/agent/library/metrics.js';

let tmp;
before(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'metrics-')); });
after(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

function tracker(name = 'MetricsBot', now = () => Date.now()) {
    return new MetricsTracker({ botName: name, dir: tmp, now });
}

describe('MetricsTracker', () => {
    it('starts with zero deaths', () => {
        const m = tracker('FreshBot');
        assert.equal(m.deaths, 0);
        assert.equal(m.lastDeath, null);
        assert.match(m.summarize(), /still alive/);
    });

    it('records deaths with cause and position', () => {
        const m = tracker('DeadBot');
        m.recordDeath({ cause: 'fell', pos: { x: 10.456, y: 64, z: -3.2 } });
        assert.equal(m.deaths, 1);
        assert.equal(m.causes.fell, 1);
        assert.equal(m.lastDeath.cause, 'fell');
        assert.equal(m.lastDeath.x, 10.5); // rounded
        assert.equal(m.lastDeath.z, -3.2);
    });

    it('aggregates causes across deaths', () => {
        const m = tracker('ClumsyBot');
        m.recordDeath({ cause: 'fell' });
        m.recordDeath({ cause: 'fell' });
        m.recordDeath({ cause: 'slain by zombie' });
        assert.equal(m.deaths, 3);
        assert.equal(m.causes.fell, 2);
        assert.equal(m.causes['slain by zombie'], 1);
        assert.match(m.summarize(), /fell x2/);
    });

    it('setLastCause refines the most recent death only', () => {
        const m = tracker('RefineBot');
        m.recordDeath({ cause: 'unknown' });
        assert.equal(m.setLastCause('drowned'), true);
        assert.equal(m.causes.drowned, 1);
        assert.equal(m.causes.unknown, undefined);
        assert.equal(m.lastDeath.cause, 'drowned');
        // same cause again -> no-op
        assert.equal(m.setLastCause('drowned'), false);
        // no death recorded -> false
        const fresh = tracker('NoDeathBot');
        assert.equal(fresh.setLastCause('fell'), false);
    });

    it('persists and reloads cumulatively', () => {
        const m1 = tracker('PersistBot');
        m1.recordDeath({ cause: 'fire' });
        m1.recordDeath({ cause: 'fire' });
        const m2 = tracker('PersistBot');
        assert.equal(m2.deaths, 2);
        assert.equal(m2.causes.fire, 2);
        assert.equal(m2.sessions, 2); // constructor counts a new session
        m2.recordDeath({ cause: 'void' });
        const m3 = tracker('PersistBot');
        assert.equal(m3.deaths, 3);
        assert.equal(m3.sessions, 3);
    });

    it('tolerates a corrupt metrics file', () => {
        const fp = path.join(tmp, 'CorruptBot', 'metrics.json');
        fs.mkdirSync(path.dirname(fp), { recursive: true });
        fs.writeFileSync(fp, 'garbage{');
        const m = new MetricsTracker({ botName: 'CorruptBot', dir: tmp });
        assert.equal(m.deaths, 0);
    });

    it('records respawns and persists them', () => {
        const m1 = tracker('RespawnBot');
        m1.recordRespawn({ pos: { x: 1.24, y: 64, z: -2.5 } });
        m1.recordRespawn();
        assert.equal(m1.respawns, 2);
        assert.equal(m1.lastRespawn.x, 1.2);
        const m2 = tracker('RespawnBot');
        assert.equal(m2.respawns, 2);
        assert.match(m2.summarize(), /Respawns: 2, last at \(1\.2, 64, -2\.5\)/);
    });

    it('computes uptime and death rate', () => {
        let t = 1000000;
        const m = tracker('RateBot', () => t);
        m.recordDeath({ cause: 'fell' });
        t += 3.6e6; // one hour later
        assert.equal(m.uptimeMs(), 3.6e6);
        assert.equal(m.deathRatePerHour(), 1);
        assert.match(m.summarize(), /death rate: 1\/h/);
    });
});

describe('causeFromDeathMessage', () => {
    it('extracts common causes', () => {
        assert.equal(causeFromDeathMessage('Bot was slain by Zombie', 'Bot'), 'slain by Zombie');
        assert.equal(causeFromDeathMessage('Bot was shot by Skeleton', 'Bot'), 'shot by Skeleton');
        assert.equal(causeFromDeathMessage('Bot fell from a high place', 'Bot'), 'fell');
        assert.equal(causeFromDeathMessage('Bot drowned', 'Bot'), 'drowned');
        assert.equal(causeFromDeathMessage('Bot burned to death', 'Bot'), 'fire');
        assert.equal(causeFromDeathMessage('Bot blew up', 'Bot'), 'explosion');
        assert.equal(causeFromDeathMessage('Bot starved to death', 'Bot'), 'starved');
        assert.equal(causeFromDeathMessage('Bot fell out of the world', 'Bot'), 'fell');
        assert.equal(causeFromDeathMessage('something weird happened', 'Bot'), 'unknown');
    });
});

describe('getMetrics helper', () => {
    it('caches per bot name', () => {
        const agent = { name: 'AgentBot', bot: {} };
        const a = getMetrics(agent);
        const b = getMetrics(agent);
        assert.equal(a, b);
        assert.ok(a instanceof MetricsTracker);
    });

    it('returns null without a bot name', () => {
        assert.equal(getMetrics({}), null);
    });
});
