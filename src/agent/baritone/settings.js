/**
 * settings.js — Baritone-style movement profiles for mineflayer-pathfinder.
 *
 * Baritone exposes dozens of `#set` options (allowSprint, allowParkour,
 * allowDiagonalDescend, legit...) that tune how it moves. mindcraft condenses
 * the useful ones into named profiles applied to a `pf.Movements` instance:
 *
 *   default      mindcraft's traditional behavior: prefers not to dig,
 *                modest placement cost, everything else allowed.
 *   legit        conservative, human-plausible movement: no sprinting, no
 *                parkour jumps, no digging, no 1x1 towers, small drops.
 *   fast         prioritize speed: sprint + parkour + free to dig.
 *   builder      for schematic builds: never dig, cheap placement,
 *                scaffolding-friendly.
 *
 * Profiles are stored per-bot so `!setPathProfile` affects all subsequent
 * navigation (skills.goToGoal reads it) without changing any call sites.
 */

export const PROFILES = {
    default: {
        description: 'Balanced: avoids digging (high dig cost), may place blocks, sprint and parkour allowed.',
        tweaks: {
            digCost: 10,
            placeCost: 2,
        },
    },
    legit: {
        description: 'Conservative and human-like: no sprinting, no parkour, never digs, no 1x1 towers, small drops only.',
        tweaks: {
            allowSprinting: false,
            allowParkour: false,
            allowFreeMotion: false,
            canDig: false,
            allow1by1towers: false,
            maxDropDown: 3,
            digCost: 1,   // irrelevant while canDig=false, kept for parity
            placeCost: 2,
        },
    },
    fast: {
        description: 'Prioritize speed: sprinting and parkour on, free to dig through obstacles.',
        tweaks: {
            allowSprinting: true,
            allowParkour: true,
            canDig: true,
            digCost: 1,
            placeCost: 2.5,
            maxDropDown: 5,
        },
    },
    builder: {
        description: 'For construction: never dig, cheap block placement, no parkour.',
        tweaks: {
            canDig: false,
            digCost: 50,
            placeCost: 1,
            allowParkour: false,
            allowSprinting: true,
        },
    },
};

export const PROFILE_NAMES = Object.keys(PROFILES);
const FALLBACK_PROFILE = 'default';

export function profileNames() {
    return [...PROFILE_NAMES];
}

export function describeProfile(name) {
    const p = PROFILES[name];
    return p ? p.description : null;
}

/**
 * Apply a profile's tweaks to a Movements-like object. Only fields that the
 * object actually has are written, so this works with real pf.Movements and
 * with lightweight mocks alike. Returns the movements object.
 */
export function applyProfile(movements, name) {
    const profile = PROFILES[name] || PROFILES[FALLBACK_PROFILE];
    for (const [key, value] of Object.entries(profile.tweaks)) {
        if (key in movements) movements[key] = value;
    }
    return movements;
}

/** Which profile is active for this bot (default unless set). */
export function getProfileName(bot) {
    return bot?._baritone_profile || FALLBACK_PROFILE;
}

/** Set the active profile for a bot. Throws on unknown names. */
export function setProfileName(bot, name) {
    if (!PROFILES[name]) {
        throw new Error(`Unknown path profile "${name}". Available: ${PROFILE_NAMES.join(', ')}.`);
    }
    bot._baritone_profile = name;
    return name;
}

/** Human-readable list for !listPathProfiles. */
export function profileDocs(activeName) {
    const lines = [];
    for (const name of PROFILE_NAMES) {
        const marker = name === activeName ? ' (active)' : '';
        lines.push(`- ${name}${marker}: ${PROFILES[name].description}`);
    }
    return lines.join('\n');
}
