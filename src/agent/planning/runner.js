/**
 * runner.js — the planner → executor → observer → critic → replanner loop.
 *
 * The runner owns the lifecycle of a single active Project. The LLM never
 * drives control flow directly: the model plans (Planner), the existing ReAct
 * machinery executes one step at a time via transient system messages, the
 * Observer measures what actually changed in the world, and the Critic decides
 * whether reality matches the step's expected outcome. Deterministic recovery
 * policy then chooses continue / retry / replan / ask-human / abort.
 *
 * The runner is deliberately cooperative with the rest of the agent: user
 * messages still interrupt the executing turn (normal message queue), !stop /
 * !planStop / !stfu halt the loop, and state is persisted after every
 * transition so a restart resumes mid-project.
 */

import settings from '../settings.js';
import { Planner } from './planner.js';
import { Critic, OUTCOME } from './critic.js';
import { decideRecoveryContext } from './recovery.js';
import { RECOVERY_ACTION, RETRY_FAMILY } from './policies.js';
import { captureState } from './observer.js';
import { Project, ProjectStore, PROJECT, STEP } from './plan.js';
import { ingestVerifiedStep, syncProject } from '../observation/ingest.js';
import { describeDelta } from '../observation/transitions.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class PlanRunner {
    constructor(agent, { planner = null, critic = null, store = null } = {}) {
        this.agent = agent;
        this.planner = planner || new Planner(agent);
        this.critic = critic || new Critic(agent);
        this.store = store || new ProjectStore(agent.name);
        this.project = null;
        this.loopActive = false;
        this.interrupt = false;
        this.executions = 0;
        this.replanCount = 0;
    }

    config() {
        return {
            max_step_attempts: 2,
            max_replans: 3,
            max_executions: 60,
            executor_max_responses: 6,
            step_cooldown_ms: 1500,
            autoresume: true,
            freeform_critic: true,
            recovery_profile: 'default', // default | explorer | builder | survival
            recovery_policies: null,     // optional per-profile action overrides
            danger_health_threshold: 6,  // <= this health with threats nearby = critical
            threat_radius: 16,           // world-model threats counted as nearby danger
            ...(settings.planning || {}),
        };
    }

    isRunning() {
        return this.loopActive;
    }

    /** Used by the ReAct turn's interrupt check (source 'system' executor turns). */
    shouldInterrupt() {
        return this.loopActive && this.interrupt;
    }

    isActive() {
        return this.project && (this.project.status === PROJECT.ACTIVE || this.project.status === PROJECT.PLANNING);
    }

    /**
     * Create a plan for a goal and start executing it.
     */
    async start(goal, { resumeExisting = false } = {}) {
        if (this.loopActive) return { ok: false, message: 'A plan is already running. Use !planStop first.' };

        // The planner loop replaces the generic self-prompt loop for this goal.
        if (this.agent.self_prompter?.isActive()) {
            await this.agent.self_prompter.stop(false);
        }
        if (!resumeExisting) this.store.clear();
        this.agent.openChat(`Planning: ${goal}`);
        const { project, warnings } = await this.planner.createPlan(goal);
        this.project = project;
        this.executions = 0;
        this.replanCount = project.iteration - 1;
        this.persist();

        const planText = renderPlanOutline(project);
        this.agent.openChat(`Plan ready (${project.progress().total} actionable steps across ${project.phases.length} phase${project.phases.length > 1 ? 'es' : ''}):\n${planText}`);
        if (warnings.length) this.agent.history.add('system', `Plan created with warnings: ${warnings.join('; ')}`);
        this.agent.history.add('system', `Started planned project "${goal}": ${project.progress().total} actionable steps across ${project.phases.length} phase(s).`);
        await this.agent.history.save();

        this._launchLoop();
        return { ok: true, project };
    }

    _launchLoop() {
        if (this.loopPromise) return;
        this.loopPromise = this.runLoop()
            .catch((err) => this.fatal(err))
            .finally(() => { this.loopPromise = null; });
    }

    /** Resolve once the current loop reaches done/paused/failed. Tests and shutdown use this. */
    async waitForCompletion() {
        if (this.loopPromise) await this.loopPromise;
    }

    /** Resume a paused or persisted project. */
    async resume() {
        if (this.loopActive) return { ok: false, message: 'Plan loop already running.' };
        if (!this.project) this.project = this.store.load();
        if (!this.project) return { ok: false, message: 'No paused project to resume.' };
        this.project.status = PROJECT.ACTIVE;
        // Re-arm interrupted/blocked work: an ACTIVE step never finished
        // verification and a BLOCKED/FAILED step may now be achievable.
        for (const s of this.project.steps) {
            if (s.status === STEP.BLOCKED || s.status === STEP.ACTIVE) s.status = STEP.PENDING;
        }
        this.persist();
        this.agent.openChat(`Resuming project: ${this.project.goal}`);
        this._launchLoop();
        return { ok: true, project: this.project };
    }

    /** Stop the loop. pause=true persists for resume; false ends the project. */
    async stop({ pause = true, message = null } = {}) {
        this.interrupt = true;
        // Interrupt an in-flight executor ReAct turn (LLM generation or tool call).
        this.agent.abortActiveLLMRequest?.('Plan stopped by user.');
        await this.agent.actions.stop();
        while (this.loopActive) await sleep(200);
        if (this.project) {
            if (pause) {
                this.project.status = PROJECT.PAUSED;
                this.project.touch(message || 'paused by user');
                this.persist();
            } else {
                this.project.status = PROJECT.FAILED;
                this.project.touch(message || 'stopped by user');
                this.persist();
            }
        }
        this.interrupt = false;
        return true;
    }

    statusText() {
        if (!this.project) return 'No active project. Start one with !plan <goal>.';
        return this.project.render();
    }

    persist() {
        if (this.project) this.store.save(this.project);
        syncProject(this.agent.world_model, this.project);
        this.agent.observation_collector?.saveNow?.();
    }

    /** Record verified step results as world-model facts (never throws into loop). */
    ingest(step, outcome) {
        try {
            ingestVerifiedStep(this.agent.world_model, {
                step,
                before: outcome.before,
                after: outcome.after,
                critique: outcome.critique,
            });
            syncProject(this.agent.world_model, this.project);
            this.agent.observation_collector?.saveNow?.();
        } catch (err) {
            console.warn('[planning] world-model ingest failed:', err.message);
        }
    }

    shouldHalt() {
        const a = this.agent;
        return this.interrupt || a.shut_up || !a.bot || a.bot.health <= 0;
    }

    async runLoop() {
        if (this.loopActive) return;
        this.loopActive = true;
        this.interrupt = false;
        const cfg = this.config();

        try {
            while (!this.shouldHalt()) {
                if (!this.project) break;
                const depBlocked = this.project.dependencyBlocked();
                if (depBlocked && !this.project.nextStep()) {
                    this.block(depBlocked, 'step dependencies can never be satisfied');
                    break;
                }
                const step = this.project.nextStep();
                if (!step) break; // nothing open left; refreshStatus sets DONE
                if (this.executions >= cfg.max_executions) {
                    this.block(step, `execution safety cap (${cfg.max_executions}) reached`);
                    break;
                }

                this.project.markActive(step);
                this.persist();
                this.announceStep(step);

                const outcome = await this.executeStep(step, cfg);
                this.executions += 1;
                if (this.shouldHalt()) break;

                // Verified results become durable world facts; the model never
                // rediscovers what a previous step already established.
                this.ingest(step, outcome);

                if (outcome.critique.outcome === OUTCOME.SUCCESS || outcome.critique.outcome === OUTCOME.PARTIAL) {
                    this.project.markDone(step, outcome.critique.reasoning);
                    this.persist();
                    const prefix = outcome.critique.outcome === OUTCOME.PARTIAL ? 'Step partially verified, moving on: ' : 'Step done: ';
                    this.agent.openChat(`${prefix}${step.title} (${outcome.critique.reasoning})`);
                    await sleep(cfg.step_cooldown_ms);
                    continue;
                }

                // World-model-aware, policy-driven recovery with explicit reason + evidence.
                const decision = decideRecoveryContext({
                    outcome: outcome.critique.outcome,
                    failureClass: outcome.critique.failureClass,
                    attempts: step.attempts,
                    maxAttempts: cfg.max_step_attempts,
                    replanCount: this.replanCount,
                    maxReplans: cfg.max_replans,
                    step,
                    before: outcome.before,
                    after: outcome.after,
                    critique: outcome.critique,
                    worldModel: this.agent.world_model || null,
                    profile: cfg.recovery_profile,
                    policyOverrides: cfg.recovery_policies,
                    dangerHealthThreshold: cfg.danger_health_threshold,
                    threatRadius: cfg.threat_radius,
                });
                step.lastRecovery = decision;
                this.project.markFailed(step,
                    `${decision.reason}: ${outcome.critique.reasoning || outcome.critique.failureClass}`,
                    outcome.critique.diffText);
                this.persist();

                if (RETRY_FAMILY.has(decision.action)) {
                    const evidence = decision.evidence.length ? ` \u2014 ${decision.evidence.join('; ')}` : '';
                    this.agent.openChat(`Recovery [${cfg.recovery_profile}:${decision.action}] ${step.title}: ${decision.reason}${evidence}`);
                    await sleep(cfg.step_cooldown_ms);
                    continue;
                }
                if (decision.action === RECOVERY_ACTION.REPLAN) {
                    const replanned = await this.doReplan(step, { ...outcome.critique, recovery: decision });
                    if (replanned === true) {
                        await sleep(cfg.step_cooldown_ms);
                        continue;
                    }
                    if (replanned === 'aborted') break; // planner declared goal impossible
                }
                if (decision.action === RECOVERY_ACTION.ABORT) {
                    this.abort(step, { reasoning: `${decision.reason}: ${decision.evidence.join('; ')}` });
                    break;
                }
                // HUMAN: pause with the explicit reason and evidence.
                this.block(step, `${decision.reason}: ${decision.evidence.join('; ') || outcome.critique.reasoning}`);
                break;
            }

            if (this.project && this.project.status === PROJECT.DONE) this.finish();
        } catch (err) {
            this.fatal(err);
        } finally {
            // A stop() caller persists its own state; but if the loop exited for
            // death or another reason, make sure the project is resumable rather
            // than left looking ACTIVE while nothing is driving it.
            if (this.project && (this.project.status === PROJECT.ACTIVE || this.project.status === PROJECT.PLANNING)) {
                this.project.status = PROJECT.PAUSED;
                this.project.touch(this.agent.bot?.health <= 0 ? 'bot died; project paused' : 'loop stopped; project paused');
                this.persist();
            }
            this.loopActive = false;
        }
    }

    async executeStep(step, cfg) {
        const before = captureState(this.agent);
        const progress = this.project.progress();
        const expectedText = describeExpected(step.expected);
        const deltaText = describeDelta(step.expectedDelta);
        const recoveryHint = step.lastRecovery?.guidance ?
            `\nRECOVERY FROM PREVIOUS FAILURE (${step.lastRecovery.reason}):\n${step.lastRecovery.guidance}` :
            (step.attempts > 1 && step.criticNote ?
                `\nYour previous attempt did NOT verify: ${step.criticNote}. Change your approach.` : '');

        const message = [
            `You are executing step ${progress.done + 1} of ${progress.total} of a planned project.`,
            `Overall goal: ${this.project.goal}`,
            '',
            `CURRENT STEP: ${step.title}`,
            `Instruction: ${step.instruction}`,
            `This step is verified complete when: ${expectedText}`,
            deltaText ? `Additionally, this exact state change must occur: ${deltaText}.` : null,
            recoveryHint,
            '',
            'Work on ONLY this step now, using whichever commands or tools you need. As soon as the step is',
            'verifiably done (or you are blocked and cannot proceed), stop and report.',
        ].filter(Boolean).join('\n');

        let usedCommand = false;
        try {
            usedCommand = await this.agent.handleMessage('system', message, cfg.executor_max_responses, { transient: true });
        } catch (err) {
            if (String(err.name || err.message).includes('Abort')) throw err;
            console.warn('[planning] executor turn error:', err.message);
        }
        // Give the world a beat to settle (items drop, block updates arrive).
        await sleep(300);
        const after = captureState(this.agent);

        const critique = await this.critic.evaluate(step, before, after, this.agent.bot.output || '', {
            freeformJudge: cfg.freeform_critic ? undefined : async () => null,
        });
        this.agent.bot.output = '';
        void usedCommand;
        return { before, after, critique };
    }

    async doReplan(failedStep, critique) {
        if (this.replanCount >= this.config().max_replans) return false;
        this.agent.openChat(`Replanning after failed step "${failedStep.title}" (${critique.failureClass})...`);
        const result = await this.planner.replan(this.project, failedStep, critique);
        if (!result) {
            console.warn('[planning] replanner produced no usable plan');
            return false;
        }
        if (result.impossible) {
            this.abort(failedStep, { reasoning: `planner declared goal impossible: ${result.reason}` });
            return 'aborted';
        }
        this.project.replaceRemaining(result.steps, critique.failureClass, result.phases || null);
        if (result.summary) this.project.summary = result.summary;
        this.replanCount += 1;
        this.persist();
        this.agent.openChat(`Revised plan (${result.steps.length} remaining steps):\n` +
            result.steps.map((s) => {
                const ph = this.project.phases.length > 1 ? `[${this.project.phaseById(s.phaseId).title}] ` : '';
                return `${ph}${s.title}`;
            }).join('\n'));
        return true;
    }

    announceStep(step) {
        const p = this.project.progress();
        const phase = this.project.phaseById(step.phaseId);
        const multi = this.project.phases.length > 1;
        const ph = multi ? ` · ${phase.title}` : '';
        this.agent.openChat(`[Plan ${p.pct}%${ph}] ${step.title}`);
    }

    block(step, reason) {
        this.project.markBlocked(step, reason);
        this.persist();
        const msg = `Project "${this.project.goal}" is paused at "${step.title}": ${reason}. ` +
            `Fix the issue and run !planResume, or !planStop to abandon it.`;
        this.agent.openChat(msg);
        this.agent.history.add('system', msg);
        void this.agent.history.save();
    }

    abort(step, critique) {
        this.project.status = PROJECT.FAILED;
        this.project.touch(`aborted: ${critique?.reasoning || critique?.failureClass || 'impossible'}`);
        this.persist();
        const msg = `Project "${this.project.goal}" aborted at "${step.title}": ${critique?.reasoning || critique?.failureClass}.`;
        this.agent.openChat(msg);
        this.agent.history.add('system', msg);
        void this.agent.history.save();
    }

    finish() {
        const goal = this.project.goal;
        const msg = `Project complete: ${goal}. All ${this.project.progress().total} steps verified.`;
        this.agent.openChat(msg);
        this.agent.history.add('system', msg);
        void this.agent.history.save();
        this.store.clear();
        this.agent.world_model?.clearProject(goal);
        this.agent.observation_collector?.saveNow?.();
        this.project = null;
    }

    fatal(err) {
        console.error('[planning] runner crashed:', err);
        try {
            if (this.project) {
                this.project.status = PROJECT.PAUSED;
                this.project.touch(`runner error: ${err.message}`);
                this.persist();
            }
        } catch { /* persistence best effort */ }
        this.loopActive = false;
    }

    /** Load any persisted unfinished project (called once after spawn). */
    async handleLoad() {
        if (!this.config().autoresume) return;
        const project = this.store.load();
        if (!project) return;
        if (project.status === PROJECT.DONE || project.status === PROJECT.FAILED) {
            this.store.clear();
            return;
        }
        this.project = project;
        this.replanCount = project.iteration - 1;
        if (project.status === PROJECT.ACTIVE || project.status === PROJECT.PLANNING) {
            if (this.agent.self_prompter?.isActive()) {
                await this.agent.self_prompter.stop(false);
            }
            this.agent.openChat(`Resuming interrupted project: ${project.goal} (${project.progress().done}/${project.progress().total} steps done).`);
            this._launchLoop();
        }
    }
}

