/**
 * world_model.js — persistent, timestamped, confidence-rated model of the world
 * a bot knows about.
 *
 * The planning loop used to rediscover the same facts every step ("where is a
 * villager?", "where did we last see iron?"). The WorldModel is the single
 * place the observer layer writes structured facts to and the planner/executor
 * read context from. Every fact carries:
 *   - firstSeen / lastSeen timestamps (when it was observed, not inferred)
 *   - confidence in [0,1] and a source (observed / verified / inferred / told)
 *   - an optional expiry for volatile facts (threats, dropped items)
 *
 * The model itself is pure data + deterministic logic: it contains NO
 * mineflayer calls. Event -> fact translation lives in
 * src/agent/observation/collector.js.
 */

export const CATEGORY = {
    LOCATION: 'location',     // villages, bases, named points, death points
    ENTITY: 'entity',         // villagers, animals, players (non-hostile)
    RESOURCE: 'resource',     // ore deposits, ground items, material sources
    STRUCTURE: 'structure',   // things built or found (stations, farms, builds)
    THREAT: 'threat',         // hostile mobs / danger sources
    RECIPE: 'recipe',         // crafting recipes the bot has verifiably done
};

export const SOURCE = {
    OBSERVED: 'observed',     // directly seen by the bot right now
    VERIFIED: 'verified',     // claimed by a plan step that passed verification
    INFERRED: 'inferred',     // deduced from other evidence
    TOLD: 'told',             // reported by another agent / a player
};

const DEFAULT_CONFIDENCE = {
    [SOURCE.OBSERVED]: 0.95,
    [SOURCE.VERIFIED]: 1.0,
    [SOURCE.INFERRED]: 0.55,
    [SOURCE.TOLD]: 0.7,
};

/** Categories whose confidence decays and whose facts expire when unseen. */
const VOLATILE_CATEGORIES = new Set([CATEGORY.THREAT, CATEGORY.ENTITY]);

const MODEL_VERSION = 1;

let factCounter = 0;
function newFactId(category) {
    factCounter = (factCounter + 1) % 1_000_000;
    return `${category[0]}${Date.now().toString(36)}_${factCounter}`;
}

function roundPos(pos) {
    if (!pos) return null;
    return { x: Math.round(Number(pos.x)), y: Math.round(Number(pos.y)), z: Math.round(Number(pos.z)) };
}

function samePos(a, b) {
    if (!a || !b) return false;
    return a.x === b.x && a.y === b.y && a.z === b.z;
}

export function distance(a, b) {
    if (!a || !b) return 0;
    return Math.sqrt((a.x - b.x) ** 2 + (a.y - b.y) ** 2 + (a.z - b.z) ** 2);
}

export class Fact {
    constructor(category, data = {}, now = Date.now()) {
        this.id = data.id || newFactId(category);
        this.category = category;
        this.key = String(data.key || Fact.defaultKey(category, data) || this.id);
        this.name = String(data.name || category);
        this.kind = data.kind ? String(data.kind) : null;
        this.pos = roundPos(data.pos);
        this.dimension = data.dimension || null;
        this.detail = { ...(data.detail || {}) };
        this.source = data.source || SOURCE.OBSERVED;
        this.confidence = clampConfidence(data.confidence ?? DEFAULT_CONFIDENCE[this.source] ?? 0.6);
        this.firstSeen = data.firstSeen || now;
        this.lastSeen = data.lastSeen || now;
        this.expiresAt = data.expiresAt || null;
    }

    static defaultKey(category, data) {
        const pos = roundPos(data.pos);
        const base = String(data.name || category);
        // Mobile things merge by name+block; durable things merge by name+place.
        if (pos && category !== CATEGORY.ENTITY && category !== CATEGORY.THREAT) {
            return `${base}@${pos.x},${pos.y},${pos.z}`;
        }
        if (pos && (category === CATEGORY.ENTITY || category === CATEGORY.THREAT)) {
            return `${base}@${pos.x},${pos.y},${pos.z}`;
        }
        return base;
    }

