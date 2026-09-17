/**
 * escort.js — escort behavior (GO list: escort behavior).
 *
 * Unlike !follow (endless trailing), an escort is a bounded protective
 * assignment: stay close to the named player, keep a weapon/shield ready
 * when threats appear, wait when they lag behind, and give up cleanly if
 * they get too far away. Interruptible, time-boxed, and honest about what
 * it can do — the bot accompanies, it doesn't tank.
 */

import { scoreThreats, combatReady, combatStateLine, updateCombatState } from './combat.js';

/**
 * Escort a player for a bounded duration.
 * @param {object} agent
 * @param {string} playerName
 * @param {object} [opts] { durationMs, followDist, giveUpDist, pollMs, sleep }
 * @returns {Promise<string>} summary
 */
export async function escortPlayer(agent, playerName, {
    durationMs = 120_000, followDist = 4, giveUpDist = 28, pollMs = 1500, sleep = null
} = {}) {
    const bot = agent?.bot;
    if (!bot) return 'escort: no bot';
    const name = String(playerName ?? '').trim();
    if (!name) return 'escort: which player?';
    const _sleep = sleep ?? ((t) => new Promise(r => setTimeout(r, t)));
    const deadline = Date.now() + Math.max(5000, durationMs);
    let shielded = false;
    let lastCombat = null;

    let lastKnownDist = null;
    let vanishedNoted = false;
    try {
        const skills = await import('../library/skills.js');
        while (Date.now() < deadline) {
            if (bot.interrupt_code) return 'escort: interrupted.';
            const player = bot.players?.[name]?.entity;
            if (!player?.position) {
                // Entity disappearance handling (GO list): they were right
                // here and now the server doesn't send them — notice it.
                if (!vanishedNoted && lastKnownDist != null && lastKnownDist < 24) {
                    vanishedNoted = true;
                    try { agent.attention?.recordEvent?.(bot.entity?.position?.x ?? 0, bot.entity?.position?.y ?? 0, bot.entity?.position?.z ?? 0, 'entity_vanished'); } catch { /* optional */ }
                    try { bot.chat(`wait, where did ${name} go? they were right here...`); } catch { /* chat optional */ }
                }
                await _sleep(pollMs);
                continue; // they may be out of render distance; wait, don't chase
            }
            vanishedNoted = false;
            const dist = bot.entity?.position?.distanceTo(player.position) ?? 0;
            lastKnownDist = dist;
            if (dist > giveUpDist) {
                return `escort: ${name} got too far away (${Math.round(dist)}m) — gave up.`;
            }
            // defensive readiness while threats are scored nearby
            try {
                lastCombat = updateCombatState(bot);
                if (lastCombat.phase !== 'idle' && !shielded) {
                    await combatReady(bot);
                    shielded = true;
                }
                if (lastCombat.phase === 'idle') shielded = false;
            } catch { /* combat readiness is best-effort */ }
            // keep close, but don't re-path when already in formation
            if (dist > followDist) {
                try {
                    const p = player.position;
                    await skills.goToPosition(bot, p.x, p.y, p.z, followDist);
                } catch { /* keep trying next tick */ }
            }
            await _sleep(pollMs);
        }
    } catch (e) {
        return `escort: failed (${e.message})`;
    }
    const combatNote = lastCombat ? ` ${combatStateLine(lastCombat)}` : '';
    return `escort: walked with ${name} for ${Math.round(Math.min(durationMs, Date.now() - (deadline - durationMs)) / 1000)}s.${combatNote}`;
}
