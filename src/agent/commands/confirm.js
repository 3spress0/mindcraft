/**
 * confirm.js — confirmation for risky actions (GO list).
 *
 * When settings.confirm_risky_actions is on, commands in RISKY_ACTIONS
 * don't execute immediately: the bot asks the requester to say "confirm".
 * Confirmations are per-sender, expire quickly, and are consumed on use —
 * a safeguard against misheard or mis-typed destructive commands without
 * adding friction to everything else.
 */

import settings from '../../../settings.js';

/** Commands that can break things or put the bot in danger. */
export const RISKY_ACTIONS = new Set([
    '!digDown', '!attack', '!kill', '!explode', '!buildSchematic', '!enterCave', '!travelViaNether'
]);

const CONFIRM_TTL_MS = 60_000;

/** Is the confirmation gate active at all? */
export function confirmGateEnabled() {
    return settings.confirm_risky_actions === true;
}

/**
 * Check whether a command may proceed. Returns:
 *   { proceed: true }                       — not risky, or confirmed
 *   { proceed: false, ask: '<question>' }   — ask the user to confirm
 */
export function checkConfirmation(agent, source, commandName, messageText = '') {
    try {
        if (!confirmGateEnabled()) return { proceed: true };
        if (!RISKY_ACTIONS.has(commandName)) return { proceed: true };
        // an explicit "confirm" in the same message always passes
        if (/\bconfirm\b/i.test(String(messageText ?? ''))) return { proceed: true };
        const pending = agent?._pending_confirms?.get?.(source);
        const now = Date.now();
        if (pending && pending.command === commandName && now - pending.at < CONFIRM_TTL_MS) {
            agent._pending_confirms.delete(source);
            return { proceed: true };
        }
        agent._pending_confirms ??= new Map();
        agent._pending_confirms.set(source, { command: commandName, at: now });
        return {
            proceed: false,
            ask: `That's a risky one (${commandName}). Say "confirm" within ${CONFIRM_TTL_MS / 1000}s if you really want me to do it.`
        };
    } catch {
        return { proceed: true }; // the gate must never block on its own bugs
    }
}

/** Called when a user replies "confirm": resolve the pending request. */
export function consumeConfirmation(agent, source) {
    try {
        const pending = agent?._pending_confirms?.get?.(source);
        if (!pending) return null;
        if (Date.now() - pending.at > CONFIRM_TTL_MS) {
            agent._pending_confirms.delete(source);
            return null;
        }
        agent._pending_confirms.delete(source);
        return pending.command;
    } catch {
        return null;
    }
}
