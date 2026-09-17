/**
 * goals.js — Baritone-inspired goal types for mineflayer-pathfinder.
 *
 * Baritone (https://github.com/cabaletta/baritone) expresses every movement
 * request as a Goal with `heuristic(node)` and `isEnd(node)`. These classes
 * implement the same interface so they plug straight into
 * `bot.pathfinder.goto(goal)` / `getPathTo(movements, goal)`, while adding the
 * goal flavours mindcraft did not expose before:
 *
 *   GoalBlock       exact block position                    (#goto x y z)
 *   GoalNear        within a radius of a point
 *   GoalXZ          any height at an x,z column
 *   GoalNearXZ      within a radius of a column, any height
 *   GoalY           a specific height (any x,z)
 *   GoalGetToBlock  adjacent to / on top of a block, like Baritone's
 *                   GoalGetToBlock used by #mine (reach = mine range)
 *   GoalFollow      dynamic: tracks a moving entity          (#follow)
 *   GoalRunAway     at least `radius` away from a point
 *   GoalAny         composite: any sub-goal satisfied
 *   GoalAll         composite: all sub-goals satisfied
 *   GoalInvert      everywhere except inside the wrapped goal
 */

const Vec3Like = (p) => p && typeof p.x === 'number' && typeof p.z === 'number';

function manhattan(ax, az, bx, bz) {
    return Math.abs(ax - bx) + Math.abs(az - bz);
}

class BaritoneGoal {
    constructor() {
        this.reached = false;
    }

    heuristic(node) {
        throw new Error('heuristic() not implemented');
    }

    isEnd(node) {
        throw new Error('isEnd() not implemented');
    }

    /** Dynamic goals override this; pathfinder re-plans when it returns true. */
    hasChanged() {
        return false;
    }

    isValid() {
        return true;
    }

    reset() {
        this.reached = false;
    }

    describe() {
        return this.constructor.name;
    }
}

export class GoalBlock extends BaritoneGoal {
    constructor(x, y, z) {
        super();
        this.x = Math.floor(x);
        this.y = Math.floor(y);
        this.z = Math.floor(z);
    }

    heuristic(node) {
        return manhattan(node.x, node.z, this.x, this.z) + Math.abs(node.y - this.y);
    }

    isEnd(node) {
        return node.x === this.x && node.y === this.y && node.z === this.z;
    }

    describe() {
        return `GoalBlock(x=${this.x}, y=${this.y}, z=${this.z})`;
    }
}

export class GoalNear extends BaritoneGoal {
    constructor(x, y, z, range) {
        super();
        this.x = Math.floor(x);
        this.y = Math.floor(y);
        this.z = Math.floor(z);
        this.range = Math.max(0, Math.floor(range));
    }

    heuristic(node) {
        return Math.max(0, manhattan(node.x, node.z, this.x, this.z) + Math.abs(node.y - this.y) - this.range);
    }

    isEnd(node) {
        return manhattan(node.x, node.z, this.x, this.z) + Math.abs(node.y - this.y) <= this.range;
    }

    describe() {
        return `GoalNear(x=${this.x}, y=${this.y}, z=${this.z}, range=${this.range})`;
    }
}

export class GoalXZ extends BaritoneGoal {
    constructor(x, z) {
        super();
        this.x = Math.floor(x);
        this.z = Math.floor(z);
    }

    heuristic(node) {
        return manhattan(node.x, node.z, this.x, this.z);
    }

    isEnd(node) {
        return node.x === this.x && node.z === this.z;
    }

    describe() {
        return `GoalXZ(x=${this.x}, z=${this.z})`;
    }
}

export class GoalNearXZ extends BaritoneGoal {
    constructor(x, z, range) {
        super();
        this.x = Math.floor(x);
        this.z = Math.floor(z);
        this.range = Math.max(0, Math.floor(range));
    }

    heuristic(node) {
        return Math.max(0, manhattan(node.x, node.z, this.x, this.z) - this.range);
    }

    isEnd(node) {
        return manhattan(node.x, node.z, this.x, this.z) <= this.range;
    }

    describe() {
        return `GoalNearXZ(x=${this.x}, z=${this.z}, range=${this.range})`;
    }
}

export class GoalY extends BaritoneGoal {
    constructor(y) {
        super();
        this.y = Math.floor(y);
    }

    heuristic(node) {
        return Math.abs(node.y - this.y);
    }

    isEnd(node) {
        return node.y === this.y;
    }

    describe() {
        return `GoalY(y=${this.y})`;
    }
}

/**
 * Baritone's GoalGetToBlock: stand on the target block or horizontally
 * adjacent to it at the same level — i.e. any spot from which the block is
 * inside mining/placement reach. Used by #mine and builder reach logic.
 */
export class GoalGetToBlock extends BaritoneGoal {
    constructor(x, y, z) {
        super();
        this.x = Math.floor(x);
        this.y = Math.floor(y);
        this.z = Math.floor(z);
    }

    heuristic(node) {
        const standingOn = Math.max(0, manhattan(node.x, node.z, this.x, this.z) + (this.y + 1 - node.y));
        const adjacent = Math.max(0, manhattan(node.x, node.z, this.x, this.z) - 1 + Math.abs(node.y - this.y));
        return Math.min(standingOn, adjacent);
    }

