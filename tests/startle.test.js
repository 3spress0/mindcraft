/**
 * startle.test.js — humanlike reaction to loud sounds (GO list: react to
 * explosions).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Vec3 } from 'vec3';
import { isLoudSound, handleSound } from '../src/agent/humanlike/startle.js';
import { AttentionTracker } from '../src/agent/humanlike/attention.js';

function startledAgent(pos = new Vec3(0, 64, 0)) {
    const looks = [];
    return {
        agent: {
            bot: {
                entity: { position: pos },
                look: async (yaw, pitch) => { looks.push({ yaw, pitch }); }
            },
            _attention: new AttentionTracker(),
            personality: null
        },
        looks
    };
}

describe('loud sound detection', () => {
    it('recognizes explosion-family sounds', () => {
        assert.ok(isLoudSound('entity.generic.explode'));
        assert.ok(isLoudSound('entity.lightning_bolt.thunder'));
        assert.ok(isLoudSound('entity.wither.spawn'));
        assert.ok(isLoudSound('entity.ender_dragon.growl'));
        assert.ok(isLoudSound('entity.ghast.scream'));
        assert.ok(isLoudSound('entity.tnt.primed'));
    });

    it('ignores ambient noise', () => {
        assert.equal(isLoudSound('block.note_block.harp'), false);
        assert.equal(isLoudSound('entity.chicken.ambient'), false);
        assert.equal(isLoudSound(''), false);
        assert.equal(isLoudSound(null), false);
    });
});

describe('handleSound', () => {
    it('startles: records the event and glances at the source', async () => {
        const { agent, looks } = startledAgent();
        const res = await handleSound(agent, 'entity.generic.explode', new Vec3(10, 64, 0));
        assert.equal(res.startled, true);
        assert.equal(looks.length, 1, 'the bot looked');
        const ev = agent._attention.freshEvent();
        assert.ok(ev, 'attention recorded the event');
        assert.equal(ev.x, 10);
        assert.equal(ev.kind, 'sound');
    });

    it('quiet sounds do nothing', async () => {
        const { agent, looks } = startledAgent();
        const res = await handleSound(agent, 'block.grass.step', new Vec3(3, 64, 0));
        assert.equal(res.startled, false);
        assert.equal(looks.length, 0);
        assert.equal(agent._attention.freshEvent(), null);
    });

    it('very distant booms are not worth flinching at', async () => {
        const { agent, looks } = startledAgent();
        const res = await handleSound(agent, 'entity.generic.explode', new Vec3(500, 64, 0), { maxDist: 48 });
        assert.equal(res.startled, false);
        assert.equal(res.reason, 'too far');
        assert.equal(looks.length, 0);
    });

    it('survives a broken bot gracefully', async () => {
        const res = await handleSound({ bot: null }, 'entity.generic.explode', new Vec3(1, 64, 0));
        assert.equal(res.startled, false);
        const res2 = await handleSound({ bot: { entity: { position: new Vec3(0, 64, 0) } } }, 'entity.generic.explode', null);
        assert.equal(res2.startled, false);
    });
});