    /** Merge a newer observation of the same fact. Corroboration strengthens it. */
    merge(update = {}, now = Date.now()) {
        if (update.name) this.name = String(update.name);
        if (update.kind) this.kind = String(update.kind);
        if (update.pos) this.pos = roundPos(update.pos);
        if (update.dimension) this.dimension = update.dimension;
        if (update.detail) Object.assign(this.detail, update.detail);
        if (update.source) this.source = strongestSource(this.source, update.source);
        const incoming = clampConfidence(
            update.confidence ?? DEFAULT_CONFIDENCE[update.source || this.source] ?? this.confidence
        );
        // Re-observing re-affirms: never let an old decayed confidence shrink a
        // fresh direct observation.
        this.confidence = Math.max(this.confidence, incoming);
        this.lastSeen = now;
        if (update.expiresAt !== undefined) this.expiresAt = update.expiresAt;
        return this;
    }

    age(now = Date.now()) {
        return Math.max(0, now - this.lastSeen);
    }

    isFresh(now = Date.now()) {
        return !this.expiresAt || this.expiresAt > now;
    }

    toJSON() {
        return {
            id: this.id, category: this.category, key: this.key, name: this.name,
            kind: this.kind, pos: this.pos, dimension: this.dimension, detail: this.detail,
            source: this.source, confidence: Number(this.confidence.toFixed(3)),
            firstSeen: this.firstSeen, lastSeen: this.lastSeen, expiresAt: this.expiresAt,
        };
    }
}

function clampConfidence(c) {
    const n = Number(c);
    if (!Number.isFinite(n)) return 0.5;
    return Math.min(1, Math.max(0, n));
}

const SOURCE_RANK = { [SOURCE.TOLD]: 1, [SOURCE.INFERRED]: 2, [SOURCE.OBSERVED]: 3, [SOURCE.VERIFIED]: 4 };
function strongestSource(a, b) {
    return (SOURCE_RANK[b] || 0) > (SOURCE_RANK[a] || 0) ? b : a;
}

export class WorldModel {
    constructor(data = {}) {
        this.version = data.version || MODEL_VERSION;
        this.player = data.player ? { ...data.player } : null;
        this.facts = {};
        for (const category of Object.values(CATEGORY)) this.facts[category] = [];
        this.activeProjects = Array.isArray(data.activeProjects) ? data.activeProjects.map((p) => ({ ...p })) : [];
        this.updatedAt = data.updatedAt || Date.now();
        if (data.facts) this._ingestJSON(data.facts);
    }

    _ingestJSON(rawFacts) {
        for (const category of Object.values(CATEGORY)) {
            for (const raw of rawFacts[category] || []) {
                try {
                    this.facts[category].push(new Fact(category, raw, raw.lastSeen));
                } catch { /* skip a malformed persisted fact */ }
            }
        }
    }

    // ---------- writes ----------

    recordPlayer(state = {}) {
        const prev = this.player || {};
        this.player = {
            position: state.position ? roundPos(state.position) : prev.position || null,
            health: state.health != null ? Number(state.health) : prev.health ?? null,
            food: state.food != null ? Number(state.food) : prev.food ?? null,
            dimension: state.dimension || prev.dimension || null,
            updatedAt: Date.now(),
        };
        this.updatedAt = Date.now();
        return this.player;
    }

    /**
     * Insert or refresh a fact. Re-observing the same key merges instead of
     * duplicating. `expiresIn` (ms) marks volatile facts for pruning.
     */
    record(category, fact = {}, { expiresIn = null } = {}) {
        if (!this.facts[category]) throw new Error(`unknown world-model category: ${category}`);
        const now = Date.now();
        const key = fact.key || Fact.defaultKey(category, fact);
        const existing = this.facts[category].find((f) => f.key === key);
        let record;
        if (existing) {
            record = existing.merge({ ...fact, key }, now);
        } else {
            record = new Fact(category, { ...fact, key }, now);
            this.facts[category].push(record);
        }
        if (expiresIn != null) record.expiresAt = now + Number(expiresIn);
        this.updatedAt = now;
        // Structured world-model log hook (set by the collector; optional).
        try { this._onFactChange?.(category, key, existing ? 'merge' : 'record', record); } catch { /* advisory */ }
        return record;
    }

    learnRecipe(name, { confidence = 0.9, source = SOURCE.VERIFIED } = {}) {
        return this.record(CATEGORY.RECIPE, { name: String(name), kind: 'recipe', confidence, source });
    }

    hasRecipe(name) {
        return this.facts[CATEGORY.RECIPE].some((f) => f.name === String(name));
    }

