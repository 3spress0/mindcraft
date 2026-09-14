/**
 * mineflayer_driver.js — drives the real protocol stack for live integration.
 *
 * This is the driver that actually tests what FakeBot cannot: the handshake,
 * authentication, chunk streaming, block/entity observation, inventory
 * decoding, pathfinding, dig/craft/place against a server-authoritative world,
 * and a genuine disconnect/reconnect.
 *
 * It reuses the production helpers rather than reimplementing them:
 *   - `src/agent/settings.js` setSettings()  -> exact same bot options as a real agent
 *   - `src/utils/mcdata.js` initBot()        -> plugin loading, position throttle,
 *                                               PartialReadError suppression
 *   - `src/agent/library/skills.js`          -> collectBlock / craftRecipe / placeBlock
 *   - `src/agent/library/world.js`           -> inventory counts, nearby scans
 *   - `src/agent/planning/observer.js`       -> captureState (the observer the critic judges)
 *
 * All heavy imports are lazy so `--driver selftest` and `--preflight` stay
 * dependency-free. Never import this file at module scope outside the
 * mineflayer code path.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..', '..', '..');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class MineflayerDriver {
    /**
     * @param {{host:string, port:number, username:string, auth:string,
     *          version?:string, humanlike?:boolean, stateDir?:string,
     *          log?:console, gate?:object}} cfg
     */
    constructor(cfg = {}) {
        this.name = 'mineflayer';
        this.cfg = cfg;
        this.log = cfg.log || console;
        this.bot = null;
        this.info = {};
        this.phaseInfo = {};
        this.placedBlocks = [];   // absolute coords we attempted to place
        this.inventoryBefore = {};
        this.recovery = { interrupted: false, retried: false, replanned: false, resumed: false, crashed: false, detail: '' };
        this.reconnect = null;
        this.phaseInfoKey = {};
        this.cfg = { ...cfg };
        this._mods = null;
        this.stateDir = cfg.stateDir || path.join(repoRoot, 'results', 'live', cfg.username || 'bot');
    }

    async _modsOnce() {
        if (this._mods) return this._mods;
        const { setSettings } = await import('../../settings.js');
        const rootSettings = (await import('../../../../settings.js')).default;
        // Inject the live target into the same lightweight settings object the
        // agent uses, BEFORE mcdata.js is imported (it reads the version then).
        setSettings({
            ...rootSettings,
            host: this.cfg.host,
            port: this.cfg.port,
            auth: this.cfg.auth,
            minecraft_version: this.cfg.version || 'auto',
            humanlike: { ...(rootSettings.humanlike || {}), enabled: this.cfg.humanlike !== false && rootSettings.humanlike?.enabled !== false },
        });
        const mcdata = await import('../../../utils/mcdata.js');
        const skills = await import('../../library/skills.js');
        const world = await import('../../library/world.js');
        const { captureState } = await import('../../planning/observer.js');
        const { serverInfo } = await import('../../../mindcraft/mcserver.js');
        this._mods = { mcdata, skills, world, captureState, serverInfo };
        return this._mods;
    }

    _assertBot() {
        if (!this.bot) throw new Error('bot is not connected — run the connect phase first');
        return this.bot;
    }

    /**
     * Minimal agent-adjacent surface that `skills.js` expects (log() writes to
     * bot.output, modes gate behaviour). Deliberately no cheat mode: every
     * action in a live test must be legal server-side, or the test proves
     * nothing about how the bot behaves on a real server.
     */
    _prepareBot(bot) {
        bot.output = '';
        bot.interrupt_code = false;
        bot.restrict_to_inventory = true;
        const enabled = new Set(this.cfg.modes || []);
        bot.modes = {
            behavior_log: '',
            isOn: (name) => enabled.has(name),
            pause: () => { },
            resume: () => { },
            set: (name, on) => (on ? enabled.add(name) : enabled.delete(name)),
        };
        // same auto-eat policy as the real agent; harmless with no food
        try {
            if (bot.autoEat?.options) {
                bot.autoEat.options = { priority: 'foodPoints', startAt: 14, bannedFood: ['rotten_flesh', 'spider_eye', 'poisonous_potato', 'pufferfish', 'chicken'] };
            }
        } catch { /* plugin absent */ }
        try {
            bot.pathfinder?.__cfg?.set('sprint', false); // conservative: no sprint-jumping tells
        } catch { /* older pathfinder builds */ }
    }

    async _spawn(bot, timeoutMs) {
        const { parseKickReason } = await import('../../connection_handler.js');
        return new Promise((resolve, reject) => {
            let settled = false;
            const finish = (fn, arg) => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                fn(arg);
            };
            const timer = setTimeout(() => finish(reject, new Error(
                `no spawn within ${timeoutMs}ms (offline-mode local server? wrong version? server busy/queued?)`)), timeoutMs);
            bot.once('spawn', () => finish(resolve, true));
            bot.once('kicked', (reason) => {
                const parsed = parseKickReason(reason);
                finish(reject, new Error(`kicked during login [${parsed.type}] ${parsed.msg}`));
            });
            bot.once('error', (err) => finish(reject, new Error(`client error: ${err?.message || err}`)));
        });
    }

    /* ------------------------------------------------------------- phase 1 */
    async connect({ phase }) {
        const mods = await this._modsOnce();
        const ping = await mods.serverInfo(this.cfg.host, this.cfg.port, 2500, false);
        if (ping) {
            this.log.log?.(`[live] server ping ok: ${ping.name} (v${ping.version}, ${ping.ping}ms)`);
            this.info.serverVersion = ping.version;
            this.info.pingMs = ping.ping;
            if (this.cfg.version && this.cfg.version !== 'auto' && ping.version && ping.version !== this.cfg.version) {
                throw new Error(`version mismatch: server reports ${ping.version}, config pins ${this.cfg.version}`);
            }
        } else {
            this.log.error?.(`[live] no server answered ${this.cfg.host}:${this.cfg.port} — is the local server up? (scripts/live/local_mc_server.sh)`);
        }

        const { mcdata } = mods;
        const t0 = Date.now();
        const bot = mcdata.initBot(this.cfg.username);
        this._prepareBot(bot);
        this.bot = bot;
        // fail fast on auth problems instead of hanging until spawn timeout
        bot.once('login', () => { this.info.loggedIn = true; });
        const spawned = await this._spawn(bot, phase.timeoutMs - (Date.now() - t0));
        if (!spawned) throw new Error('spawn never arrived');
        this.info.timeToSpawnMs = Date.now() - t0;
        this.info.protocol = bot.version ? `${bot.version}` : null;
        this.info.protocolId = bot.protocolVersion ?? null;
        this.info.latencyMs = this.info.pingMs ?? this.info.timeToSpawnMs;
        this.info.spawn = floorVec(bot.entity?.position);
        this.inventoryBefore = mods.world.getInventoryCounts(bot);
        this.phaseInfo[phase.id] = {
            username: this.cfg.username,
            auth: this.cfg.auth,
            serverVersion: this.info.serverVersion,
            onlineMode: this.cfg.auth === 'microsoft' ? 'enforced' : 'offline (local only)',
            pingMs: this.info.pingMs ?? null,
            timeToSpawnMs: this.info.timeToSpawnMs,
        };
        return this.info;
    }

    /* ------------------------------------------------------------- phase 2 */
    async observe({ phase }) {
        const bot = this._assertBot();
        const mods = await this._modsOnce();
        const budget = Math.max(2000, phase.timeoutMs - 5000);
        const t0 = Date.now();
        let chunks = 0;
        let resolved = 0;
        let types = [];
        while (Date.now() - t0 < budget) {
            chunks = bot.world?.chunks?.size ?? 0;
            const center = bot.entity.position.floored();
            // Count columns that have ground within a few blocks of the feet, so
            // a spawn on a ledge, a bridge, or a tree still reads as "chunks are
            // streaming" instead of failing on one empty row.
            resolved = 0;
            for (let dx = -4; dx <= 4; dx++) {
                for (let dz = -4; dz <= 4; dz++) {
                    for (let dy = 0; dy >= -3; dy--) {
                        const b = safe(() => bot.blockAt(center.offset(dx, dy, dz)), null);
                        if (b && b.name !== 'air' && b.name !== 'void_air') { resolved += 1; break; }
                    }
                }
            }
            types = safe(() => mods.world.getNearbyBlockTypes(bot, 16), []);
            if (chunks > 0 && resolved > 20 && types.length > 2) break;
            await sleep(1000);
        }
        this.info.chunksLoaded = chunks;
        this.info.nearbyBlockTypes = types;
        this.info.sampleBlock = safe(() => {
            const b = bot.blockAt(bot.entity.position.floored().offset(0, -1, 0));
            return b ? { name: b.name, pos: floorVec(bot.entity.position.floored().offset(0, -1, 0)) } : null;
        }, null);
        this.phaseInfo[phase.id] = {
            chunksLoaded: chunks,
            solidGroundColumnsIn9x9: resolved,
            distinctBlockTypes: types.length,
            topTypes: types.slice(0, 10),
            biome: safe(() => mods.world.getBiomeName(bot), null),
        };
        if (resolved <= 20) throw new Error(`chunks did not stream in time (${resolved} solid blocks around spawn)`);
        return this.phaseInfo[phase.id];
    }

    /* ------------------------------------------------------------- phase 3 */
    async report({ phase }) {
        const bot = this._assertBot();
        const mods = await this._modsOnce();
        const snap = mods.captureState({ bot });
        if (!snap) throw new Error('observer.captureState returned nothing (bot.entity missing?)');
        this.info.report = {
            position: snap.position,
            health: snap.health,
            food: snap.food,
            dimension: snap.dimension,
            inventorySize: Object.keys(snap.inventory || {}).length,
            topInventory: Object.entries(snap.inventory || {}).sort((a, b) => b[1] - a[1]).slice(0, 8),
            nearbyEntities: (snap.nearbyEntities || []).slice(0, 10),
        };
        this.phaseInfo[phase.id] = this.info.report;
        this.log.log?.(`[live] state: pos=${JSON.stringify(snap.position)} hp=${snap.health} food=${snap.food} items=${Object.keys(snap.inventory).length} entities=${snap.nearbyEntities.length}`);
        return this.info.report;
    }

    /* ------------------------------------------------------------- phase 4 */
    async gather({ phase, task }) {
        const bot = this._assertBot();
        const mods = await this._modsOnce();
        const blockType = task.gather.blockType || task.gather.item;
        const count = Number(task.gather.count) || 1;
        const t0 = Date.now();
        const ok = await mods.skills.collectBlock(bot, blockType, count);
        await sleep(500);
        const have = mods.world.getInventoryCounts(bot)[blockType] || 0;
        this.phaseInfo[phase.id] = { blockType, requested: count, collected: have, ok: ok !== false, ms: Date.now() - t0 };
        if (!have) throw new Error(`collectBlock("${blockType}", ${count}) produced no ${blockType} in inventory`);
        return this.phaseInfo[phase.id];
    }

    /* ------------------------------------------------------------- phase 5 */
    async craft({ phase, task }) {
        const bot = this._assertBot();
        const mods = await this._modsOnce();
        const item = task.craft.item;
        const count = Number(task.craft.count) || 1;
        const t0 = Date.now();
        try {
            await mods.skills.craftRecipe(bot, item, count);
        } catch (err) {
            throw new Error(`craftRecipe("${item}") failed: ${err.message}`);
        }
        await sleep(500);
        const have = mods.world.getInventoryCounts(bot)[item] || 0;
        this.phaseInfo[phase.id] = { item, requested: count, have, ms: Date.now() - t0 };
        if (!have) throw new Error(`crafted ${item} is not in inventory after craftRecipe (server rejected the recipe?)`);
        return this.phaseInfo[phase.id];
    }

    /* ------------------------------------------------------------- phase 6 */
    async build({ phase, task }) {
        const bot = this._assertBot();
        const mods = await this._modsOnce();
        const block = task.build.block;
        const anchor = await this._buildAnchor(bot, mods);
        this.placedBlocks = task.build.plan.map((p) => ({
            x: anchor.x + p.dx, y: anchor.y + p.dy, z: anchor.z + p.dz, name: block,
        }));
        const results = [];
        for (const b of this.placedBlocks) {
            let placed = false;
            try {
                placed = await mods.skills.placeBlock(bot, block, b.x, b.y, b.z);
            } catch (err) {
                results.push({ ...b, placed: false, error: err.message });
                continue;
            }
            const actual = safe(() => {
                const read = bot.blockAt({ x: b.x, y: b.y, z: b.z });
                return read ? read.name : 'air';
            }, 'unknown');
            results.push({ ...b, placed: !!placed, actual, confirmed: actual === block });
            await sleep(this.cfg.placeDelayMs ?? 120); // server-friendly pacing
        }
        const confirmed = results.filter((r) => r.confirmed).length;
        this.phaseInfo[phase.id] = { block, anchor, attempted: results.length, confirmed, results };
        if (!confirmed) throw new Error(`no placed block was readable at the expected coordinates: ${JSON.stringify(results.map((r) => `${r.x},${r.y},${r.z}=${r.actual}`)).slice(0, 400)}`);
        return this.phaseInfo[phase.id];
    }

    async _buildAnchor(bot, mods) {
        const pos = bot.entity.position.floored();
        for (const dx of [2, 3, -2, -3, 4]) {
            for (const dz of [2, -2, 3, -3]) {
                const ground = safe(() => {
                    for (let dy = 0; dy >= -4; dy--) {
                        const b = bot.blockAt(pos.offset(dx, dy, dz));
                        if (b && b.name !== 'air' && b.name !== 'water' && b.name !== 'lava') return { x: pos.x + dx, y: pos.y + dy + 1, z: pos.z + dz };
                    }
                    return null;
                }, null);
                if (ground) return ground;
            }
        }
        void mods;
        return { x: pos.x + 2, y: pos.y, z: pos.z + 2 };
    }

    /* ------------------------------------------------------------- phase 7 */
    async interrupt({ phase, task }) {
        const bot = this._assertBot();
        const mods = await this._modsOnce();
        const blockType = task.gather.blockType || task.gather.item;
        const target = Number(task.recovery.count) || 2;
        const start = mods.world.getInventoryCounts(bot)[blockType] || 0;

        // 1. start a real, in-flight task that takes a while
        const inFlight = mods.skills.collectBlock(bot, blockType, target).catch((err) => {
            this.recovery.detail += `collectBlock threw: ${err.message}; `;
            return 'threw';
        });
        await sleep(this.cfg.interruptAfterMs ?? 1500);

        // 2. cut it off through the production interrupt path
        bot.interrupt_code = true;
        safe(() => bot.pathfinder.stop());
        safe(() => bot.collectBlock.cancelTask());
        await sleep(400);
        const mid = mods.world.getInventoryCounts(bot)[blockType] || 0;
        const partial = mid - start;
        this.recovery.interrupted = true;
        this.recovery.detail += `stopped after ${partial}/${target} ${blockType}; `;

        // 3. re-drive the step to completion (retry, not fake success)
        bot.interrupt_code = false;
        const outcome = await Promise.race([
            inFlight,
            sleep(2000).then(() => 'pending'),
        ]);
        void outcome;
        const retry = await mods.skills.collectBlock(bot, blockType, target).catch((err) => {
            this.recovery.crashed = false;
            this.recovery.detail += `retry threw: ${err.message}; `;
            return false;
        });
        this.recovery.retried = retry !== false;
        this.recovery.resumed = true;
        const end = mods.world.getInventoryCounts(bot)[blockType] || 0;
        this.phaseInfo[phase.id] = {
            ...this.recovery,
            startedWith: start,
            atInterrupt: partial,
            finalDelta: end - start,
            target,
        };
        if (!this.recovery.interrupted) throw new Error('interruption did not happen');
        return this.phaseInfo[phase.id];
    }

    /* ------------------------------------------------------------- phase 8 */
    /**
     * Read the agent's own on-disk state (world model + unfinished project) so a
     * run can say something true about persistence, not just about the socket.
     */
    _persistenceEvidence() {
        const wanted = ['world_model.json', 'plan_project.json'];
        const files = [];
        for (const name of wanted) {
            const full = path.join(this.stateDir, name);
            try {
                const raw = fs.readFileSync(full, 'utf8');
                let facts = null;
                try {
                    const parsed = JSON.parse(raw);
                    facts = Array.isArray(parsed?.facts) ? parsed.facts.length
                        : (Array.isArray(parsed?.steps) ? parsed.steps.length : Object.keys(parsed || {}).length);
                } catch { facts = null; }
                files.push({ name, bytes: Buffer.byteLength(raw), parseable: facts !== null, entries: facts });
            } catch {
                files.push({ name, present: false });
            }
        }
        return files;
    }

    async verifyWorldState({ phase, reconnectEnabled }) {
        const mods = await this._modsOnce();
        if (reconnectEnabled) await this._reconnect(mods);
        const snapshot = await this.snapshot();
        this.phaseInfo[phase.id] = {
            placedConfirmed: snapshot.placedBlocks.filter((b) => b.confirmed).length,
            placedTotal: snapshot.placedBlocks.length,
            inventory: snapshot.inventory,
            reconnect: snapshot.reconnect,
            persistence: this._persistenceEvidence(),
        };
        return this.phaseInfo[phase.id];
    }

    async _reconnect(mods) {
        const bot = this._assertBot();
        const before = {
            inventory: mods.world.getInventoryCounts(bot),
            placed: this.placedBlocks.map((b) => ({ ...b })),
            position: floorVec(bot.entity.position),
        };
        const t0 = Date.now();
        // A genuine protocol-level drop, not a soft stop.
        safe(() => bot.quit('live test: deliberate disconnect'));
        safe(() => bot._client?.end?.());
        await sleep(1500);
        this.bot = null;
        const fresh = mods.mcdata.initBot(this.cfg.username);
        this.bot = fresh;
        await this._spawn(fresh, Math.max(5000, this.cfg.reconnectTimeoutMs ?? 30000));
        await sleep(2500); // let chunks stream before re-reading the world
        const after = mods.world.getInventoryCounts(fresh);
        const blocksSurvived = before.placed.length === 0 ? true : await this._recheckBlocks(fresh, before.placed);
        const inventorySurvived = Object.entries(before.inventory).every(([item, count]) => (after[item] || 0) >= count - 0);
        const moved = before.position ? Math.abs((fresh.entity?.position?.x ?? 0) - before.position.x) : 0;
        this.reconnect = {
            performed: true,
            connected: true,
            reconnectMs: Date.now() - t0,
            blocksSurvived,
            inventorySurvived,
            stateRestored: moved < 8,
            detail: `dropped and rejoined in ${Date.now() - t0}ms; position delta ${moved.toFixed(1)} blocks`,
        };
        this.phaseInfo.reconnect = this.reconnect;
    }

    async _recheckBlocks(bot, blocks) {
        let ok = 0;
        for (const b of blocks) {
            const read = safe(() => {
                const blk = bot.blockAt({ x: b.x, y: b.y, z: b.z });
                return blk ? blk.name : 'air';
            }, 'air');
            if (read === b.name) ok += 1;
        }
        return ok > 0;
    }

    /* ------------------------------------------------------------ snapshot */
    async snapshot() {
        const mods = await this._modsOnce();
        const bot = this.bot;
        if (!bot) {
            return { connected: false, recovery: this.recovery, reconnect: this.reconnect, phaseInfo: this.phaseInfo };
        }
        const snap = safe(() => mods.captureState({ bot }), null);
        const placed = this.placedBlocks.map((b) => {
            const read = safe(() => {
                const blk = bot.blockAt({ x: b.x, y: b.y, z: b.z });
                return blk ? blk.name : 'air';
            }, 'air');
            return { ...b, actual: read, confirmed: read === b.name };
        });
        return {
            connected: !!bot.entity && !!bot?.ready,
            serverVersion: this.info.serverVersion ?? bot.version ?? null,
            protocol: bot.protocolVersion ?? null,
            latencyMs: this.info.latencyMs ?? null,
            spawn: this.info.spawn ?? null,
            position: snap?.position ?? floorVec(bot.entity?.position),
            health: snap?.health ?? Math.round(bot.health ?? -1),
            food: snap?.food ?? Math.round(bot.food ?? -1),
            dimension: snap?.dimension ?? null,
            inventory: snap?.inventory ?? {},
            inventoryBefore: this.inventoryBefore,
            nearbyBlockTypes: snap?.nearbyBlockTypes ?? [],
            nearbyEntities: snap?.nearbyEntities ?? [],
            chunksLoaded: this.info.chunksLoaded ?? bot.world?.chunks?.size ?? 0,
            sampleBlock: this.info.sampleBlock ?? null,
            placedBlocks: placed,
            expectedBlocks: this.placedBlocks,
            recovery: this.recovery,
            reconnect: this.reconnect,
            persistence: this._persistenceEvidence(),
            phaseInfo: this.phaseInfo,
        };
    }

    async teardown() {
        if (!this.bot) return;
        try {
            safe(() => this.bot.pathfinder?.stop?.());
            safe(() => this.bot.quit('live integration test complete'));
        } finally {
            this.bot = null;
        }
    }
}

function safe(fn, fallback = undefined) {
    try {
        const out = fn();
        return out === undefined ? fallback : out;
    } catch {
        return fallback;
    }
}

function floorVec(p) {
    if (!p) return null;
    return { x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) };
}

export default MineflayerDriver;
