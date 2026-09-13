/**
 * critic.js — evaluates an executed plan step against reality.
 *
 * Order of judgment:
 *   1. Deterministic observer checks (inventory/proximity/block/entity/health)
 *      decide automatically, no model call needed.
 *   2. "freeform" expectations and ambiguous outcomes go to the model with a
 *      strict JSON verdict request.
 *   3. The outcome is classified into a recovery class so the runner can
 *      decide retry vs replan vs ask-the-human without model round-trips.
 */

import { checkExpectation, stateDiff } from './observer.js';
import { checkTransition } from '../observation/transitions.js';

export const OUTCOME = {
    SUCCESS: 'success',
    PARTIAL: 'partial',
    FAILED: 'failed',
    BLOCKED: 'blocked',
};

export const RECOVERY = {
    RETRY: 'retry',           // transient; same step again
    REPLAN: 'replan',         // approach failed; planner revises remaining steps
    HUMAN: 'human',           // missing resources/permissions the bot cannot fix
    ABORT: 'abort',           // goal impossible
};

/**
 * Pure policy: given a verdict/classification and attempt budget, what next?
 */
export const NEXT = { CONTINUE: 'continue', RETRY: 'retry', REPLAN: 'replan', HUMAN: 'human', ABORT: 'abort' };

export function decideRecovery({ outcome, failureClass, attempts, maxAttempts, replanCount, maxReplans }) {
    if (outcome === OUTCOME.SUCCESS) return NEXT.CONTINUE;
    if (outcome === OUTCOME.PARTIAL) {
        // Treat progress-without-verification as a success (don't loop forever).
        return NEXT.CONTINUE;
    }
    if (failureClass === FAILURE.MISSING_RESOURCES) return NEXT.HUMAN;
    if (failureClass === FAILURE.IMPOSSIBLE) return NEXT.ABORT;
    if (replanCount >= maxReplans) return NEXT.HUMAN;
    if (attempts < maxAttempts && failureClass !== FAILURE.WRONG_APPROACH) return NEXT.RETRY;
    if (replanCount < maxReplans) return NEXT.REPLAN;
    return NEXT.HUMAN;
}

export const FAILURE = {
    NONE: 'none',
    TRANSIENT: 'transient',             // path blocked, chunk lag, interrupted
    NOT_OBTAINED: 'not_obtained',       // gather/craft step changed nothing
    TARGET_MISSING: 'target_missing',   // requested block/entity not found
    WRONG_APPROACH: 'wrong_approach',   // method itself failed, needs different steps
    DANGER: 'danger',                   // took damage / died
    MISSING_RESOURCES: 'missing_resources',
    IMPOSSIBLE: 'impossible',
    HUMAN: 'human',
    CONSTRUCTION_DAMAGED: 'construction_damaged', // expected structure was damaged/destroyed
};

/**
 * Heuristic failure classifier over the observation diff + step text. The LLM
 * critic may override with its own `failure_class`; this keeps classification
 * working even when the model isn't available.
 */
