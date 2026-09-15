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
        this.connected = false;
        this.lastConnectionError = null;
        this._botCleanup = null;
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
        if (!this.bot || !this.connected || this.lastConnectionError) {
            throw new Error(this.lastConnectionError?.message || 'bot is not connected — the server disconnected or connect did not complete');
        }
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
        const waitMs = Math.max(1000, Number(timeoutMs) || 1000);
        this._attachLifecycle(bot, parseKickReason);
        return new Promise((resolve, reject) => {
            let settled = false;
            const onSpawn = () => finish(resolve, true);
            const onKick = (reason) => finish(reject, this._kickError(parseKickReason, reason));
            const onError = (err) => finish(reject, new Error(`client error: ${err?.message || err}`));
            const onEnd = () => finish(reject, new Error('connection ended before the bot spawned'));
            const cleanup = () => {
                clearTimeout(timer);
                bot.removeListener('spawn', onSpawn);
                bot.removeListener('kicked', onKick);
                bot.removeListener('error', onError);
                bot.removeListener('end', onEnd);
            };
            const finish = (fn, arg) => {
                if (settled) return;
                settled = true;
                cleanup();
                fn(arg);
            };
            const timer = setTimeout(() => finish(reject, new Error(
                `no spawn within ${waitMs}ms (server offline/starting, authentication rejected, wrong version, whitelist, or timeout)`)), waitMs);
            bot.once('spawn', onSpawn);
            bot.once('kicked', onKick);
            bot.once('error', onError);
            bot.once('end', onEnd);
        });
    }

    _kickError(parseKickReason, reason) {
        let parsed;
        try { parsed = parseKickReason(reason); }
        catch { parsed = { type: 'unknown', msg: String(reason || 'unknown kick reason') }; }
        return new Error(`kicked during login [${parsed.type}] ${parsed.msg}`);
    }

    _attachLifecycle(bot, parseKickReason) {
        this._detachLifecycle();
        const onError = (err) => {
            this.lastConnectionError = new Error(`Mineflayer client error: ${err?.message || err}`);
            this.connected = false;
            this.log.error?.(`[live] ${this.lastConnectionError.message}`);
        };
        const onKicked = (reason) => {
            const error = this._kickError(parseKickReason, reason);
            this.lastConnectionError = error;
            this.connected = false;
            this.log.error?.(`[live] ${error.message}`);
        };
        const onEnd = () => {
            this.connected = false;
            this.log.log?.('[live] Mineflayer connection ended');
        };
        const onDisconnect = (reason) => {
            this.connected = false;
            this.log.error?.(`[live] Mineflayer disconnected${reason ? `: ${String(reason)}` : ''}`);
        };
        bot.on('error', onError);
        bot.on('kicked', onKicked);
        bot.on('end', onEnd);
        bot.on('disconnect', onDisconnect);
        this._botCleanup = () => {
            bot.removeListener('error', onError);
            bot.removeListener('kicked', onKicked);
            bot.removeListener('end', onEnd);
            bot.removeListener('disconnect', onDisconnect);
        };
    }

    _detachLifecycle() {
        if (this._botCleanup) {
            try { this._botCleanup(); } catch { /* best effort during teardown */ }
            this._botCleanup = null;
        }
    }

    /* ------------------------------------------------------------- phase 1 */
    async connect({ phase }) {
        const mods = await this._modsOnce();
        const ping = await mods.serverInfo(this.cfg.host, this.cfg.port, this.cfg.pingTimeoutMs ?? 5000, false);
        if (ping) {
            this.log.log?.(`[live] server ping ok: ${ping.name} (v${ping.version || 'unknown'}, ${ping.ping}ms)`);
            this.info.serverVersion = ping.version;
            this.info.pingMs = ping.ping;
            if (this.cfg.version && this.cfg.version !== 'auto' && ping.version && ping.version !== this.cfg.version) {
                throw new Error(`version mismatch: server reports ${ping.version}, config pins ${this.cfg.version}`);
            }
        } else {
            // Aternos may take a while to wake. Let the login attempt make the
            // final decision instead of claiming success from a failed ping.
            this.log.error?.(`[live] no status response from ${this.cfg.host}:${this.cfg.port}; the server may be offline or starting, so login will be attempted`);
        }

        const { mcdata } = mods;
        const t0 = Date.now();
        const bot = mcdata.initBot(this.cfg.username, {
            host: this.cfg.host,
            port: this.cfg.port,
            auth: this.cfg.auth,
            version: this.cfg.version,
            suppressPartialReadErrors: false,
        });
        this._prepareBot(bot);
        this.bot = bot;
        this.lastConnectionError = null;
        bot.once('login', () => { this.info.loggedIn = true; });
        try {
            await this._spawn(bot, phase.timeoutMs - (Date.now() - t0));
            this.connected = true;
        } catch (err) {
            await this._destroyBot(bot);
            throw err;
        }
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
        const before = mods.world.getInventoryCounts(bot)[blockType] || 0;
        const t0 = Date.now();
        let actionResult;
        try {
            actionResult = await mods.skills.collectBlock(bot, blockType, count);
        } catch (err) {
            throw new Error(`collectBlock("${blockType}", ${count}) failed: ${err.message}`);
        }
        await sleep(this.cfg.actionSettleMs ?? 800);
        const after = mods.world.getInventoryCounts(bot)[blockType] || 0;
        const gained = after - before;
        this.phaseInfo[phase.id] = {
            blockType, requested: count, before, after, gained,
            actionReturned: actionResult !== false, ms: Date.now() - t0,
        };
        if (gained < count) {
            throw new Error(`gather did not produce the required inventory delta for ${blockType}: gained ${gained}, need ${count}`);
        }
        return this.phaseInfo[phase.id];
    }

    /* ------------------------------------------------------------- phase 5 */
    async craft({ phase, task }) {
        const bot = this._assertBot();
        const mods = await this._modsOnce();
        const item = task.craft.item;
        const count = Number(task.craft.count) || 1;
        const before = mods.world.getInventoryCounts(bot);
        const t0 = Date.now();
        try {
            await mods.skills.craftRecipe(bot, item, count);
        } catch (err) {
            throw new Error(`craftRecipe("${item}") failed: ${err.message}`);
        }
        await sleep(this.cfg.actionSettleMs ?? 800);
        const after = mods.world.getInventoryCounts(bot);
        const productGain = (after[item] || 0) - (before[item] || 0);
        const consumed = inventoryDelta(before, after).filter((entry) => entry.delta < 0);
        this.phaseInfo[phase.id] = {
            item, requested: count, before: before[item] || 0, after: after[item] || 0,
            productGain, consumed, ms: Date.now() - t0,
        };
        if (productGain < count || !consumed.length) {
            throw new Error(`craft did not prove a material transaction for ${item}: product gain ${productGain}/${count}, consumed ${consumed.length ? consumed.map((x) => `${x.item} ${x.delta}`).join(', ') : 'nothing'}`);
        }
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
            const actual = await this._waitForBlock(bot, b, block, this.cfg.blockReadTimeoutMs ?? 3000);
            results.push({ ...b, placed: !!placed, actual, confirmed: actual === block });
            await sleep(this.cfg.placeDelayMs ?? 180); // server-friendly pacing
        }
        const confirmed = results.filter((r) => r.confirmed).length;
        this.phaseInfo[phase.id] = { block, anchor, attempted: results.length, confirmed, results };
        if (confirmed < this.placedBlocks.length) {
            throw new Error(`build verification failed: ${confirmed}/${this.placedBlocks.length} expected blocks were readable at their absolute coordinates`);
        }
        return this.phaseInfo[phase.id];
    }

    async _waitForBlock(bot, expected, name, timeoutMs) {
        const deadline = Date.now() + Math.max(250, timeoutMs);
        let actual = 'air';
        while (Date.now() < deadline) {
            actual = safe(() => {
                const block = bot.blockAt({ x: expected.x, y: expected.y, z: expected.z });
                return block?.name || 'air';
            }, 'unknown');
            if (actual === name) return actual;
            await sleep(100);
        }
        return actual;
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
        let settled = false;
        const inFlight = mods.skills.collectBlock(bot, blockType, target)
            .catch((err) => {
                this.recovery.detail += `initial collectBlock threw: ${err.message}; `;
                return false;
            })
            .finally(() => { settled = true; });

        await sleep(this.cfg.interruptAfterMs ?? 1500);
        if (settled) throw new Error('the recovery action completed before the intentional interruption window');

        // Cancel a real in-flight operation, then wait for it to settle before
        // retrying. Overlapping collectBlock calls would make the evidence
        // ambiguous and can leave a pathfinder task running after teardown.
        bot.interrupt_code = true;
        safe(() => bot.pathfinder?.stop?.());
        safe(() => bot.collectBlock?.cancelTask?.());
        await Promise.race([inFlight, sleep(5000)]);
        if (!settled) throw new Error('collectBlock did not settle after cancellation');
        const mid = mods.world.getInventoryCounts(bot)[blockType] || 0;
        const partial = mid - start;
        this.recovery.interrupted = true;
        this.recovery.detail += `stopped after ${partial}/${target} ${blockType}; `;

        bot.interrupt_code = false;
        const remaining = Math.max(1, target - Math.max(0, partial));
        let retry = false;
        try {
            retry = await mods.skills.collectBlock(bot, blockType, remaining);
        } catch (err) {
            this.recovery.detail += `retry threw: ${err.message}; `;
        }
        this.recovery.retried = retry !== false;
        this.recovery.resumed = this.recovery.retried;
        const end = mods.world.getInventoryCounts(bot)[blockType] || 0;
        this.phaseInfo[phase.id] = {
            ...this.recovery, startedWith: start, atInterrupt: partial,
            finalDelta: end - start, target,
        };
        if (!this.recovery.interrupted) throw new Error('interruption did not happen');
        if (end - start < target) throw new Error(`recovery retry produced ${end - start}/${target} ${blockType}`);
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
        // A genuine protocol-level drop, not a soft stop. Remove listeners
        // before ending the old client so its expected end is not stale state.
        this._detachLifecycle();
        this.connected = false;
        safe(() => bot.pathfinder?.stop?.());
        safe(() => bot.collectBlock?.cancelTask?.());
        safe(() => bot.quit('live test: deliberate disconnect'));
        safe(() => bot._client?.end?.());
        await sleep(this.cfg.reconnectDropWaitMs ?? 1500);
        this.bot = null;
        const fresh = mods.mcdata.initBot(this.cfg.username, {
            host: this.cfg.host,
            port: this.cfg.port,
            auth: this.cfg.auth,
            version: this.cfg.version,
            suppressPartialReadErrors: false,
        });
        this._prepareBot(fresh);
        this.bot = fresh;
        this.lastConnectionError = null;
        try {
            await this._spawn(fresh, Math.max(5000, this.cfg.reconnectTimeoutMs ?? 30000));
            this.connected = true;
        } catch (err) {
            await this._destroyBot(fresh);
            throw new Error(`reconnect failed: ${err.message}`);
        }
        await sleep(this.cfg.reconnectWorldWaitMs ?? 2500); // let chunks stream before re-reading
        const after = mods.world.getInventoryCounts(fresh);
        const blocksSurvived = before.placed.length === 0 ? true : await this._recheckBlocks(fresh, before.placed);
        const inventorySurvived = Object.entries(before.inventory).every(([item, count]) => (after[item] || 0) >= count - 0);
        const position = floorVec(fresh.entity?.position);
        const moved = before.position && position ? Math.sqrt(
            (position.x - before.position.x) ** 2 +
            (position.y - before.position.y) ** 2 +
            (position.z - before.position.z) ** 2
        ) : Infinity;
        this.reconnect = {
            performed: true,
            connected: true,
            reconnectMs: Date.now() - t0,
            blocksSurvived,
            inventorySurvived,
            stateRestored: moved < 8,
            detail: `dropped and rejoined in ${Date.now() - t0}ms; position delta ${Number.isFinite(moved) ? moved.toFixed(1) : 'unknown'} blocks`,
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
        return ok === blocks.length;
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
            connected: this.connected === true && !!bot.entity && !!bot?.ready && !this.lastConnectionError,
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

    async _destroyBot(bot) {
        if (!bot) return;
        // Keep an error listener while the client is being deliberately closed;
        // removing it before socket teardown can turn a late EPIPE into an
        // uncaught EventEmitter error. The operation's real error was already
        // recorded by the lifecycle handler.
        const teardownError = () => { };
        bot.on?.('error', teardownError);
        if (bot === this.bot) this._detachLifecycle();
        this.connected = false;
        safe(() => bot.interrupt_code = true);
        safe(() => bot.pathfinder?.stop?.());
        safe(() => bot.collectBlock?.cancelTask?.());
        safe(() => bot.quit('live integration test stopped'));
        safe(() => bot._client?.end?.());
        safe(() => bot._client?.destroy?.());
        if (bot === this.bot) this.bot = null;
        await sleep(this.cfg.teardownWaitMs ?? 100);
        bot.removeListener?.('error', teardownError);
    }

    async abort({ phase, error }) {
        this.log.error?.(`[live] stopping Mineflayer after ${phase?.id || 'phase'} failure: ${error?.message || error}`);
        await this._destroyBot(this.bot);
    }

    async teardown() {
        await this._destroyBot(this.bot);
    }
}

function inventoryDelta(before = {}, after = {}) {
    const names = new Set([...Object.keys(before || {}), ...Object.keys(after || {})]);
    return [...names]
        .map((item) => ({ item, delta: (after[item] || 0) - (before[item] || 0) }))
        .filter((entry) => entry.delta !== 0);
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
