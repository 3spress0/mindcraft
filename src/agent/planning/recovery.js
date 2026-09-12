/**
 * recovery.js — world-model-aware recovery decisions.
 *
 * The Critic answers "did the step achieve its contract?" and labels the
 * failure class. This module answers "what do we DO about it?" using:
 *   1. the bot's configured policy profile (policies.js),
 *   2. the WorldModel — known deposits, depleted sources, last-seen targets,
 *      active threats, safe locations, current health,
 *   3. attempt/replan budgets.
 *
 * Every decision is explicit and explainable:
 *   { action, reason, evidence: [...], guidance, target }
 * guidance is the exact instruction injected into the executor's next turn;
 * evidence feeds !planStatus and the replanning prompt. No LLM is involved —
 * recovery control flow stays deterministic.
 */

import { OUTCOME, FAILURE } from './critic.js';
import { resolvePolicy, policyAction, RECOVERY_ACTION, RETRY_FAMILY } from './policies.js';
import { recoveryContext } from '../world_model/queries.js';

export const RECOVERY_REASON = {
    GOAL_IMPOSSIBLE: 'goal_impossible',
    PATH_BLOCKED: 'path_blocked',
    TRANSIENT_GLITCH: 'transient_glitch',
    TARGET_DEPLETED: 'target_depleted',
    ALTERNATE_DEPOSIT_KNOWN: 'alternate_deposit_known',
    DEPOSIT_KNOWN: 'deposit_known',
    DEPOSIT_UNKNOWN: 'deposit_unknown',
    MATERIALS_MISSING: 'materials_missing',
    PERMISSION_REQUIRED: 'permission_required',
    KNOWN_TARGET_ELSEWHERE: 'known_target_elsewhere',
    SEARCHING_TARGET: 'searching_target',
    DANGER_NEARBY: 'danger_nearby',
    CRITICAL_HEALTH: 'critical_health',
    APPROACH_FAILED: 'approach_failed',
    RETRY_BUDGET_EXHAUSTED: 'retry_budget_exhausted',
    SEARCH_EXHAUSTED: 'search_exhausted',
    DANGER_PERSISTS: 'danger_persists',
    REPLANS_EXHAUSTED: 'replans_exhausted',
};

const PERMISSION_RE = /\b(permission|not allowed|need op|operator|whitelist|protected|claimed land|cannot build here|not permitted)\b/i;
const PATH_RE = /\b(no path|path blocked|cannot reach|can't reach|unreachable|stuck|obstructed|destination too far|fell|couldn't get to)\b/i;