/** Phase-grouped outline used for the "Plan ready" announcement. */
function renderPlanOutline(project) {
    if (project.phases.length <= 1) {
        return project.steps.map((s, i) => `${i + 1}. ${s.title}`).join('\n');
    }
    const lines = [];
    for (const phase of [...project.phases].sort((a, b) => a.order - b.order)) {
        const steps = project.steps.filter((s) => s.phaseId === phase.id);
        if (!steps.length) continue;
        lines.push(`${phase.title}:`);
        for (const s of steps) {
            const depth = s.parentId ? 2 : 1;
            lines.push(`${'  '.repeat(depth)}- ${s.title}`);
        }
    }
    return lines.join('\n');
}

export function describeExpected(expected) {
    if (!expected) return 'the instruction is completed';
    switch (expected.kind) {
        case 'inventory':
            return expected.gained != null
                ? `inventory gains at least ${expected.gained}x ${expected.item}`
                : `inventory contains at least ${expected.atLeast ?? 1}x ${expected.item}`;
        case 'near':
            return `bot is within ${expected.radius ?? 4} blocks of (${expected.x}, ${expected.y}, ${expected.z})`;
        case 'block_near':
            return `at least ${expected.atLeast ?? 1} ${expected.block} block(s) exist within ${expected.radius ?? 8} blocks`;
        case 'entity_near':
            return `at least ${expected.atLeast ?? 1} ${expected.entity} within ${expected.radius ?? 16} blocks`;
        case 'health_above':
            return `health stays at/above ${expected.level}`;
        case 'freeform':
        default:
            return expected.description;
    }
}

export { Project };
