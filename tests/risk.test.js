import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Vec3 } from 'vec3';
import { assessLocalRisk, filterNeedsByRisk, riskLine, HOSTILE_MOBS, RISKY_NEEDS } from '../src/agent/autonomy/risk.js';

function entity(name, x, z, y = 64) {
    return { name, position: new Vec3(x, y, z) };
}

function bot({ time = 6000, hostiles = [], posture = undefined } = {}) {
    const b = {
        time: { timeOfDay: time },
        entity: { position: new Vec3(0, 64, 0) },
        entities: {}
    };
    if (posture) b._risk_profile = posture;
    hostiles.forEach((h, i) => { b.entities[`e${i}`] = h; });
    return b;
}

describe('assessLocalRisk', () => {
    it('daytime with no hostiles is safe', () => {
        const r = assessLocalRisk(bot());
        assert.equal(r.score, 0);
        assert.equal(r.level, 'none');
        assert.equal(r.night, false);
        assert.equal(r.hostiles.length, 0);
    });

    it('night alone raises risk to low', () => {
        const r = assessLocalRisk(bot({ time: 18000 }));
        assert.equal(r.night, true);
        assert.ok(r.score >= 0.2 && r.score < 0.45);
        assert.equal(r.level, 'low');
    });

    it('several hostiles in range push risk to high', () => {
        const hostiles = [entity('zombie', 8, 0), entity('skeleton', 0, 9), entity('creeper', 5, 5), entity('spider', 10, 2)];
        const r = assessLocalRisk(bot({ hostiles }));
        assert.equal(r.level, 'high');
        assert.equal(r.hostiles.length, 4);
    });

    it('a very close hostile adds extra risk', () => {
        const near = assessLocalRisk(bot({ hostiles: [entity('creeper', 2, 2)] }));
        const far = assessLocalRisk(bot({ hostiles: [entity('creeper', 14, 0)] }));
        assert.ok(near.score > far.score);
    });

    it('hostiles outside the radius are ignored', () => {
        const r = assessLocalRisk(bot({ hostiles: [entity('zombie', 60, 60)] }));
        assert.equal(r.hostiles.length, 0);
        assert.equal(r.level, 'none');
    });

    it('bold posture tolerates more risk than cautious', () => {
        const hostiles = [entity('zombie', 8, 0), entity('skeleton', 0, 9)];
        const bold = assessLocalRisk(bot({ hostiles, posture: 'bold' }));
        const cautious = assessLocalRisk(bot({ hostiles, posture: 'cautious' }));
        assert.ok(bold.score < cautious.score, `bold ${bold.score} should be < cautious ${cautious.score}`);
    });

    it('posture comes from the bot risk profile by default', () => {
        const r = assessLocalRisk(bot({ posture: 'bold' }));
        assert.equal(r.posture, 'bold');
    });

    it('survives a malformed bot', () => {
        assert.equal(assessLocalRisk(null).level, 'none');
        assert.equal(assessLocalRisk({}).level, 'none');
    });

    it('hostile mob list covers the common threats', () => {
        for (const m of ['zombie', 'skeleton', 'creeper', 'spider', 'enderman', 'witch']) {
            assert.ok(HOSTILE_MOBS.includes(m), `${m} should be hostile`);
        }
    });
});

describe('filterNeedsByRisk', () => {
    const needs = [
        { kind: 'tool_replace', urgency: 0.9 },
        { kind: 'restock_torches', urgency: 0.35 },
        { kind: 'explore', urgency: 0.3 },
        { kind: 'farm', urgency: 0.45 },
        { kind: 'inventory_full', urgency: 0.8 }
    ];

    it('keeps everything when risk is not high', () => {
        assert.equal(filterNeedsByRisk(needs, { level: 'low' }).length, needs.length);
        assert.equal(filterNeedsByRisk(needs, { level: 'none' }).length, needs.length);
        assert.equal(filterNeedsByRisk(needs, null).length, needs.length);
    });

    it('drops risky needs under high risk but keeps safe upkeep', () => {
        const filtered = filterNeedsByRisk(needs, { level: 'high' });
        const kinds = filtered.map(n => n.kind);
        assert.ok(!kinds.includes('explore'));
        assert.ok(!kinds.includes('farm'));
        assert.ok(kinds.includes('tool_replace'));
        assert.ok(kinds.includes('restock_torches'));
        assert.ok(kinds.includes('inventory_full'));
    });

    it('does not mutate the input', () => {
        const before = needs.length;
        filterNeedsByRisk(needs, { level: 'high' });
        assert.equal(needs.length, before);
    });

    it('risky-need registry matches the filter', () => {
        assert.ok(RISKY_NEEDS.has('explore'));
        assert.ok(RISKY_NEEDS.has('farm'));
        assert.ok(!RISKY_NEEDS.has('tool_replace'));
    });
});

describe('riskLine', () => {
    it('renders posture and hostiles', () => {
        const r = assessLocalRisk(bot({ time: 18000, hostiles: [entity('zombie', 7, 0)], posture: 'cautious' }));
        const line = riskLine(r);
        assert.match(line, /risk: /);
        assert.match(line, /cautious/);
        assert.match(line, /zombie/);
    });

    it('handles missing risk', () => {
        assert.match(riskLine(null), /unknown/);
    });
});