export function decideRecoveryContext({
    outcome,
    failureClass = FAILURE.NONE,
    attempts = 0,
    maxAttempts = 2,
    replanCount = 0,
    maxReplans = 3,
    step = null,
    before = null,
    after = null,
    critique = null,
    worldModel = null,
    profile = 'default',
    policyOverrides = null,
    dangerHealthThreshold = 6,
    threatRadius = 16,
} = {}) {
    if (outcome === OUTCOME.SUCCESS || outcome === OUTCOME.PARTIAL) {
        return decision(RECOVERY_ACTION.CONTINUE, 'verified', []);
    }

    const pos = after?.position || before?.position || worldModel?.player?.position || null;
    const ctx = worldModel ? recoveryContext(worldModel, step, pos, { threatRadius }) : null;
    const policy = resolvePolicy(profile, policyOverrides);
    const text = `${critique?.reasoning || ''}\n${critique?.diffText || ''}`;
    const health = after?.health ?? ctx?.health ?? 20;
    const retriesLeft = attempts < maxAttempts;
    const evidence = [];

    const dec = (action, reason, more = []) => decision(action, reason, [...evidence, ...more], step, pos, ctx);

    // 1) Hard impossibility and permission walls never benefit from retries.
    if (failureClass === FAILURE.IMPOSSIBLE) {
        return dec(RECOVERY_ACTION.ABORT, RECOVERY_REASON.GOAL_IMPOSSIBLE,
            [critique?.reasoning || 'planner/critic judged the goal impossible']);
    }
    if (PERMISSION_RE.test(text)) {
        return dec(RECOVERY_ACTION.HUMAN, RECOVERY_REASON.PERMISSION_REQUIRED,
            ['a permission or protected-area restriction blocks the step']);
    }

    // 2) Danger first: survive before completing the task.
    const threats = ctx?.threats || [];
    if (failureClass === FAILURE.DANGER || threats.some((t) => t.distance <= 8)) {
        const threatText = threats.slice(0, 3)
            .map((t) => `${t.fact.name} ${Math.round(t.distance)}m away`).join(', ');
        if (threatText) evidence.push(`active threats: ${threatText}`);
        evidence.push(`health ${health}/20`);
        if (health <= dangerHealthThreshold) {
            // At critical health only a KNOWN shelter is trusted; a synthesized
            // "away from threat" point is not enough to risk another attempt.
            if (ctx?.retreat?.kind === 'known_location') {
                return dec(RECOVERY_ACTION.RETREAT, RECOVERY_REASON.CRITICAL_HEALTH,
                    [`retreat point known: ${ctx.retreat.name}`]);
            }
            return dec(RECOVERY_ACTION.HUMAN, RECOVERY_REASON.CRITICAL_HEALTH,
                ['critically low health and no known safe location']);
        }
        if (ctx?.retreat) {
            return dec(RECOVERY_ACTION.RETREAT, RECOVERY_REASON.DANGER_NEARBY,
                [`retreat to ${ctx.retreat.name} first`]);
        }
        evidence.push('no known safe location — back away directly');
        return dec(retriesLeft ? RECOVERY_ACTION.RETREAT : RECOVERY_ACTION.HUMAN,
            RECOVERY_REASON.DANGER_NEARBY);
    }

    // 3) Location the bot could not reach: repath to the known coordinates.
    if (ctx?.target?.type === 'location' && PATH_RE.test(text)) {
        const { pos: targetPos, radius = 4 } = ctx.target;
        evidence.push(`target coordinates (${targetPos.x}, ${targetPos.y}, ${targetPos.z}) not reached`);
        return budgetRetry(dec(RECOVERY_ACTION.REPATH, RECOVERY_REASON.PATH_BLOCKED,
            [`choose a different route to within ${radius} blocks`]), retriesLeft, replanCount, maxReplans);
    }
    if (failureClass === FAILURE.TRANSIENT) {
        const reason = PATH_RE.test(text) ? RECOVERY_REASON.PATH_BLOCKED : RECOVERY_REASON.TRANSIENT_GLITCH;
        const preferred = policyAction(policy, FAILURE.TRANSIENT);
        const action = reason === RECOVERY_REASON.PATH_BLOCKED ? RECOVERY_ACTION.REPATH : preferred;
        return budgetRetry(dec(action, reason,
            [reason === RECOVERY_REASON.PATH_BLOCKED ? 'route was obstructed' : 'temporary interruption']),
        retriesLeft, replanCount, maxReplans);
    }

    // 4) Missing materials: gather them (known deposit -> navigate, else seek).
    if (failureClass === FAILURE.MISSING_RESOURCES || failureClass === FAILURE.NOT_OBTAINED) {
        const want = failureClass === FAILURE.MISSING_RESOURCES ?
            [...(ctx?.costQueries || []), ...(ctx?.itemQueries || [])] :
            (ctx?.itemQueries || []);
        const action = materialDecision(want, ctx, evidence, policy, failureClass);
        return budgetRetry(dec(action.action, action.reason, action.evidence),
            retriesLeft, replanCount, maxReplans, { exhausted: RECOVERY_ACTION.REPLAN });
    }

    // 5) Missing block/entity target: navigate to last known place or search.
    if (failureClass === FAILURE.TARGET_MISSING) {
        if (ctx?.knownTarget) {
            const t = ctx.knownTarget;
            evidence.push(`last seen ${ctx.target.name} ${Math.round(t.distance)}m away at (${t.fact.pos.x}, ${t.fact.pos.y}, ${t.fact.pos.z})`);
            return budgetRetry(dec(RECOVERY_ACTION.NAVIGATE, RECOVERY_REASON.KNOWN_TARGET_ELSEWHERE,
                ['a known sighting exists elsewhere']),
            retriesLeft, replanCount, maxReplans, { exhausted: RECOVERY_ACTION.REPLAN });
        }
        // A depleted nearby deposit with a known alternative is navigation.
        const resourceGuess = ctx?.itemQueries?.find((q) => q.alternative);
        if (resourceGuess) {
            return budgetRetry(
                dec(RECOVERY_ACTION.NAVIGATE, RECOVERY_REASON.ALTERNATE_DEPOSIT_KNOWN, depositEvidence(resourceGuess)),
                retriesLeft, replanCount, maxReplans, { exhausted: RECOVERY_ACTION.REPLAN });
        }
        const preferred = policyAction(policy, FAILURE.TARGET_MISSING);
        const action = preferred === RECOVERY_ACTION.NAVIGATE ? RECOVERY_ACTION.SEARCH : preferred;
        return budgetRetry(dec(action, RECOVERY_REASON.SEARCHING_TARGET,
            [`no known location of ${ctx?.target?.name || 'the target'} — explore to find it`]),
        retriesLeft, replanCount, maxReplans, { exhausted: RECOVERY_ACTION.REPLAN });
    }

    // 6) Wrong approach / anything else: replan, or honor the profile default.
    const preferred = policyAction(policy, failureClass || FAILURE.WRONG_APPROACH);
    if (RETRY_FAMILY.has(preferred)) {
        return budgetRetry(dec(preferred, RECOVERY_REASON.APPROACH_FAILED),
            retriesLeft, replanCount, maxReplans);
    }
    if (preferred === RECOVERY_ACTION.ABORT) {
        return dec(RECOVERY_ACTION.ABORT, RECOVERY_REASON.GOAL_IMPOSSIBLE);
    }
    if (replanCount >= maxReplans) {
        return dec(RECOVERY_ACTION.HUMAN, RECOVERY_REASON.REPLANS_EXHAUSTED,
            [`${maxReplans} plan revisions used`]);
    }
    return dec(RECOVERY_ACTION.REPLAN, RECOVERY_REASON.APPROACH_FAILED,
        ['the chosen method did not produce the required world change']);
}