    isEnd(node) {
        const horiz = manhattan(node.x, node.z, this.x, this.z);
        // Standing directly on top of the block...
        if (horiz === 0 && node.y === this.y + 1) return true;
        // ...or horizontally adjacent at the same level...
        if (horiz === 1 && node.y === this.y) return true;
        // ...or (for slabs/low blocks) in the same cell.
        return horiz === 0 && node.y === this.y;
    }

    describe() {
        return `GoalGetToBlock(x=${this.x}, y=${this.y}, z=${this.z})`;
    }
}

/**
 * Dynamic goal that tracks a moving entity (Baritone #follow). The entity
 * position is read lazily so the goal follows teleports, vehicles and
 * respawned entities without re-construction.
 */
export class GoalFollow extends BaritoneGoal {
    constructor(entity, range) {
        super();
        this.entity = entity;
        this.range = Math.max(0.5, Number(range) || 3);
        this._last = this._entityPos();
    }

    _entityPos() {
        const pos = this.entity?.position;
        return Vec3Like(pos) ? { x: pos.x, y: pos.y, z: pos.z } : null;
    }

    heuristic(node) {
        const pos = this._entityPos();
        if (!pos) return 0;
        const dist = manhattan(node.x, node.z, Math.floor(pos.x), Math.floor(pos.z)) +
            Math.abs(node.y - Math.floor(pos.y));
        return Math.max(0, dist - this.range);
    }

    isEnd(node) {
        const pos = this._entityPos();
        if (!pos) return false;
        const dx = node.x + 0.5 - pos.x;
        const dy = node.y - pos.y;
        const dz = node.z + 0.5 - pos.z;
        return Math.sqrt(dx * dx + dy * dy + dz * dz) <= this.range;
    }

    /** Re-plan when the followed entity has moved a full block. */
    hasChanged() {
        const pos = this._entityPos();
        if (!pos) return false;
        if (!this._last) {
            this._last = pos;
            return true;
        }
        const dx = pos.x - this._last.x;
        const dy = pos.y - this._last.y;
        const dz = pos.z - this._last.z;
        if (dx * dx + dy * dy + dz * dz >= 1) {
            this._last = pos;
            return true;
        }
        return false;
    }

    describe() {
        const name = this.entity?.username || this.entity?.name || 'entity';
        return `GoalFollow(${name}, range=${this.range})`;
    }
}

/**
 * Escape goal: be at least `radius` away from a point (or entity).
 */
export class GoalRunAway extends BaritoneGoal {
    constructor(from, radius) {
        super();
        this.from = from;
        this.radius = Math.max(1, Number(radius) || 16);
    }

    _fromPos() {
        if (Vec3Like(this.from)) return this.from;
        const pos = this.from?.position;
        return Vec3Like(pos) ? pos : null;
    }

    heuristic(node) {
        const pos = this._fromPos();
        if (!pos) return 0;
        const dist = manhattan(node.x, node.z, Math.floor(pos.x), Math.floor(pos.z)) +
            Math.abs(node.y - Math.floor(pos.y));
        return Math.max(0, this.radius - dist);
    }

    isEnd(node) {
        const pos = this._fromPos();
        if (!pos) return false;
        const dx = node.x + 0.5 - pos.x;
        const dy = node.y - pos.y;
        const dz = node.z + 0.5 - pos.z;
        return Math.sqrt(dx * dx + dy * dy + dz * dz) >= this.radius;
    }

    describe() {
        return `GoalRunAway(radius=${this.radius})`;
    }
}

/** Composite: satisfied when ANY sub-goal is satisfied (Baritone GoalComposite). */
export class GoalAny extends BaritoneGoal {
    constructor(...goals) {
        super();
        this.goals = goals.flat();
    }

    heuristic(node) {
        let best = Infinity;
        for (const g of this.goals) best = Math.min(best, g.heuristic(node));
        return Number.isFinite(best) ? best : 0;
    }

    isEnd(node) {
        return this.goals.some((g) => g.isEnd(node));
    }

    hasChanged() {
        return this.goals.some((g) => g.hasChanged && g.hasChanged());
    }

    describe() {
        return `GoalAny(${this.goals.map((g) => g.describe()).join(', ')})`;
    }
}

/** Composite: satisfied only when ALL sub-goals are satisfied. */
export class GoalAll extends BaritoneGoal {
    constructor(...goals) {
        super();
        this.goals = goals.flat();
    }

    heuristic(node) {
        let worst = 0;
        for (const g of this.goals) worst = Math.max(worst, g.heuristic(node));
        return worst;
    }

    isEnd(node) {
        return this.goals.length > 0 && this.goals.every((g) => g.isEnd(node));
    }

    hasChanged() {
        return this.goals.some((g) => g.hasChanged && g.hasChanged());
    }

    describe() {
        return `GoalAll(${this.goals.map((g) => g.describe()).join(', ')})`;
    }
}

/** Invert a goal: satisfied everywhere the wrapped goal is not. */
export class GoalInvert extends BaritoneGoal {
    constructor(goal) {
        super();
        this.goal = goal;
    }

    heuristic(node) {
        return -this.goal.heuristic(node);
    }

    isEnd(node) {
        return !this.goal.isEnd(node);
    }

    hasChanged() {
        return this.goal.hasChanged && this.goal.hasChanged();
    }

    describe() {
        return `GoalInvert(${this.goal.describe()})`;
    }
}

export const BaritoneGoals = {
    GoalBlock,
    GoalNear,
    GoalXZ,
    GoalNearXZ,
    GoalY,
    GoalGetToBlock,
    GoalFollow,
    GoalRunAway,
    GoalAny,
    GoalAll,
    GoalInvert,
};
