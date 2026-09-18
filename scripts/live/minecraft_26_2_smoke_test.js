#!/usr/bin/env node
/**
 * Isolated Mineflayer/Prismarine diagnostic for a real Minecraft 26.2 server.
 * This is intentionally outside the normal test suite: it needs a live server.
 * It stops at the first failed stage and does not start Mindcraft or an agent.
 *
 * Usage:
 *   MC_HOST=127.0.0.1 MC_PORT=25565 MC_USERNAME=SmokeTest \
 *     node scripts/live/minecraft_26_2_smoke_test.js
 *
 * Optional: MC_AUTH=offline, MC_TIMEOUT_MS=15000, --mutate
 * `--mutate` permits a best-effort dig/place exercise; without it the final
 * stages only validate that the relevant Mineflayer APIs and state are present.
 */

import mineflayer from 'mineflayer';

const args = new Set(process.argv.slice(2));
const cfg = {
    host: process.env.MC_HOST || '127.0.0.1',
    port: Number(process.env.MC_PORT || 25565),
    username: process.env.MC_USERNAME || 'MindcraftSmokeTest',
    auth: process.env.MC_AUTH || 'offline',
    version: process.env.MC_VERSION || '26.2',
    timeout: Number(process.env.MC_TIMEOUT_MS || 15000),
    mutate: args.has('--mutate'),
};

const stages = [];
let bot;
let failed = false;
const observed = new Set();

function pass(stage, detail = '') {
    stages.push({ stage, ok: true, detail });
    console.log(`[PASS] ${stage}${detail ? ` — ${detail}` : ''}`);
}
function fail(stage, error) {
    failed = true;
    const detail = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    stages.push({ stage, ok: false, detail });
    console.error(`[FAIL] ${stage} — ${detail}`);
}
function waitFor(event, stage, timeout = cfg.timeout) {
    if (observed.has(event)) return Promise.resolve([]);
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            cleanup();
            reject(new Error(`timed out after ${timeout}ms waiting for ${event}`));
        }, timeout);
        const onEvent = (...values) => {
            cleanup();
            resolve(values);
        };
        const cleanup = () => {
            clearTimeout(timer);
            bot?.removeListener(event, onEvent);
        };
        bot?.once(event, onEvent);
    });
}
async function stage(name, fn) {
    if (failed) return false;
    try {
        const detail = await fn();
        pass(name, detail || '');
        return true;
    } catch (error) {
        fail(name, error);
        return false;
    }
}

console.log(`Minecraft ${cfg.version} Smoke Test`);
console.log('==========================');
console.log(`Target: ${cfg.host}:${cfg.port}, username=${cfg.username}, auth=${cfg.auth}, version=${cfg.version}`);
console.log(`Mode: ${cfg.mutate ? 'mutation enabled (dig/place)' : 'read-only diagnostics'}`);

try {
    bot = mineflayer.createBot({
        host: cfg.host,
        port: cfg.port,
        username: cfg.username,
        auth: cfg.auth,
        version: cfg.version,
        checkTimeoutInterval: cfg.timeout,
    });
    for (const event of ['connect', 'login', 'spawn', 'chunkColumnLoad']) {
        bot.on(event, () => observed.add(event));
    }
    bot.on('error', error => {
        if (!failed) console.error(`[EVENT] error — ${error.message}`);
    });
    bot.on('kicked', reason => {
        if (!failed) console.error(`[EVENT] kicked — ${typeof reason === 'string' ? reason : JSON.stringify(reason)}`);
    });
    bot._client?.on('error', error => {
        if (!failed) console.error(`[EVENT] protocol error — ${error.message}`);
    });
    bot._client?.on('close', () => {
        if (!failed) console.error('[EVENT] socket closed before the next stage');
    });
} catch (error) {
    fail('Create client', error);
}

