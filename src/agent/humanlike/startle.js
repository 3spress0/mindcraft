/**
 * startle.js — humanlike reaction to loud sounds (GO list: react to
 * explosions / unexpected events).
 *
 * When something explodes nearby, a person flinches and looks. The bot does
 * the same: the attention tracker records the event (the idle gaze already
 * turns toward fresh events) and the camera glances at the source with the
 * usual humanlike imprecision. It never interrupts the current action — the
 * risk gate and self-preservation handle actual danger.
 */

import { glance } from './attention.js';

/** Sound-name patterns worth flinching at. */
export const LOUD_SOUND_RE = /(explo|lightning|wither|ender_dragon|enderdragon|ghast|tnt|respawn_anchor)/i;

export function isLoudSound(name) {
    return typeof name === 'string' && LOUD_SOUND_RE.test(name);
}

/**
 * Handle a server sound event.
 * @param {object} agent - agent with .bot, ._attention (optional), .personality (optional)
 * @param {string} soundName - normalized sound name from mineflayer
 * @param {{x,y,z}} position - sound origin
 * @param {object} [opts] - { maxDist = 48, now }
 * @returns {Promise<{startled:boolean, reason?:string}>}
 */
export async function handleSound(agent, soundName, position, { maxDist = 48 } = {}) {
    const bot = agent?.bot;
    if (!bot || !position || typeof position.x !== 'number') return { startled: false };
    if (!isLoudSound(soundName)) return { startled: false, reason: 'quiet' };

    const self = bot.entity?.position;
    if (self && typeof self.distanceTo === 'function') {
        const dist = self.distanceTo(position);
        if (dist > maxDist) return { startled: false, reason: 'too far' };
    }

    try { agent?._attention?.recordEvent?.(position.x, position.y, position.z, 'sound'); } catch { /* optional */ }

    try {
        await glance(bot, position, agent?.personality, { minDwellMs: 200, maxDwellMs: 900 });
    } catch { /* glancing is best-effort */ }

    return { startled: true, sound: soundName };
}
