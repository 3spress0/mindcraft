/**
 * pause.js — global pause/resume/cancel control.
 * (GO list: !pause, !resume, !cancel.)
 *
 * A global pause stops all self-directed behavior (modes, autonomy, the
 * self-prompter) while the bot keeps listening and answering chat — like a
 * player stepping away from the keyboard without closing the game. Cancel
 * is stop-with-reason: it interrupts current work and records why.
 */

/** Pause all autonomous behavior. Idempotent. */
export function pauseAll(agent, { reason = 'requested' } = {}) {
    if (!agent) return false;
    if (agent._paused) return true;
    agent._paused = true;
    agent._pause_reason = String(reason).slice(0, 120);
    agent._paused_at = Date.now();
    try {
        if (agent.self_prompter?.stop) agent.self_prompter.stop(false);
    } catch { /* optional */ }
    try {
        agent.autonomy?.setRuntimeEnabled?.(false);
    } catch { /* optional */ }
    return true;
}

/** Resume after a global pause. Idempotent. */
export function resumeAll(agent) {
    if (!agent || !agent._paused) return false;
    agent._paused = false;
    agent._pause_reason = null;
    try {
        agent.autonomy?.setRuntimeEnabled?.(null); // back to settings
    } catch { /* optional */ }
    return true;
}

/** Status line for queries. */
export function pauseStatus(agent) {
    if (!agent?._paused) return 'not paused';
    const secs = Math.round((Date.now() - (agent._paused_at ?? Date.now())) / 1000);
    return `PAUSED for ${secs}s (${agent._pause_reason ?? 'no reason'})`;
}

/**
 * Cancel-with-reason: interrupt current work (same machinery as !stop) and
 * remember why, so the model's context shows what was cancelled and why.
 * @returns {Promise<string>} summary
 */
export async function cancelWithReason(agent, reason = 'no reason given') {
    if (!agent) return 'Nothing to cancel.';
    const label = agent.actions?.currentActionLabel ?? null;
    try {
        await agent.actions?.stop?.();
        agent.clearBotLogs?.();
        agent.actions?.cancelResume?.();
        agent.bot?.emit?.('idle');
    } catch { /* cancellation is best-effort */ }
    agent._last_cancel = { at: Date.now(), reason: String(reason).slice(0, 160), was: label };
    try {
        const { logEvent } = await import('./structlog.js');
        logEvent(agent, 'lifecycle', 'cancel', { reason, was: label });
    } catch { /* optional */ }
    return label
        ? `Cancelled "${label}" — reason: ${reason}.`
        : `Nothing was running, but noted the reason: ${reason}.`;
}
