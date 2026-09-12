/**
 * policies.js — configurable failure → recovery-action policy profiles.
 *
 * The Critic classifies WHAT went wrong (failure class). The WorldModel
 * recovery context says what the bot knows about alternatives. The POLICY
 * decides the preferred shape of the response, and different bot roles can
 * prefer different shapes:
 *
 *   explorer: search aggressively, explore around danger
 *   builder:  route to known deposits, pause rather than fight through damage
 *   survival: safety first — retreat early, escalate sooner
 *
 * A policy maps a failure class to a RECOVERY_ACTION. recovery.js still
 * contextualizes the action with world facts (a "search" may become "navigate
 * to the known deposit at (x, y, z)") and enforces attempt/replan budgets.
 */

import { FAILURE } from './critic.js';

export const RECOVERY_ACTION = {
    CONTINUE: 'continue',
    RETRY: 'retry',         // same approach once more (glitch / interrupted)
    REPATH: 'repath',       // route was blocked: reach the same goal another way
    NAVIGATE: 'navigate',   // go to a specific known alternative (coordinates)
    SEARCH: 'search',       // explore for the target/resource (no known location)
    GATHER: 'gather',       // obtain missing materials, then continue
    RETREAT: 'retreat',     // move to safety before anything else
    REPLAN: 'replan',       // ask the planner for different remaining steps
    HUMAN: 'human',         // pause for human help
    ABORT: 'abort',         // goal is impossible
};

/** Retry-shaped actions: same step is re-attempted, guided by recovery text. */
export const RETRY_FAMILY = new Set([
    RECOVERY_ACTION.RETRY, RECOVERY_ACTION.REPATH, RECOVERY_ACTION.NAVIGATE,
    RECOVERY_ACTION.SEARCH, RECOVERY_ACTION.GATHER, RECOVERY_ACTION.RETREAT,
]);

export const POLICY_PROFILES = {
    default: {
        [FAILURE.TRANSIENT]: RECOVERY_ACTION.REPATH,
        [FAILURE.NOT_OBTAINED]: RECOVERY_ACTION.GATHER,
        [FAILURE.TARGET_MISSING]: RECOVERY_ACTION.SEARCH,
        [FAILURE.WRONG_APPROACH]: RECOVERY_ACTION.REPLAN,
        [FAILURE.DANGER]: RECOVERY_ACTION.RETREAT,
        [FAILURE.MISSING_RESOURCES]: RECOVERY_ACTION.GATHER,
        [FAILURE.IMPOSSIBLE]: RECOVERY_ACTION.ABORT,
    },
    // Explorer: unknown targets are a reason to scout, not replan; treats
    // generic glitches as simple retries and only retreats from real damage.
    explorer: {
        [FAILURE.TRANSIENT]: RECOVERY_ACTION.RETRY,
        [FAILURE.NOT_OBTAINED]: RECOVERY_ACTION.SEARCH,
        [FAILURE.TARGET_MISSING]: RECOVERY_ACTION.SEARCH,
        [FAILURE.WRONG_APPROACH]: RECOVERY_ACTION.REPLAN,
        [FAILURE.DANGER]: RECOVERY_ACTION.RETREAT,
        [FAILURE.MISSING_RESOURCES]: RECOVERY_ACTION.GATHER,
        [FAILURE.IMPOSSIBLE]: RECOVERY_ACTION.ABORT,
    },
    // Builder: prefer routing to known deposits/stations; escalate to a human
    // quickly when materials or safety cannot be resolved automatically.
    builder: {
        [FAILURE.TRANSIENT]: RECOVERY_ACTION.REPATH,
        [FAILURE.NOT_OBTAINED]: RECOVERY_ACTION.GATHER,
        [FAILURE.TARGET_MISSING]: RECOVERY_ACTION.NAVIGATE,
        [FAILURE.WRONG_APPROACH]: RECOVERY_ACTION.REPLAN,
        [FAILURE.DANGER]: RECOVERY_ACTION.RETREAT,
        [FAILURE.MISSING_RESOURCES]: RECOVERY_ACTION.GATHER,
        [FAILURE.IMPOSSIBLE]: RECOVERY_ACTION.ABORT,
    },
    // Survival: danger always means retreat; after one failed recovery attempt
    // the planner re-plans instead of gambling on a retry.
    survival: {
        [FAILURE.TRANSIENT]: RECOVERY_ACTION.REPATH,
        [FAILURE.NOT_OBTAINED]: RECOVERY_ACTION.GATHER,
        [FAILURE.TARGET_MISSING]: RECOVERY_ACTION.SEARCH,
        [FAILURE.WRONG_APPROACH]: RECOVERY_ACTION.REPLAN,
        [FAILURE.DANGER]: RECOVERY_ACTION.RETREAT,
        [FAILURE.MISSING_RESOURCES]: RECOVERY_ACTION.GATHER,
        [FAILURE.IMPOSSIBLE]: RECOVERY_ACTION.ABORT,
    },
};

/**
 * Resolve the effective policy: built-in profile + settings overrides.
 * @param profileName  default|explorer|builder|survival
 * @param overrides    optional {profile: {failureClass: action}} from settings
 */
export function resolvePolicy(profileName = 'default', overrides = null) {
    const base = POLICY_PROFILES[profileName] || POLICY_PROFILES.default;
    const custom = overrides?.[profileName] || overrides?.default || {};
    return { ...base, ...custom };
}

export function policyAction(policy, failureClass) {
    return policy[failureClass] || RECOVERY_ACTION.REPLAN;
}