    /** Mirror the runner's current project so planners/restarts know what is active. */
    setProject(project) {
        if (!project || !project.goal) return;
        const progress = project.progress ? project.progress() : { done: 0, total: 0, pct: 0 };
        const ref = {
            goal: project.goal,
            status: project.status,
            done: progress.done,
            total: progress.total,
            pct: progress.pct,
            updatedAt: Date.now(),
        };
        const i = this.activeProjects.findIndex((p) => p.goal === ref.goal);
        if (i >= 0) this.activeProjects[i] = ref;
        else this.activeProjects.push(ref);
        this.updatedAt = Date.now();
    }

    clearProject(goal) {
        const before = this.activeProjects.length;
        this.activeProjects = goal ? this.activeProjects.filter((p) => p.goal !== goal) : [];
        if (this.activeProjects.length !== before) this.updatedAt = Date.now();
    }

    remove(category, idOrKey) {
        if (!this.facts[category]) return;
        const before = this.facts[category].length;
        this.facts[category] = this.facts[category].filter((f) => f.id !== idOrKey && f.key !== idOrKey);
        if (this.facts[category].length < before) {
            try { this._onFactChange?.(category, idOrKey, 'remove', null); } catch { /* advisory */ }
        }
    }

    // ---------- decay / expiry ----------

    /**
     * Age volatile facts: confidence decays exponentially while a threat/mob is
     * not re-observed, expired facts and facts below the confidence floor are
     * dropped. Durable categories (locations, structures, resources, recipes)
     * are kept — the planner may revisit them later.
     */
    tick(now = Date.now(), { halfLifeMs = 120_000, confidenceFloor = 0.15 } = {}) {
        let removed = 0;
        for (const category of Object.values(CATEGORY)) {
            const kept = [];
            for (const fact of this.facts[category]) {
                if (fact.expiresAt && fact.expiresAt <= now) { removed += 1; continue; }
                if (VOLATILE_CATEGORIES.has(category)) {
                    const ageMs = now - fact.lastSeen;
                    if (ageMs > 0 && halfLifeMs > 0) {
                        fact.confidence = clampConfidence(fact.confidence * 0.5 ** (ageMs / halfLifeMs));
                    }
                    if (fact.confidence < confidenceFloor) { removed += 1; continue; }
                }
                kept.push(fact);
            }
            this.facts[category] = kept;
        }
        return removed;
    }

    // ---------- reads ----------

    all(category) {
        return category ? (this.facts[category] || []) : this.facts;
    }

    find(category, predicate) {
        return (this.facts[category] || []).filter(predicate);
    }

    /** Nearest fresh fact of a category, optionally matching a name fragment. */
    nearest(category, pos, { name = null, filter = null, maxDistance = Infinity, includeExpired = false } = {}) {
        const now = Date.now();
        let best = null;
        let bestD = maxDistance;
        for (const fact of this.facts[category] || []) {
            if (!includeExpired && !fact.isFresh(now)) continue;
            if (name && !nameMatches(fact, name)) continue;
            if (filter && !filter(fact)) continue;
            if (!fact.pos || !pos) continue;
            const d = distance(fact.pos, pos);
            if (d <= bestD) { best = fact; bestD = d; }
        }
        return best ? { fact: best, distance: bestD } : null;
    }

    /** Most recently seen fact matching a name fragment, across categories. */
    lastSeen(nameFragment, categories = Object.values(CATEGORY)) {
        const needle = String(nameFragment).toLowerCase();
        let best = null;
        for (const category of categories) {
            for (const fact of this.facts[category] || []) {
                if (fact.name.toLowerCase().includes(needle) ||
                    (fact.kind || '').toLowerCase().includes(needle) ||
                    String(fact.detail?.item || '').toLowerCase().includes(needle)) {
                    if (!best || fact.lastSeen > best.lastSeen) best = fact;
                }
            }
        }
        return best;
    }