export function classifyFailure({ stepText = '', diff = {}, resultText = '', evidence = '', died = false } = {}) {
    const haystack = `${stepText}\n${resultText}\n${diff?.text || ''}\n${evidence}`.toLowerCase();

    if (died || diff.healthDelta <= -6) return FAILURE.DANGER;
    if (/\b(construction damaged|structure damaged|blocks destroyed|building damaged|farm damaged|mismatched blocks|structure intact|expected \d+ blocks)\b/.test(haystack) ||
        (/\b(damaged|destroyed|missing)\b/.test(haystack) && /\b(blocks|structure|construction|build)\b/.test(haystack) && /mismatched|expected/.test(haystack))) {
        return FAILURE.CONSTRUCTION_DAMAGED;
    }
    if (/\b(no permission|not allowed|operator|whitelist|need op|cannot craft|missing ingredient|out of materials|don't have|do not have)\b/.test(haystack)) {
        return FAILURE.MISSING_RESOURCES;
    }
    if (/\b(can't find|cannot find|could not find|not found|no such|no .{0,20} nearby|out of range)\b/.test(haystack)) {
        return FAILURE.TARGET_MISSING;
    }
    if (/\b(no path|path blocked|cannot reach|can't reach|unreachable|stuck|obstructed|destination too far)\b/.test(haystack)) {
        return FAILURE.TRANSIENT;
    }
    if (/\b(impossible|unsupported|cannot be done|doesn't exist|does not exist|invalid)\b/.test(haystack)) {
        return FAILURE.IMPOSSIBLE;
    }
    // A declared state transition that did not happen (LLM claimed success).
    if (/mismatch/.test(haystack) &&
        /\b(gather|collect|mine|craft|smelt|make|get|obtain|farm|place|build|cook)\b/.test(haystack)) {
        return FAILURE.NOT_OBTAINED;
    }
    // Gather-style step with no inventory gain and no movement is a failed method.
    if (/\b(gather|collect|mine|craft|get|obtain|farm|smelt)\b/.test(haystack) &&
        Object.keys(diff.inventoryGained || {}).length === 0 && (diff.moved || 0) < 1) {
        return FAILURE.NOT_OBTAINED;
    }
    return FAILURE.WRONG_APPROACH;
}

const FREEFORM_SYSTEM = `You are a strict Minecraft build/action verifier. You are given a plan step, its\nintended outcome, the observed world-state change, and the action output. Decide whether the\nstep genuinely SUCCEEDED in the Minecraft world.\n\n- SUCCESS only when the evidence shows the intended outcome was achieved.\n- PARTIAL when real progress happened but it is clearly unfinished.\n- BLOCKED when a missing resource, permission or external help is required.\n- FAILED otherwise (no relevant change, wrong target, errors).\n\nClassify failure_class as one of: transient, not_obtained, target_missing, wrong_approach,\ndanger, missing_resources, impossible, human, or "none".\n\nRespond with ONLY compact JSON:\n{"verdict":"success|partial|failed|blocked","reasoning":"one sentence evidence","failure_class":"none"}`;

export class Critic {
    constructor(agent, { sendRequest = null } = {}) {
        this.agent = agent;
        this._sendRequest = sendRequest;
    }

    async modelJudge({ step, expected, diffText, resultText }) {
        const user = [
            `STEP: ${step.title}`,
            `INTENDED OUTCOME: ${expected.description || JSON.stringify(expected)}`,
            '',
            'OBSERVED WORLD CHANGE:',
            diffText || 'none',
            '',
            'ACTION OUTPUT:',
            resultText || '(none recorded)',
        ].join('\n');
        try {
            let res;
            if (this._sendRequest) {
                res = await this._sendRequest([{ role: 'user', content: user }], FREEFORM_SYSTEM);
            } else {
                const model = this.agent.prompter.chat_model;
                res = await model.sendRequest(
                    [{ role: 'user', content: user }], FREEFORM_SYSTEM, '***', null,
                    { cacheScope: 'planningCritic', transportCacheScope: 'planningCritic' }
                );
            }
            return extractVerdictJSON(res);
        } catch (err) {
            if (String(err.name || err.message).includes('Abort')) throw err;
            console.warn('[planning] critic model call failed, falling back to heuristics:', err.message);
            return null;
        }
    }

    /**
     * @param step       PlanStep just attempted
     * @param before/after observer captures
     * @param resultText  action-runner textual result (command outputs)
     * @param options    { freeformJudge: async (context) => verdictObject }
     */
    async evaluate(step, before, after, resultText = '', options = {}) {
        const diff = stateDiff(before, after);
        const died = after ? Boolean(this.agent.bot?.health <= 0) : false;

        const check = checkExpectation(this.agent, step.expected, before, after);
        const transition = step.expectedDelta ?
            checkTransition(step.expectedDelta, before, after) :
            { decidable: false, satisfied: false, results: [], evidence: null };
        let outcome;
        let reasoning;
        let failureClass = FAILURE.NONE;

        // A declared state transition that did not happen is an automatic,
        // deterministic failure — no matter what the LLM reported.
        const transitionFailed = transition.decidable && !transition.satisfied;
        const deterministicFailed = (check.decidable && !check.satisfied) || transitionFailed;

        if (transitionFailed) {
            outcome = OUTCOME.FAILED;
            const also = check.decidable && !check.satisfied ? ` Also, ${check.evidence}` : '';
            reasoning = `expected state transition not observed: ${transition.evidence}${also}`;
        } else if (check.decidable) {
            outcome = check.satisfied ? OUTCOME.SUCCESS : OUTCOME.FAILED;
            reasoning = [check.evidence, transition.decidable ? transition.evidence : null]
                .filter(Boolean).join('; ');
        } else if (transition.decidable && transition.satisfied) {
            // Freeform outcome goal but the declared transition verified: trust
            // the deterministic contract and skip the model round-trip.
            outcome = OUTCOME.SUCCESS;
            reasoning = `verified state transition: ${transition.evidence}`;
        } else {
            // freeform: model judge (overridable), with heuristic fallback
            const judge = options.freeformJudge || ((ctx) => this.modelJudge(ctx));
            const modelVerdict = await judge({
                step,
                expected: step.expected,
                diffText: diff.text,
                resultText: truncate(resultText, 1200),
            });
            if (modelVerdict) {
                outcome = mapModelOutcome(modelVerdict.verdict);
                reasoning = String(modelVerdict.reasoning || '').slice(0, 600);
                failureClass = modelVerdict.failure_class ?
                    (Object.values(FAILURE).includes(modelVerdict.failure_class) ? modelVerdict.failure_class : FAILURE.WRONG_APPROACH) :
                    FAILURE.NONE;
            } else {
                // No judge available: treat "something changed or command
                // reported completion" as success, otherwise failed.
                const lookedBusy = diff.moved >= 0.5 || Object.keys(diff.inventoryGained).length > 0;
                const textOk = /(complete|finished|success|placed|built|crafted|reached|found)/i.test(resultText);
                const textFail = /(!!|error|exception|failed|could not|can't reach)/i.test(resultText);
                if (textFail && !textOk) {
                    outcome = OUTCOME.FAILED;
                    reasoning = 'action reported an error';
                } else {
                    outcome = (lookedBusy || textOk) ? OUTCOME.SUCCESS : OUTCOME.FAILED;
                    reasoning = lookedBusy ? 'observable change occurred' : (textOk ? 'action reported completion' : 'no observable progress');
                }
            }
        }

        if (outcome !== OUTCOME.SUCCESS && failureClass === FAILURE.NONE) {
            failureClass = classifyFailure({
                stepText: `${step.title}\n${step.instruction}\n${step.expected?.description || ''}`,
                diff,
                resultText,
                evidence: transition.evidence || '',
                died,
            });
        }

        return {
            outcome,
            reasoning,
            failureClass,
            evidence: [check.decidable ? check.evidence : null, transition.decidable ? transition.evidence : null]
                .filter(Boolean).join('; ') || null,
            transition: transition.decidable ? {
                satisfied: transition.satisfied,
                results: transition.results,
                evidence: transition.evidence,
            } : null,
            diffText: diff.text,
            at: Date.now(),
        };
    }
}

function extractVerdictJSON(text) {
    let raw = String(text || '').trim();
    const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fence) raw = fence[1].trim();
    const start = raw.indexOf('{');
    const end = raw.lastIndexOf('}');
    if (start === -1 || end <= start) throw new Error('no verdict JSON');
    return JSON.parse(raw.slice(start, end + 1));
}

function mapModelOutcome(v) {
    const value = String(v || '').toLowerCase();
    if (value.startsWith('succ')) return OUTCOME.SUCCESS;
    if (value.startsWith('part')) return OUTCOME.PARTIAL;
    if (value.startsWith('block')) return OUTCOME.BLOCKED;
    return OUTCOME.FAILED;
}

function truncate(text, n) {
    text = String(text || '');
    return text.length > n ? text.slice(0, n) + '…' : text;
}
