/**
 * selftest_driver.js — in-memory driver used ONLY to test the live harness
 * itself (gates, ordering, timeouts, verification, report redaction).
 *
 * It has no Minecraft semantics whatsoever: it exists so `npm test` can prove
 * the runner/verifier plumbing works on a machine with no Minecraft server, no
 * node_modules and no network. A green self-test run means the harness is
 * wired correctly; it does NOT say anything about mineflayer, pathfinding,
 * chunk loading or the server, and must never be reported as a live test.
 *
 * Use `--driver mineflayer` (drivers/mineflayer_driver.js) for a real server.
 */

const AIR = 'air';

export class SelfTestDriver {
    constructor(opts = {}) {
        this.name = 'selftest';
        this.opts = opts;
        this.failPhase = opts.failPhase || null;          // force a phase failure
        this.hangPhase = opts.hangPhase || null;          // force a timeout
        this.inventory = { ...opts.inventory };
        this.blocks = new Map();
        this.planned = [];
        this.state = { connected: false, chunksLoaded: 0, latencyMs: null, reconnect: null, recovery: {} };
        this.inventoryBefore = { ...this.inventory };
        this.calls = [];
        this.position = { x: 0, y: 64, z: 0 };
        this.health = 20;
        this.food = 20;
        this.persisted = null;
    }

    /**
     * Awaits before doing anything: `failPhase` throws (an error the harness has
     * to surface), `hangPhase` never settles (a timeout the harness has to cut).
     */
    async _record(name) {
        this.calls.push(name);
        if (this.failPhase === name) throw new Error(`selftest forced failure in ${name}`);
        if (this.hangPhase === name) await new Promise(() => { /* deliberately never settles */ });
    }

    _key(x, y, z) {
        return `${Math.floor(x)},${Math.floor(y)},${Math.floor(z)}`;
    }

    async connect() {
        await this._record('connect');
        this.state.connected = true;
        this.state.latencyMs = 12;
        this.state.serverVersion = '1.21.6';
        this.state.protocol = 767;
        this.state.spawn = { ...this.position };
        return { ok: true, simulated: true };
    }

    async observe() {
        await this._record('observe');
        if (!this.state.connected) throw new Error('not connected');
        this.state.chunksLoaded = 9;
        this._nearby = ['grass_block', 'dirt', 'oak_log', 'air', 'stone'];
        // world model of the fake server: trees near spawn
        for (let i = 0; i < 4; i++) this.blocks.set(this._key(2 + i, 64, 3), { name: 'oak_log' });
        return { ok: true, simulated: true };
    }

    async report() {
        await this._record('report');
        this.entities = [{ name: 'cow', x: 4, y: 64, z: 4 }];
        return { ok: true, simulated: true };
    }

    async gather({ task }) {
        await this._record('gather');
        const item = task.gather.item;
        const count = Number(task.gather.count) || 1;
        if (!this._nearby?.includes('oak_log')) throw new Error('no resource chunks loaded');
        for (let i = 0; i < count; i++) {
            const it = [...this.blocks.entries()].find(([, b]) => b.name === item);
            if (!it) break;
            this.blocks.delete(it[0]);
            this.inventory[item] = (this.inventory[item] || 0) + 1;
        }
        return { ok: true, gained: this.inventory[item] || 0, simulated: true };
    }

    async craft({ task }) {
        await this._record('craft');
        const item = task.craft.item;
        if (item === 'crafting_table' && (this.inventory.oak_log || 0) >= 1) {
            this.inventory.oak_log -= 1;
            this.inventory.oak_planks = (this.inventory.oak_planks || 0) + 4;
            this.inventory.crafting_table = (this.inventory.crafting_table || 0) + 1;
        }
        return { ok: true, simulated: true };
    }

    async build({ task }) {
        await this._record('build');
        const block = task.build.block;
        if ((this.inventory[block] || 0) < task.build.plan.length) throw new Error(`not enough ${block} to build`);
        this.planned = task.build.plan.map((p) => ({
            x: this.position.x + p.dx,
            y: this.position.y + p.dy,
            z: this.position.z + p.dz,
            name: block,
        }));
        for (const b of this.planned) {
            this.blocks.set(this._key(b.x, b.y, b.z), { name: b.name });
            this.inventory[b.name] -= 1;
        }
        return { ok: true, placed: this.planned.length, simulated: true };
    }

    /**
     * Simulates the production interruption path: cancel mid-step, leave the
     * world half-changed, then let the recovery logic finish the goal.
     */
    async interrupt({ task }) {
        await this._record('interrupt');
        const item = task.gather.item;
        const target = Number(task.recovery.count) || 2;
        // 1. cut off the in-flight action after partial progress
        this.inventory[item] = (this.inventory[item] || 0) + Math.max(0, Math.min(1, target - 1));
        const interrupted = true;
        // 2. recovery decides to retry the step, which actually finishes it
        const hadEnough = (this.inventory[item] || 0) >= target;
        if (!hadEnough) this.inventory[item] = (this.inventory[item] || 0) + (target - (this.inventory[item] || 0));
        this.state.recovery = {
            interrupted,
            retried: !hadEnough,
            resumed: true,
            replanned: false,
            crashed: false,
            detail: `selftest: step cut off after ${Math.max(0, target - 1)} of ${target} ${item}, retried and completed`,
        };
        return { ...this.state.recovery, simulated: true };
    }

    async verifyWorldState({ reconnectEnabled }) {
        await this._record('verify_world_state');
        if (reconnectEnabled) {
            // simulate a real drop: state must come back from a persisted store
            this.persisted = JSON.stringify({ inventory: this.inventory, blocks: [...this.blocks.entries()], planned: this.planned });
            this.state.connected = false;
            const store = JSON.parse(this.persisted);
            await new Promise((r) => setImmediate(r));
            this.inventory = store.inventory;
            this.blocks = new Map(store.blocks);
            this.planned = store.planned;
            this.state.connected = true;
            this.state.reconnect = { performed: true, connected: true, reconnectMs: 240, blocksSurvived: true, inventorySurvived: true, stateRestored: true };
        }
        return { ok: true, simulated: true };
    }

    async snapshot() {
        const placedBlocks = this.planned.map((p) => {
            const found = this.blocks.get(this._key(p.x, p.y, p.z));
            return { ...p, confirmed: !!found && found.name === p.name };
        });
        return {
            connected: this.state.connected,
            serverVersion: this.state.serverVersion ?? null,
            protocol: this.state.protocol ?? null,
            latencyMs: this.state.latencyMs ?? null,
            spawn: this.state.spawn ?? null,
            position: { ...this.position },
            health: this.health,
            food: this.food,
            dimension: 'overworld',
            inventory: { ...this.inventory },
            inventoryBefore: { ...this.inventoryBefore },
            nearbyBlockTypes: this._nearby ?? [],
            nearbyEntities: this.entities ?? [],
            chunksLoaded: this.state.chunksLoaded,
            sampleBlock: this._nearby ? { name: 'grass_block', pos: { x: 0, y: 63, z: 0 } } : null,
            placedBlocks,
            expectedBlocks: this.planned,
            recovery: this.state.recovery,
            reconnect: this.state.reconnect,
        };
    }

    async teardown() {
        this.calls.push('teardown');
        this.state.connected = false;
    }
}

export default SelfTestDriver;