    /**
     * Answer "where is the nearest known X?": prefers the asked category by
     * keyword (village -> location, iron -> resource, zombie -> threat), then
     * falls back to a name search across everything.
     */
    queryNearest(text, pos = this.player?.position) {
        const needle = String(text).toLowerCase();
        const byKeyword = [
            [CATEGORY.LOCATION, /village|base|home|point|portal|shrine|outpost|monument/],
            [CATEGORY.THREAT, /zombie|skeleton|creeper|spider|witch|hostile|mob|threat|husk|pillager/],
            [CATEGORY.STRUCTURE, /station|table|furnace|chest|farm|build|house|shelter|structure/],
            [CATEGORY.ENTITY, /villager|cow|pig|sheep|chicken|animal|horse|player/],
            [CATEGORY.RESOURCE, /iron|coal|diamond|gold|log|wood|ore|stone|wheat|resource|item/],
        ];
        for (const [category, re] of byKeyword) {
            if (re.test(needle)) {
                const words = needle.split(/[^a-z_]+/).filter((w) => w.length >= 4 && !STOP_WORDS.has(w));
                const hit = this.nearest(category, pos, {
                    filter: (fact) => !words.length || words.some((w) =>
                        fact.name.toLowerCase().includes(w) || (fact.kind || '').toLowerCase().includes(w)),
                });
                if (hit) return { ...hit, category };
                // Category was explicitly asked for (e.g. "any threats?"):
                // fall back to the nearest fact in that category.
                if (/^(locations?|resources?|threats?|structures?|entities|recipes?)$/.test(needle.trim())) {
                    const any = this.nearest(category, pos, {});
                    if (any) return { ...any, category };
                }
            }
        }
        // Name search across categories, nearest tie-break (word-token based).
        const words = needle.split(/[^a-z_]+/).filter((w) => w.length >= 3 && !STOP_WORDS.has(w));
        const matches = [];
        for (const category of Object.values(CATEGORY)) {
            for (const fact of this.facts[category]) {
                const hit = !words.length || words.some((w) =>
                    fact.name.toLowerCase().includes(w) || (fact.kind || '').toLowerCase().includes(w) ||
                    String(fact.detail?.item || '').toLowerCase().includes(w));
                if (hit && fact.pos && pos) {
                    matches.push({ fact, distance: distance(fact.pos, pos), category });
                }
            }
        }
        matches.sort((a, b) => a.distance - b.distance);
        return matches[0] || null;
    }

    // ---------- serialization / rendering ----------

    toJSON() {
        return {
            version: MODEL_VERSION,
            player: this.player,
            facts: Object.fromEntries(Object.entries(this.facts).map(([k, v]) => [k, v.map((f) => f.toJSON())])),
            activeProjects: this.activeProjects,
            updatedAt: this.updatedAt,
        };
    }

    static fromJSON(data) {
        return new WorldModel(data || {});
    }

    /** Compact, planner-facing text: only fresh, relevant facts, distance sorted. */
    summaryForPlanner({ pos = null, now = Date.now(), maxLines = 40 } = {}) {
        const origin = pos || this.player?.position;
        const lines = [];
        if (this.player) {
            const p = this.player;
            const where = p.position ? `at (${p.position.x}, ${p.position.y}, ${p.position.z})` : '';
            lines.push(`Self: ${where}${p.dimension ? ` in ${p.dimension}` : ''}, health ${p.health ?? '?'}, hunger ${p.food ?? '?'}`.trim());
        }
        for (const proj of this.activeProjects) {
            lines.push(`Active project: ${proj.goal} (${proj.done}/${proj.total} = ${proj.pct}%, ${proj.status})`);
        }

        const section = (heading, category, { limit = 8, sort = 'distance', filter = null } = {}) => {
            let facts = (this.facts[category] || []).filter((f) => f.isFresh(now));
            if (filter) facts = facts.filter(filter);
            facts = facts.map((f) => ({ f, d: origin && f.pos ? distance(f.pos, origin) : null }));
            if (sort === 'distance') facts.sort((a, b) => (a.d ?? 1e9) - (b.d ?? 1e9));
            else facts.sort((a, b) => b.f.lastSeen - a.f.lastSeen);
            const picked = facts.slice(0, limit);
            if (!picked.length) return;
            lines.push(`${heading}:`);
            for (const { f, d } of picked) lines.push(`  - ${factLine(f, d, now)}`);
        };

        section('Known locations', CATEGORY.LOCATION, { limit: 6 });
        section('Structures', CATEGORY.STRUCTURE, { limit: 6 });
        section('Resource sources / deposits', CATEGORY.RESOURCE, { limit: 8 });
        section('Known mobs / NPCs', CATEGORY.ENTITY, { limit: 6, sort: 'recency' });
        section('Active threats', CATEGORY.THREAT, { limit: 5, sort: 'distance' });
        const recipes = this.facts[CATEGORY.RECIPE];
        if (recipes.length) lines.push(`Crafted before: ${recipes.map((f) => f.name).slice(0, 20).join(', ')}`);

        const out = lines.slice(0, maxLines);
        if (lines.length > maxLines) out.push(`  (...${lines.length - maxLines} more known facts, see !world)`);
        return out.join('\n');
    }

