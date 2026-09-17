// Explicit behavior state machine for the humanlike layer.
// States: IDLE -> OBSERVE -> DECIDE -> ACT -> VERIFY -> REACT/INTERRUPTED/RECOVER -> RESUME
// It tracks what the bot was doing so interruptions can be resumed, and it
// exposes timing so consumers can make activity-dependent decisions.

export const STATES = {
    IDLE: 'idle',
    OBSERVE: 'observe',
    DECIDE: 'decide',
    ACT: 'act',
    VERIFY: 'verify',
    REACT: 'react',
    INTERRUPTED: 'interrupted',
    RECOVER: 'recover',
    RESUME: 'resume'
};

// legal transitions: state -> { event -> next state }
const TRANSITIONS = {
    [STATES.IDLE]: { noticed: STATES.OBSERVE, decide: STATES.DECIDE, act: STATES.ACT },
    [STATES.OBSERVE]: { decide: STATES.DECIDE, act: STATES.ACT, idle: STATES.IDLE },
    [STATES.DECIDE]: { act: STATES.ACT, idle: STATES.IDLE, observe: STATES.OBSERVE },
    [STATES.ACT]: { verify: STATES.VERIFY, interrupted: STATES.INTERRUPTED, react: STATES.REACT, idle: STATES.IDLE },
    [STATES.VERIFY]: { succeeded: STATES.IDLE, failed: STATES.RECOVER, interrupted: STATES.INTERRUPTED, react: STATES.REACT, act: STATES.ACT },
    [STATES.REACT]: { recover: STATES.RECOVER, resume: STATES.RESUME, idle: STATES.IDLE },
    [STATES.INTERRUPTED]: { recover: STATES.RECOVER, resume: STATES.RESUME, idle: STATES.IDLE },
    [STATES.RECOVER]: { resume: STATES.RESUME, idle: STATES.IDLE, decide: STATES.DECIDE },
    [STATES.RESUME]: { act: STATES.ACT, idle: STATES.IDLE }
};

const HISTORY_LIMIT = 32;
const STACK_LIMIT = 4;

export class BehaviorStateMachine {
    /** @param {function():number} [now] injectable clock for tests. */
    constructor(now = () => Date.now()) {
        this._now = now;
        this.state = STATES.IDLE;
        this.stateSince = now();
        this.activity = null;       // what it is currently doing
        this.history = [];          // recent transitions (bounded)
        this.activityStack = [];    // remembered activities for resume-after-interrupt
        this.lastResult = null;     // 'succeeded' | 'failed' | null
    }

    _record(event, from, to) {
        this.history.push({ t: this._now(), event, from, to });
        if (this.history.length > HISTORY_LIMIT) this.history.splice(0, this.history.length - HISTORY_LIMIT);
    }

    /** Apply an event. Returns true if a legal transition happened. */
    transition(event) {
        const table = TRANSITIONS[this.state];
        if (!table || !(event in table)) return false;
        const from = this.state;
        this.state = table[event];
        this.stateSince = this._now();
        this._record(event, from, this.state);
        return true;
    }

    get current() { return this.state; }

    /** Milliseconds spent in the current state. */
    timeInState() { return this._now() - this.stateSince; }

    /** Begin an activity (enters ACT; resumes are funneled through RESUME first). */
    beginActivity(name) {
        this.activity = name || 'unnamed';
        if (this.state === STATES.RESUME && !this.transition('act')) {
            this._force(STATES.ACT, 'beginActivity');
        } else if (this.state !== STATES.ACT && !this.transition('act')) {
            this._force(STATES.ACT, 'beginActivity');
        }
        return this.state === STATES.ACT;
    }

    /** The activity succeeded verification. Clears activity. */
    finish(success = true) {
        if (this.state === STATES.ACT) this.transition('verify');
        this.lastResult = success ? 'succeeded' : 'failed';
        if (this.state === STATES.VERIFY) this.transition(success ? 'succeeded' : 'failed');
        if (this.state !== STATES.IDLE) this._force(STATES.IDLE, 'finish');
        this.activity = null;
        return this.state === STATES.IDLE;
    }

    /** Something demanded attention; remember the activity and react. */
    react(reason = null) {
        if (this.activity && this.state !== STATES.INTERRUPTED) {
            this._pushStack({ activity: this.activity, reason: reason || null });
        }
        if (this.state === STATES.ACT) this.transition('react');
        else if (this.state !== STATES.REACT) this._force(STATES.REACT, 'react');
        return this.state === STATES.REACT;
    }

    /** Hard interruption (damage, danger). */
    interrupt(reason = null) {
        if (this.activity && this.state !== STATES.INTERRUPTED) {
            this._pushStack({ activity: this.activity, reason: reason || null });
        }
        if (this.state === STATES.ACT) this.transition('interrupted');
        else if (this.state !== STATES.INTERRUPTED) this._force(STATES.INTERRUPTED, 'interrupt');
        this.activity = null;
        return this.state === STATES.INTERRUPTED;
    }

    /** Stabilizing after a react/interrupt. */
    recover() {
        if (this.state === STATES.REACT || this.state === STATES.INTERRUPTED) this.transition('recover');
        else if (this.state !== STATES.RECOVER) this._force(STATES.RECOVER, 'recover');
        return this.state === STATES.RECOVER;
    }

    /**
     * Resume the most recently remembered activity.
     * @returns {string|null} the activity name to resume (null if none).
     */
    resume() {
        if (this.state === STATES.REACT || this.state === STATES.INTERRUPTED || this.state === STATES.RECOVER)
            this.transition('resume');
        else if (this.state !== STATES.RESUME) this._force(STATES.RESUME, 'resume');
        const entry = this.activityStack.pop();
        if (entry) this.activity = entry.activity;
        return entry ? entry.activity : null;
    }

    /** Whether there is a remembered activity waiting to be resumed. */
    hasPendingResume() { return this.activityStack.length > 0; }

    peekPendingResume() { return this.activityStack.length ? this.activityStack[this.activityStack.length - 1].activity : null; }

    _pushStack(entry) {
        this.activityStack.push(entry);
        if (this.activityStack.length > STACK_LIMIT)
            this.activityStack.splice(0, this.activityStack.length - STACK_LIMIT);
    }

    _force(state, event) {
        const from = this.state;
        this.state = state;
        this.stateSince = this._now();
        this._record(event, from, state);
    }

    toJSON() {
        return {
            state: this.state,
            activity: this.activity,
            pendingResume: this.activityStack.map(e => e.activity),
            lastResult: this.lastResult,
            timeInState: this.timeInState()
        };
    }
}
