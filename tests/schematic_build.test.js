import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { Vec3 } from 'vec3';
import settings from '../src/agent/settings.js';
import { library } from '../src/agent/schematics/library.js';
import { buildSchematic } from '../src/agent/npc/schematic_build.js';

// Minimal litematic fixture: stone then dirt in a 2x1x1 row.
function fixtureBuffer() {
    // Reuse the well-tested packing through a hand-rolled NBT document.
    return import('prismarine-nbt').then(async (nbtMod) => {
        const nbt = nbtMod.default;
        const zlib = await import('zlib');
        const state = (name) => ({ Name: { type: 'string', value: name } });
        // bits=2, indices [1,2]
        const data = [1n | (2n << 2n)]; // packed into one long
        const root = {
            type: 'compound', name: '',
            value: {
                Version: { type: 'int', value: 6 },
                Metadata: { type: 'compound', value: { Name: { type: 'string', value: 'row' } } },
                Regions: { type: 'compound', value: { Main: { type: 'compound', value: {
                    Position: { type: 'compound', value: {
                        x: { type: 'long', value: 0n }, y: { type: 'long', value: 0n }, z: { type: 'long', value: 0n } } },
                    Size: { type: 'compound', value: {
                        x: { type: 'long', value: 2n }, y: { type: 'long', value: 1n }, z: { type: 'long', value: 1n } } },
                    BlockStatePalette: { type: 'list', value: { type: 'compound', value: [
                        state('minecraft:air'), state('minecraft:stone'), state('minecraft:dirt')] } },
                    BlockStates: { type: 'compound', value: {
                        data: { type: 'longArray', value: data.map((x) => BigInt.asIntN(64, x)) },
                        bits: { type: 'long', value: 2n } } },
                } } } },
            },
        };
        return zlib.gzipSync(nbt.writeUncompressed(root, 'big'));
    });
}

function fakeAgent(worldBlocks) {
    const goalCalls = [];
    const world = worldBlocks;
    const agent = {
        openChat: () => {},
        bot: {
            version: '1.21.1',
            blockAt: (p) => ({ name: world.get(`${p.x},${p.y},${p.z}`) || 'air' }),
        },
        npc: {
            constructions: {},
            data: { built: {} },
            build_goal: { executeNext: async () => {} },
        },
    };
    agent.setPass = (fn) => {
        agent.npc.build_goal.executeNext = async (goal, position, orientation) => {
            goalCalls.push({ position: position.clone(), orientation });
            return fn(goal, position, orientation);
        };
    };
    agent.goalCalls = goalCalls;
    return agent;
}

let tmpDir;
let prevLib;

beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mindcraft-build-'));
    prevLib = settings.schematic_library;
    settings.schematic_library = tmpDir;
    fs.writeFileSync(path.join(tmpDir, 'row.litematic'), await fixtureBuffer());
    library.scan();
});

afterEach(() => {
    settings.schematic_library = prevLib;
    fs.rmSync(tmpDir, { recursive: true, force: true });
    library.scan();
});

test('pauses for missing materials, remembers placement, then completes on resume', async () => {
    const pos = new Vec3(10, 64, 20);
    const setBlock = (world, x, name) => world.set(`${10 + x},64,20`, name);

    // Pass 1: stone gets placed, dirt is missing.
    const agentA = fakeAgent(new Map());
    agentA.setPass((goal) => {
        setBlock(new Map(), 0, 'stone'); // throwaway: cannot mutate shared world yet
        return { missing: { dirt: 1 }, acted: true, position: pos, orientation: 0 };
    });
    let res = await buildSchematic(agentA, 'row', pos.clone(), 0);
    assert.equal(res.status, 'missing');
    assert.match(res.message, /gather dirt x1/);
    // Placement persisted for resume.
    assert.deepEqual(agentA.npc.data.built.row.position, pos);
    assert.equal(agentA.npc.constructions.row.blocks[0][0][0], 'stone');

    // Resume: no explicit coords, stored position reused; stone already there,
    // dirt placed this pass (verification pass then reports acted:false).
    const world = new Map();
    const agentB = fakeAgent(world);
    agentB.npc.data.built.row = { name: 'row', position: pos, orientation: 0 };
    let pass = 0;
    agentB.setPass(() => {
        pass++;
        if (pass === 1) {
            setBlock(world, 0, 'stone');
            setBlock(world, 1, 'dirt');
            return { missing: {}, acted: true, position: pos, orientation: 0 };
        }
        return { missing: {}, acted: false, position: pos, orientation: 0 };
    });
    res = await buildSchematic(agentB, 'row');
    assert.equal(res.status, 'complete');
    assert.match(res.message, /2\/2 blocks/);
    assert.equal(agentB.goalCalls[0].position.x, 10);
});

test('unknown build name lists available entries', async () => {
    const agent = fakeAgent(new Map());
    const res = await buildSchematic(agent, 'nope', new Vec3(0, 64, 0), 0);
    assert.equal(res.status, 'error');
    assert.match(res.message, /No build named "nope"/);
    assert.match(res.message, /row/);
});

test('oversized builds without coordinates are refused', async () => {
    // Build a big blueprint JSON directly in the library.
    const layer = [Array.from({ length: 60 }, () => 'stone')];
    const blocks = [layer];
    fs.writeFileSync(path.join(tmpDir, 'big.json'), JSON.stringify({ name: 'big', offset: 0, blocks }));
    library.scan();
    const agent = fakeAgent(new Map());
    const res = await buildSchematic(agent, 'big'); // no coords
    assert.equal(res.status, 'error');
    assert.match(res.message, /explicit x y z/);
});
