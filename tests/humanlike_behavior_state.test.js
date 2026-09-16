import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { BehaviorStateMachine, STATES } from '../src/agent/humanlike/behavior_state.js';

function fsmAt(t = 0) {
    let now = t;
    const fsm = new BehaviorStateMachine(() => now);
    return { fsm, tick: (dt) => { now += dt; } };
}

describe('humanlike behavior state machine', () => {
    it('starts in IDLE', () => {
        const { fsm } = fsmAt();
        assert.equal(fsm.current, STATES.IDLE);
        assert.equal(fsm.activity, null);
    });

    it('follows the happy path IDLE->ACT->VERIFY->IDLE', () => {
        const { fsm } = fsmAt();
        assert.ok(fsm.beginActivity('mine iron'));
        assert.equal(fsm.current, STATES.ACT);
        assert.equal(fsm.activity, 'mine iron');
        assert.ok(fsm.finish(true));
        assert.equal(fsm.current, STATES.IDLE);
        assert.equal(fsm.activity, null);
        assert.equal(fsm.lastResult, 'succeeded');
    });

    it('legal transitions apply, illegal ones are ignored', () => {
        const { fsm } = fsmAt();
        assert.equal(fsm.transition('noticed'), true);
        assert.equal(fsm.current, STATES.OBSERVE);
        assert.equal(fsm.transition('bogus-event'), false);
        assert.equal(fsm.current, STATES.OBSERVE);
        assert.equal(fsm.transition('decide'), true);
        assert.equal(fsm.current, STATES.DECIDE);
        assert.equal(fsm.transition('act'), true);
        assert.equal(fsm.current, STATES.ACT);
        assert.equal(fsm.transition('verify'), true);
        assert.equal(fsm.current, STATES.VERIFY);
        assert.equal(fsm.transition('failed'), true);
        assert.equal(fsm.current, STATES.RECOVER);
    });

    it('react() remembers the activity and resume() returns it', () => {
        const { fsm } = fsmAt();
        fsm.beginActivity('build the wall');
        assert.ok(fsm.react('player arrived'));
        assert.equal(fsm.current, STATES.REACT);
        assert.equal(fsm.peekPendingResume(), 'build the wall');
        const resumed = fsm.resume();
        assert.equal(resumed, 'build the wall');
        assert.equal(fsm.current, STATES.RESUME);
        assert.ok(fsm.beginActivity(resumed));
        assert.equal(fsm.current, STATES.ACT);
        assert.equal(fsm.activity, 'build the wall');
    });

    it('interrupt() stacks activities; resume pops newest first', () => {
        const { fsm } = fsmAt();
        fsm.beginActivity('task A');
        fsm.interrupt('damage');
        assert.equal(fsm.current, STATES.INTERRUPTED);
        assert.equal(fsm.activity, null);
        // recover then start something new, get interrupted again
        fsm.recover();
        fsm.beginActivity('task B');
        fsm.interrupt('creeper');
        assert.deepEqual(fsm.activityStack.map(e => e.activity), ['task A', 'task B']);
        assert.equal(fsm.resume(), 'task B');
        assert.equal(fsm.resume(), 'task A');
        assert.equal(fsm.resume(), null);
    });

    it('activity stack is bounded', () => {
        const { fsm } = fsmAt();
        for (let i = 0; i < 10; i++) {
            fsm.beginActivity(`task ${i}`);
            fsm.interrupt('x');
            fsm.recover();
        }
        assert.ok(fsm.activityStack.length <= 4);
    });

    it('tracks time in state with the injected clock', () => {
        const { fsm, tick } = fsmAt(1000);
        assert.equal(fsm.timeInState(), 0);
        tick(250);
        assert.equal(fsm.timeInState(), 250);
        fsm.beginActivity('work');
        assert.equal(fsm.timeInState(), 0);
        tick(100);
        assert.equal(fsm.timeInState(), 100);
    });

    it('history is recorded and bounded', () => {
        const { fsm } = fsmAt();
        for (let i = 0; i < 50; i++) {
            fsm.beginActivity(`t${i}`);
            fsm.finish(true);
        }
        assert.ok(fsm.history.length <= 32);
        assert.ok(fsm.history.length > 0);
        const last = fsm.history[fsm.history.length - 1];
        assert.ok(['from', 'to', 'event', 't'].every(k => k in last));
    });

    it('toJSON reports the observable state', () => {
        const { fsm } = fsmAt();
        fsm.beginActivity('chop wood');
        fsm.interrupt('ouch');
        const j = fsm.toJSON();
        assert.equal(j.state, STATES.INTERRUPTED);
        assert.deepEqual(j.pendingResume, ['chop wood']);
        assert.equal(typeof j.timeInState, 'number');
    });
});
