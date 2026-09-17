// Humanlike interaction timing and focus.
// Bounded, personality-scaled pauses and "look before you act" focus, applied
// deliberately at interaction entry points (dig/place/equip/chest). All
// randomness comes from the seeded personality rng — never Math.random here.

import settings from '../../../settings.js';
import { glance } from './attention.js';
import { sleep } from './rng.js';

const DEFAULTS = {
    enabled: true,                   // master switch for interaction humanization
    dig_pause_ms: [80, 280],         // pause before starting to dig
    place_pause_ms: [60, 220],       // pause before placing a block
    equip_pause_ms: [50, 250],       // pause when switching tools/hotbar
    window_pause_ms: [150, 450],     // pause when opening a container
    slot_move_pause_ms: [20, 70],    // per-slot-move pacing in chest sorts
    post_action_pause_ms: [60, 200], // brief verification pause after an action
    focus_before_action: true,       // glance at the block before digging/placing
    focus_dwell_ms: [120, 450],      // how long the pre-action glance holds
    focus_offset: 0.18               // bounded imprecision (blocks) on the glance target
};

export function getInteractionConfig() {
    const block = settings.humanlike?.interaction ?? {};
    const cfg = {};
    for (const [key, def] of Object.entries(DEFAULTS)) {
        cfg[key] = block[key] === undefined ? def : block[key];
    }
    cfg.enabled = settings.humanlike?.enabled !== false && cfg.enabled !== false;
    return cfg;
}

/** Is humanlike interaction active for this bot right now? */
export function interactionActive(bot) {
    const cfg = getInteractionConfig();
    if (!cfg.enabled) return false;
    if (bot?._humanlike_off) return false;              // explicit test/benchmark opt-out
    if (bot?.modes?.isOn?.('cheat')) return false;      // cheat pipelines stay deterministic
    if (typeof bot?.look !== 'function') return false;  // mock/incomplete bots stay deterministic
    return true;
}

function boundedDelay(cfg, key, personality) {
    const [lo, hi] = Array.isArray(cfg[key]) && cfg[key].length === 2 ? cfg[key] : DEFAULTS[key];
    if (personality) return personality.delay(lo, hi);
    return Math.round((lo + hi) / 2);
}

/**
 * Look at a block/position the way a player would before acting on it:
 * bounded imprecision + a short dwell. Safe no-op when disabled.
 */
export async function focusOn(bot, pos, personality, opts = {}) {
    if (!interactionActive(bot)) return null;
    const cfg = getInteractionConfig();
    if (!cfg.focus_before_action && !opts.force) return null;
    const center = { x: pos.x + 0.5, y: pos.y + 0.5, z: pos.z + 0.5 };
    const [minD, maxD] = opts.dwell ?? cfg.focus_dwell_ms;
    return glance(bot, center, personality, {
        maxOffset: opts.offset ?? cfg.focus_offset,
        minDwellMs: minD,
        maxDwellMs: maxD
    });
}

/** Bounded pre-action pause. kind: 'dig' | 'place' | 'equip' | 'window' | 'post'. */
export async function pause(bot, personality, kind = 'post') {
    if (!interactionActive(bot)) return 0;
    const cfg = getInteractionConfig();
    const key = kind === 'post' ? 'post_action_pause_ms' : `${kind}_pause_ms`;
    const ms = boundedDelay(cfg, key, personality);
    if (ms > 0) await sleep(ms, bot);
    return ms;
}

/**
 * Equip an item with a natural hotbar/swap pause. Falls back to the plain
 * equip when humanlike is off. Accepts a mineflayer Item instance or name.
 */
export async function naturalEquip(bot, item, personality) {
    if (!interactionActive(bot)) {
        await bot.equip(item, 'hand');
        return true;
    }
    await pause(bot, personality, 'equip');
    await bot.equip(item, 'hand');
    return true;
}
