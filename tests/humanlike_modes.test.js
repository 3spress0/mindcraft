import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Vec3 } from 'vec3';
import { modes_list } from '../src/agent/modes.js';
import { createPersonality } from '../src/agent/humanlike/personality.js';
import { BehaviorStateMachine } from '../src/agent/humanlike/behavior_state.js';
import { AttentionTracker } from '../src/agent/humanlike/attention.js';

function mockAgent() {
    const looks = [];
    const bot = {
        output: '',
        entity: { position: new Vec3(0, 64, 0), yaw: 0, pitch: 0 },
        players: {},
        blockAt: () => ({ name: 'air', boundingBox: 'empty' }),
        look: async (yaw, pitch, force) => { looks.push({ yaw, pitch, force }); },
        lookAt: async () => {},
        nearestEntity: () => null,
        modes: { isOn: () => false },
        interrupt_code: null,
        pathfinder: { setGoal: () => {} }
    };
    const agent = {
        bot,
        looks,
        personality: createPersonality({ name: 'ModeSmoke' }),
        behavior_state: new BehaviorStateMachine(),
        attention: new AttentionTracker(),
        shut_up: true,
        isIdle: () => true,
        idleForMs: () => 30000,
        actions: { currentActionLabel: null }
    };
    return agent;
}

describe('humanlike modes wiring', () => {
    it('registers idle_behavior alongside idle_staring', () => {
        const names = modes_list.map(m => m.name);
        assert.ok(names.includes('idle_staring'));
        assert.ok(names.includes('idle_behavior'));
        assert.ok(names.indexOf('idle_staring') < names.indexOf('cheat'));
    });

    it('idle_staring turns toward fresh events without throwing', async () => {
        const agent = mockAgent();
        agent.attention.recordEvent(4, 65, 4, 'test');
        const mode = modes_list.find(m => m.name === 'idle_staring');
        mode.next_change = 0;
        mode.busy_until = 0;
        mode.update(agent);
        await new Promise(r => setTimeout(r, 1600));
        assert.ok(agent.looks.length >= 1, 'should glance at the event');
        const expectedYaw = Math.atan2(-4, 4);
        assert.ok(Math.abs(agent.looks[0].yaw - expectedYaw) < 0.35);
    });

    it('idle_staring is quiet during its busy window', () => {
        const agent = mockAgent();
        const mode = modes_list.find(m => m.name === 'idle_staring');
        mode.next_change = 0;
        mode.busy_until = Date.now() + 60000;
        mode.update(agent);
        assert.equal(agent.looks.length, 0);
    });

    it('idle_behavior never throws and respects cooldowns', async () => {
        const agent = mockAgent();
        const mode = modes_list.find(m => m.name === 'idle_behavior');
        mode.cooldown_until = 0;
        mode.running = false;
        for (let i = 0; i < 5; i++) mode.update(agent);
        await new Promise(r => setTimeout(r, 300));
        // after the first tick a cooldown must be set (either short backoff or long)
        assert.ok(mode.cooldown_until > Date.now() - 1000, 'cooldown should be scheduled');
    });
});