await stage('TCP connection', async () => {
    await waitFor('connect', 'TCP connection');
    return `${cfg.host}:${cfg.port}`;
});
await stage('Login', async () => {
    await waitFor('login', 'Login');
    return `protocol=${bot?._client?.version ?? cfg.version}`;
});
await stage('Configuration / registry', async () => {
    // Mineflayer exposes the registry after minecraft-protocol has completed
    // the configuration phase. There is no stable public configuration event
    // across all supported versions, so check the actual initialized object.
    if (!bot.registry || !bot.registry.blocksByName || !bot.registry.itemsByName) {
        throw new Error('bot.registry is missing block/item registries');
    }
    return `blocks=${Object.keys(bot.registry.blocksByName).length}, items=${Object.keys(bot.registry.itemsByName).length}`;
});
await stage('Join Game', async () => {
    if (bot.game == null) throw new Error('bot.game was not initialized');
    return `dimension=${bot.game.dimension ?? 'unknown'}`;
});
await stage('Player spawn', async () => {
    if (!bot.entity) await waitFor('spawn', 'Player spawn');
    if (!bot.entity) throw new Error('bot.entity is missing after spawn');
    return `entityId=${bot.entity.id}`;
});
await stage('Position', async () => {
    if (!bot.entity?.position) throw new Error('player position is missing');
    return `${bot.entity.position.x},${bot.entity.position.y},${bot.entity.position.z}`;
});
await stage('Chunk', async () => {
    if (!bot.world) throw new Error('bot.world is missing');
    if (typeof bot.blockAt !== 'function') throw new Error('bot.blockAt is unavailable');
    if (bot.world.columns && Object.keys(bot.world.columns).length === 0) {
        await waitFor('chunkColumnLoad', 'Chunk');
    }
    return `columns=${bot.world.columns ? Object.keys(bot.world.columns).length : 'loaded'}`;
});
await stage('Block lookup', async () => {
    const block = bot.blockAt(bot.entity.position);
    if (!block || typeof block.name !== 'string') throw new Error('blockAt returned no usable block');
    return `${block.name} at ${block.position}`;
});
await stage('Inventory', async () => {
    if (!bot.inventory || !Array.isArray(bot.inventory.slots)) throw new Error('inventory slots are unavailable');
    return `slots=${bot.inventory.slots.length}`;
});
await stage('Movement API', async () => {
    if (typeof bot.setControlState !== 'function') throw new Error('setControlState is unavailable');
    if (!cfg.mutate) return 'API available (read-only; use --mutate for movement)';
    const before = bot.entity.position.clone?.() ?? { x: bot.entity.position.x, z: bot.entity.position.z };
    bot.setControlState('forward', true);
    await new Promise(resolve => setTimeout(resolve, 750));
    bot.setControlState('forward', false);
    const after = bot.entity.position;
    return `position ${before.x},${before.z} -> ${after.x},${after.z}`;
});
await stage('Digging API', async () => {
    if (typeof bot.dig !== 'function') throw new Error('bot.dig is unavailable');
    if (!cfg.mutate) return 'API available (read-only; use --mutate for digging)';
    const block = bot.blockAt(bot.entity.position.offset(0, -1, 0));
    if (!block || block.name === 'air' || !bot.canDigBlock(block)) throw new Error('no safe diggable block under player');
    await bot.dig(block);
    return `dug ${block.name}`;
});
await stage('Placement API', async () => {
    if (typeof bot.placeBlock !== 'function') throw new Error('bot.placeBlock is unavailable');
    if (!cfg.mutate) return 'API available (read-only; use --mutate for placement)';
    return 'API available (not attempted automatically; provide an explicit item/target policy before mutating placement)';
});

if (bot) {
    // `quit()` can wait for a play-state packet after an early login failure.
    // Force the diagnostic client to release its socket in every outcome.
    try { bot.end('smoke test complete'); } catch { /* already closed */ }
    try { bot._client?.end(); } catch { /* already closed */ }
}
console.log('');
console.log(failed ? 'Smoke test stopped at the first failure.' : 'Smoke test completed.');
process.exit(failed ? 1 : 0);
