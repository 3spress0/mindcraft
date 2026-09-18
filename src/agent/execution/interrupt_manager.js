import { EventBus } from './event_bus.js';

export const INTERRUPT_PRIORITIES = Object.freeze({
    LOW: 0,
    MEDIUM: 1,
    HIGH: 2,
    CRITICAL: 3,
});

const DEFAULT_RULES = Object.freeze({
    'danger.detected': 'CRITICAL',
    'health.low': 'CRITICAL',
    'server.disconnected': 'CRITICAL',
    'player.died': 'CRITICAL',
    'entity.approaching': 'HIGH',
    'target.lost': 'HIGH',
    'path.blocked': 'HIGH',
    'tool.broken': 'MEDIUM',
    'inventory.full': 'MEDIUM',
    'danger.cleared': 'LOW',
    'goal.completed': 'LOW',
    'goal.failed': 'LOW',
});

function normalizePriority(priority) {
    if (typeof priority === 'number') return Math.max(0, Math.min(3, priority));
    return INTERRUPT_PRIORITIES[String(priority || 'LOW').toUpperCase()] ?? INTERRUPT_PRIORITIES.LOW;
}

/**
 * Converts raw runtime events into interrupt decisions. It does not decide
 * whether to fight or retreat; that is a skill/recovery policy concern.
 */
export class InterruptManager {
    constructor({ eventBus = new EventBus(), rules = {}, onInterrupt = null } = {}) {
        this.eventBus = eventBus;
        this.rules = { ...DEFAULT_RULES, ...rules };
        this.onInterrupt = onInterrupt;
        this.current = null;
        this.pending = [];
        this._unsubscribe = this.eventBus.on('*', event => this.handle(event.type, event.data, event));
    }

    priorityFor(type) {
        return normalizePriority(this.rules[type]);
    }

    async handle(type, data = {}, event = null) {
        const priority = this.priorityFor(type);
        const interrupt = {
            type,
            data,
            priority,
            priorityName: Object.keys(INTERRUPT_PRIORITIES).find(key => INTERRUPT_PRIORITIES[key] === priority),
            at: event?.at ?? Date.now(),
        };
        if (priority === INTERRUPT_PRIORITIES.LOW) {
            this.pending.push(interrupt);
            if (this.pending.length > 64) this.pending.shift();
            return { interrupted: false, interrupt };
        }
        // A running task owns the controller for its atomic work. Medium
        // events are recorded for the next checkpoint; only HIGH/CRITICAL
        // events preempt it immediately.
        if (this.current?.taskId && priority < INTERRUPT_PRIORITIES.HIGH) {
            this.pending.push(interrupt);
            return { interrupted: false, queued: true, interrupt };
        }
        if (this.current && priority < this.current.priority) {
            this.pending.push(interrupt);
            return { interrupted: false, queued: true, interrupt };
        }
        this.current = interrupt;
        try {
            await this.onInterrupt?.(interrupt);
        } catch (error) {
            interrupt.handlerError = error;
        }
        return { interrupted: true, interrupt };
    }

    begin(taskId, priority = 'LOW') {
        this.current = { taskId, priority: normalizePriority(priority), priorityName: String(priority).toUpperCase(), at: Date.now() };
    }

    end(taskId = null) {
        if (!taskId || this.current?.taskId === taskId) this.current = null;
        return this.drainPending();
    }

    drainPending() {
        const pending = [...this.pending];
        this.pending.length = 0;
        return pending.sort((a, b) => b.priority - a.priority || a.at - b.at);
    }

    snapshot() {
        return { current: this.current ? { ...this.current } : null, pending: this.pending.map(item => ({ ...item })) };
    }

    dispose() {
        this._unsubscribe?.();
        this.pending.length = 0;
        this.current = null;
    }
}