    /** Human-facing rendering for the !world command. */
    render(filter = null) {
        const now = Date.now();
        const origin = this.player?.position;
        if (filter) {
            const category = resolveCategory(filter);
            if (category) {
                const facts = [...this.facts[category]]
                    .sort((a, b) => b.lastSeen - a.lastSeen);
                if (!facts.length) return `No known ${category} facts.`;
                return [`${category} (${facts.length}):`, ...facts.map((f) => `  - ${factLine(f, origin && f.pos ? distance(f.pos, origin) : null, now, true)}`)].join('\n');
            }
            const hit = this.queryNearest(filter);
            if (!hit) return `No known facts matching "${filter}".`;
            return `Nearest known "${filter}": ${factLine(hit.fact, hit.distance, now, true)} (${hit.category})`;
        }
        const counts = Object.entries(this.facts)
            .map(([k, v]) => `${k} ${v.length}`).join(', ');
        return [`World model (${counts}), updated ${formatAge(now - this.updatedAt)} ago`,
            this.summaryForPlanner({ now, maxLines: 60 })].join('\n');
    }
}

function resolveCategory(word) {
    const w = String(word).toLowerCase().replace(/s$/, '');
    const map = {
        location: CATEGORY.LOCATION, locations: CATEGORY.LOCATION, place: CATEGORY.LOCATION, places: CATEGORY.LOCATION,
        entity: CATEGORY.ENTITY, entities: CATEGORY.ENTITY, mob: CATEGORY.ENTITY, mobs: CATEGORY.ENTITY, npc: CATEGORY.ENTITY,
        resource: CATEGORY.RESOURCE, resources: CATEGORY.RESOURCE, item: CATEGORY.RESOURCE, items: CATEGORY.RESOURCE,
        structure: CATEGORY.STRUCTURE, structures: CATEGORY.STRUCTURE, build: CATEGORY.STRUCTURE, builds: CATEGORY.STRUCTURE,
        threat: CATEGORY.THREAT, threats: CATEGORY.THREAT, danger: CATEGORY.THREAT, dangers: CATEGORY.THREAT,
        recipe: CATEGORY.RECIPE, recipes: CATEGORY.RECIPE,
    };
    return map[w] || map[`${w}s`] || null;
}

const STOP_WORDS = new Set(['where', 'nearest', 'known', 'find', 'near', 'close', 'last', 'seen',
    'know', 'about', 'some', 'have', 'with', 'from', 'this', 'that', 'what', 'does', 'did',
    'area', 'areas', 'place', 'places']);

function nameMatches(fact, fragment) {
    const needle = String(fragment).toLowerCase();
    return fact.name.toLowerCase().includes(needle) ||
        (fact.kind || '').toLowerCase().includes(needle) ||
        String(fact.detail?.item || '').toLowerCase().includes(needle);
}

function factLine(fact, d, now, verbose = false) {
    const bits = [fact.name];
    if (fact.kind && fact.kind !== fact.name) bits.push(`(${fact.kind})`);
    if (fact.pos) bits.push(`at (${fact.pos.x}, ${fact.pos.y}, ${fact.pos.z})`);
    if (d != null) bits.push(`${d.toFixed(0)}m away`);
    if (verbose && fact.dimension) bits.push(`in ${fact.dimension}`);
    const detailEntries = Object.entries(fact.detail || {}).slice(0, 3)
        .map(([k, v]) => `${k}=${typeof v === 'object' ? JSON.stringify(v) : v}`);
    if (detailEntries.length) bits.push(`[${detailEntries.join(', ')}]`);
    bits.push(`seen ${formatAge(now - fact.lastSeen)} ago`);
    if (!fact.isFresh(now)) bits.push('(stale)');
    else if (fact.confidence < 0.75) bits.push(`~${Math.round(fact.confidence * 100)}%`);
    if (verbose && fact.source !== SOURCE.OBSERVED && fact.source !== SOURCE.VERIFIED) bits.push(`via ${fact.source}`);
    return bits.join(' ');
}

function formatAge(ms) {
    if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
    if (ms < 3_600_000) return `${Math.round(ms / 60_000)}min`;
    return `${(ms / 3_600_000).toFixed(1)}h`;
}
