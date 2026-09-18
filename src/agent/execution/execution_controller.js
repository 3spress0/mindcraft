import { EventBus } from './event_bus.js';
import { InterruptManager, INTERRUPT_PRIORITIES } from './interrupt_manager.js';
import { SkillRegistry } from './skill_registry.js';

function asError(value) {
    return value instanceof Error ? value : new Error(String(value));
}

/**
 * Owns one active high-level skill at a time. Mineflayer actions remain the
 * implementation detail of skills; planners submit a goal and do not fight
 * over pathfinder/control state directly.
 */
export class ExecutionController {
    constructor({ agent = null, bot = null, eventBus = new EventBus(), registry = new SkillRegistry(), stateStore = null } = {}) {
        this.agent = agent;
        this.bot = bot ?? agent?.bot ?? null;
        this.eventBus = eventBus;
        this.registry = registry;
        this.stateStore = stateStore;
        this.active = null;
        this.sequence = 0;
        this.disposed = false;
        this.interruptManager = new InterruptManager({
            eventBus,
            onInterrupt: interrupt => this._onInterrupt(interrupt),
        });
    }

    async _onInterrupt(interrupt) {
        if (!this.active) return;
        const policy = this.active.interruptPolicy?.[interrupt.type] ||
            this.active.interruptPolicy?.[interrupt.type.split('.')[0] + '.*'];
        if (policy === 'ignore') return;
        if (policy === 'checkpoint' || interrupt.priority < INTERRUPT_PRIORITIES.HIGH) {
            this.active.pendingInterrupts.push(interrupt);
            return;
        }
        this.active.lastInterrupt = interrupt;
        this.active.abortController.abort(new Error(`Interrupted by ${interrupt.type}`));
        // Abort the actual Mineflayer operation as well as the skill promise.
        // Skills may be waiting inside dig/goto/collectblock and cannot
        // observe AbortSignal until those operations return.
        try { await this.agent?.requestInterrupt?.(); } catch { /* safety path must not throw */ }
        await this.eventBus.publish('skill.interrupted', {
            taskId: this.active.taskId,
            skill: this.active.skill,
            interrupt,
        }, { source: 'execution-controller' });
    }

    register(name, definition) {
        return this.registry.register(name, definition);
    }

    registerMany(definitions = {}) {
        for (const [name, definition] of Object.entries(definitions)) this.register(name, definition);
        return this;
    }

    isBusy() {
        return !!this.active;
    }

    snapshot() {
        if (!this.active) return { active: false, interrupt: this.interruptManager.snapshot() };
        return {
            active: true,
            taskId: this.active.taskId,
            goalId: this.active.goalId,
            skill: this.active.skill,
            args: this.active.args,
            startedAt: this.active.startedAt,
            progress: this.active.progress,
            lastInterrupt: this.active.lastInterrupt,
            pendingInterrupts: [...this.active.pendingInterrupts],
            interrupt: this.interruptManager.snapshot(),
        };
    }

    async _persist() {
        const snapshot = this.snapshot();
        if (typeof this.stateStore === 'function') await this.stateStore(snapshot);
        else if (this.stateStore?.save) await this.stateStore.save(snapshot);
    }

    async recoverableState() {
        if (this.stateStore?.load) return this.stateStore.load();
        return null;
    }

    async run(skillName, args = {}, { goalId = null, priority = 'LOW', resume = false } = {}) {
        if (this.disposed) throw new Error('ExecutionController is disposed');
        if (this.active) throw new Error(`ExecutionController is busy with ${this.active.skill}`);
        const skill = this.registry.get(skillName);
        if (!skill) throw new Error(`Unknown skill: ${skillName}. Available: ${this.registry.names().join(', ') || 'none'}`);
        const taskId = goalId || `task-${++this.sequence}`;
        const abortController = new AbortController();
        const state = {
            taskId,
            goalId: goalId || taskId,
            skill: skillName,
            interruptPolicy: skill.interruptPolicy,
            args,
            startedAt: Date.now(),
            progress: {},
            pendingInterrupts: [],
            lastInterrupt: null,
            abortController,
        };
        this.active = state;
        this.interruptManager.begin(taskId, priority);
        const context = {
            agent: this.agent,
            bot: this.bot ?? this.agent?.bot,
            eventBus: this.eventBus,
            signal: abortController.signal,
            taskId,
            args,
            resume,
            get progress() { return state.progress; },
            setProgress: (progress) => { state.progress = { ...state.progress, ...progress }; this._persist().catch(() => {}); },
            checkpoint: () => {
                if (abortController.signal.aborted) throw asError(abortController.signal.reason || 'skill interrupted');
                return state.progress;
            },
        };
        const result = { taskId, skill: skillName, status: 'failed', value: null, error: null };
        try {
            const precondition = await skill.preconditions(context, args);
            if (precondition === false) throw new Error(`Preconditions failed for skill ${skillName}`);
            await this._persist();
            await this.eventBus.publish('skill.started', { taskId, skill: skillName, args, resume }, { source: 'execution-controller' });
            result.value = await skill.execute(context, args);
            context.checkpoint();
            const successful = await skill.success(context, result.value, args);
            if (successful === false) throw new Error(`Success conditions failed for skill ${skillName}`);
            result.status = 'completed';
            await this.eventBus.publish('goal.completed', { taskId, skill: skillName, result: result.value }, { source: 'execution-controller' });
        } catch (error) {
            result.error = asError(error);
            if (abortController.signal.aborted || state.lastInterrupt) {
                result.status = 'interrupted';
            }
            await this.eventBus.publish(result.status === 'interrupted' ? 'skill.interrupted' : 'goal.failed', {
                taskId, skill: skillName, error: result.error.message, interrupt: state.lastInterrupt,
            }, { source: 'execution-controller' });
            if (result.status === 'failed' && skill.recovery) {
                try { result.recovery = await skill.recovery(context, result.error, args); } catch (recoveryError) { result.recoveryError = asError(recoveryError); }
            }
        } finally {
            result.progress = { ...state.progress };
            await this._persist();
            this.interruptManager.end(taskId);
            this.active = null;
            // requestInterrupt uses Mineflayer's shared interrupt flag. Clear
            // it after the controlled skill has unwound so later skills can
            // start normally.
            if (state.lastInterrupt && this.bot) this.bot.interrupt_code = false;
            await this._persist();
        }
        return result;
    }

    cancel(reason = 'cancelled') {
        if (!this.active) return false;
        this.active.lastInterrupt = { type: 'execution.cancelled', data: { reason }, priority: INTERRUPT_PRIORITIES.HIGH, at: Date.now() };
        this.active.abortController.abort(new Error(reason));
        return true;
    }

    dispose() {
        this.cancel('controller disposed');
        this.interruptManager.dispose();
        this.disposed = true;
    }
}
