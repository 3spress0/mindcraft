/**
 * reactions.js — perception-driven social reactions (GO list: reacting
 * naturally when players approach or leave, greetings, unknown-player
 * classification). Pure detection + bounded, cooldown-gated response
 * selection. Speech only happens through the agent's normal chat path and
 * respects !stfu / conversation state.
 */

export const APPROACH_DIST = 12;   // inside this = "approached"
export const DEPART_DIST = 24;     // beyond this = "departed"
export const SIGHTING_RANGE = 48;  // only track players within radar range

/**
 * Compare two player-distance snapshots and emit social events.
 * Snapshots: Map|Object of name -> dist.
 * @returns {Array<{kind:'approach'|'depart'|'first_sighting', name, dist}>}
 */
export function detectSocialEvents(prev = {}, curr = {}) {
    const events = [];
    const before = prev instanceof Map ? Object.fromEntries(prev) : (prev ?? {});
    const now = curr instanceof Map ? Object.fromEntries(curr) : (curr ?? {});

    for (const [name, dist] of Object.entries(now)) {
        if (typeof dist !== 'number' || dist > SIGHTING_RANGE) continue;
        const was = before[name];
        if (was == null) {
            events.push({ kind: 'first_sighting', name, dist });
            if (dist <= APPROACH_DIST) events.push({ kind: 'approach', name, dist });
        } else if (was > APPROACH_DIST && dist <= APPROACH_DIST) {
            events.push({ kind: 'approach', name, dist });
        }
    }
    for (const [name, was] of Object.entries(before)) {
        const dist = now[name];
        if (was != null && was <= APPROACH_DIST && (dist == null || dist > DEPART_DIST)) {
            events.push({ kind: 'depart', name, dist: dist ?? null });
        }
    }
    return events;
}

/** Per-(kind, player) cooldown gate so reactions never spam. */
export class ReactionGate {
    constructor({ now = () => Date.now(), cooldowns = {} } = {}) {
        this._now = now;
        // defaults: greetings rare-ish, departures rarer, approaches moderate
        this.cooldowns = {
            first_sighting: 8 * 60000,
            approach: 5 * 60000,
            depart: 10 * 60000,
            ...cooldowns
        };
        this._last = new Map();
    }

    key(kind, name) { return `${kind}:${String(name).toLowerCase()}`; }

    /** Returns true (and records) when the reaction is allowed now. */
    allow(kind, name) {
        const key = this.key(kind, name);
        const t = this._now();
        const last = this._last.get(key);
        const cd = this.cooldowns[kind] ?? 5 * 60000;
        if (last != null && t - last < cd) return false;
        this._last.set(key, t);
        return true;
    }
}

const GREETINGS = [
    'hey {name}!',
    'hi {name}, welcome.',
    'oh, hey {name}.',
    '{name}! good to see you.',
    'hello {name}.'
];
const HOSTILE_NOTICES = [
    'watching you, {name}.',
    '{name}, keep your distance.',
    'I remember you, {name}.'
];
const FAREWELLS = [
    'later, {name}.',
    'bye {name}.',
    'safe travels, {name}.'
];

function pickTemplate(rng, templates) {
    if (rng?.pick) return rng.pick(templates);
    return templates[0];
}

/**
 * Decide what (if anything) to say for a social event. Bounded probability
 * driven by sociability; hostile/friend context changes the wording.
 * @returns {string|null}
 */
export function reactionMessage(event, ledgerEntry, { personality = null } = {}) {
    if (!event?.name) return null;
    const trust = ledgerEntry?.trust ?? 'neutral';
    const sociability = personality?.traits?.sociability ?? 0.5;
    const rng = personality?.rng;

    const chanceRoll = () => (rng ? rng.next() : Math.random()) < Math.min(0.9, 0.25 + sociability * 0.55);

    switch (event.kind) {
        case 'approach':
        case 'first_sighting': {
            if (trust === 'hostile') {
                if (!chanceRoll()) return null;
                return pickTemplate(rng, HOSTILE_NOTICES).replaceAll('{name}', event.name);
            }
            if (!chanceRoll()) return null;
            return pickTemplate(rng, GREETINGS).replaceAll('{name}', event.name);
        }
        case 'depart': {
            if (trust === 'hostile') return null; // no fond farewells
            const roll = rng ? rng.next() : Math.random();
            if (roll >= Math.min(0.6, 0.1 + sociability * 0.35)) return null;
            return pickTemplate(rng, FAREWELLS).replaceAll('{name}', event.name);
        }
        default:
            return null;
    }
}