/** Build a gather/navigate/search decision from per-item world queries. */
function materialDecision(want, ctx, evidence, policy, failureClass) {
    const withAlt = want.filter((q) => q.alternative);
    const withoutAlt = want.filter((q) => !q.alternative);
    const depleted = want.find((q) => q.depleted);

    if (depleted && withAlt.length) {
        const q = withAlt[0];
        return { action: RECOVERY_ACTION.NAVIGATE, reason: RECOVERY_REASON.TARGET_DEPLETED, evidence: depositEvidence(q, depleted) };
    }
    if (withAlt.length) {
        const q = withAlt[0];
        return { action: RECOVERY_ACTION.NAVIGATE, reason: RECOVERY_REASON.DEPOSIT_KNOWN, evidence: depositEvidence(q) };
    }
    if (withoutAlt.length) {
        const list = withoutAlt.map((q) => `${q.need}x ${q.item}`).join(', ');
        return {
            action: failureClass === FAILURE.MISSING_RESOURCES ?
                policyAction(policy, FAILURE.MISSING_RESOURCES) : RECOVERY_ACTION.SEARCH,
            reason: RECOVERY_REASON.DEPOSIT_UNKNOWN,
            evidence: [`no known source for: ${list}`],
        };
    }
    // Contract names no item (generic not-obtained): gather/redo per policy.
    return {
        action: policyAction(policy, failureClass || FAILURE.NOT_OBTAINED),
        reason: RECOVERY_REASON.MATERIALS_MISSING,
        evidence: ['the step produced no verifiable materials'],
    };
}

function depositEvidence(q, depleted = q?.depleted) {
    const out = [];
    if (depleted) out.push(`nearest known ${q.item} deposit is depleted`);
    if (q.alternative) {
        const { fact, distance: d } = q.alternative;
        out.push(`usable ${q.item} deposit ${Math.round(d)}m away at (${fact.pos.x}, ${fact.pos.y}, ${fact.pos.z})`);
    }
    if (q.need) out.push(`need ${q.need}x ${q.item}`);
    return out;
}

/**
 * Apply attempt/replan budgets to a retry-shaped decision.
 */
function budgetRetry(dec, retriesLeft, replanCount, maxReplans, { exhausted = RECOVERY_ACTION.REPLAN } = {}) {
    if (RETRY_FAMILY.has(dec.action) && !retriesLeft) {
        if (dec.action === RECOVERY_ACTION.RETREAT) {
            return { ...dec, action: RECOVERY_ACTION.HUMAN, reason: RECOVERY_REASON.DANGER_PERSISTS,
                evidence: [...dec.evidence, 'danger remained after the recovery attempt'] };
        }
        if (dec.action === RECOVERY_ACTION.GATHER && exhausted === RECOVERY_ACTION.REPLAN) {
            if (replanCount >= maxReplans) {
                return { ...dec, action: RECOVERY_ACTION.HUMAN, reason: RECOVERY_REASON.MATERIALS_MISSING,
                    evidence: [...dec.evidence, 'could not gather materials automatically'] };
            }
            return { ...dec, action: RECOVERY_ACTION.REPLAN, reason: RECOVERY_REASON.RETRY_BUDGET_EXHAUSTED,
                evidence: [...dec.evidence, 'add explicit material-acquisition steps'] };
        }
        if (replanCount >= maxReplans) {
            return { ...dec, action: RECOVERY_ACTION.HUMAN, reason: RECOVERY_REASON.REPLANS_EXHAUSTED,
                evidence: [...dec.evidence, `${maxReplans} plan revisions used`] };
        }
        return { ...dec, action: RECOVERY_ACTION.REPLAN, reason: RECOVERY_REASON.RETRY_BUDGET_EXHAUSTED,
            evidence: [...dec.evidence, 'same-step retries are exhausted'] };
    }
    return dec;
}

/** Executor-facing instruction for the next turn. */
function buildGuidance(d, step, pos, ctx) {
    const p = (o) => o ? `(${o.x}, ${o.y}, ${o.z})` : '';
    switch (d.action) {
        case RECOVERY_ACTION.NAVIGATE: {
            const target = d.target;
            if (!target) return d.evidence.join('; ');
            const avoid = (ctx?.threats || [])[0];
            return [
                `Your previous attempt failed (${d.reason.replace(/_/g, ' ')}).`,
                `First travel to ${p(target.pos)}${target.distance ? ` (~${Math.round(target.distance)}m away)` : ''},`,
                `then redo ONLY this step${target.label ? ` (${target.label})` : ''}.`,
                avoid ? `Avoid the ${avoid.fact.name} near ${p(avoid.fact.pos)}.` : '',
            ].filter(Boolean).join(' ');
        }
        case RECOVERY_ACTION.SEARCH:
            return `Your previous attempt failed (${d.reason.replace(/_/g, ' ')}). Explore the surrounding area to locate ${
                ctx?.target?.name || d.evidence[0] || 'the target'}, then complete the step. Do not repeat the same spot.`;
        case RECOVERY_ACTION.GATHER: {
            const items = [...(ctx?.costQueries || []), ...(ctx?.itemQueries || [])]
                .filter((q, i, arr) => arr.findIndex((x) => x.item === q.item) === i)
                .map((q) => {
                    const alt = q.alternative;
                    return `${q.need}x ${q.item}${alt ? ` (known source ${p(alt.fact.pos)}, ~${Math.round(alt.distance)}m)` : ' (find or craft it)'}`;
                });
            return `Acquire the missing materials before retrying: ${items.join('; ') || d.evidence.join('; ')}. ` +
                `Then redo ONLY this step: ${step?.title || ''}.`;
        }
        case RECOVERY_ACTION.RETREAT: {
            const r = ctx?.retreat;
            return `You are in danger (${d.reason.replace(/_/g, ' ')}). Retreat to ${
                r ? `${r.name} at ${p(r.pos)}` : 'open ground away from hostiles'}, eat to recover health, ` +
                `then return and redo ONLY this step: ${step?.title || ''}.`;
        }
        case RECOVERY_ACTION.REPATH:
            return `The route was blocked (${d.reason.replace(/_/g, ' ')}). Find a different safe path to the same objective ` +
                `and complete ONLY this step: ${step?.title || ''}.`;
        case RECOVERY_ACTION.RETRY:
            return `The failure was transient (${d.reason.replace(/_/g, ' ')}). Repeat the step exactly as instructed: ${step?.title || ''}.`;
        case RECOVERY_ACTION.REPLAN:
            return null; // planner, not executor
        case RECOVERY_ACTION.HUMAN:
        case RECOVERY_ACTION.ABORT:
        case RECOVERY_ACTION.CONTINUE:
            return null;
        default:
            return null;
    }
}

/** Attach a concrete navigation target for NAVIGATE/RETREAT/REPATH decisions. */
function decision(action, reason, evidence = [], step = null, pos = null, ctx = null) {
    const d = { action, reason, evidence: evidence.filter(Boolean), guidance: '', target: null, at: Date.now() };
    if (action === RECOVERY_ACTION.NAVIGATE) {
        // Prefer an item deposit, then a last-seen entity/structure target.
        const alt = ctx?.itemQueries?.find((q) => q.alternative)?.alternative ||
            ctx?.costQueries?.find((q) => q.alternative)?.alternative || null;
        if (alt) d.target = { pos: alt.fact.pos, distance: alt.distance, label: alt.fact.name };
        else if (ctx?.knownTarget) d.target = { pos: ctx.knownTarget.fact.pos, distance: ctx.knownTarget.distance, label: ctx.knownTarget.fact.name };
    }
    if (action === RECOVERY_ACTION.RETREAT && ctx?.retreat) {
        d.target = { pos: ctx.retreat.pos, distance: ctx.retreat.distance, label: ctx.retreat.name };
    }
    if (action === RECOVERY_ACTION.REPATH && ctx?.target?.type === 'location') {
        d.target = { pos: ctx.target.pos, label: 'objective' };
    }
    d.guidance = buildGuidance(d, step, pos, ctx);
    return d;
}

export { decision as buildRecoveryDecision };
