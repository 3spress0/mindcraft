/**
 * schematic_build.js
 *
 * Drives a library schematic through the existing BuildGoal block-by-block
 * builder (src/agent/npc/build_goal.js). Handles:
 *   - converting any library format to a construction blueprint,
 *   - picking/resuming a placement corner and orientation,
 *   - progress reports, material shortfalls and verification passes,
 *   - persisting state so `!buildSchematic <name>` resumes after gathering.
 */

import { Vec3 } from 'vec3';
import * as world from '../library/world.js';
import { library, formatMaterialCounts } from '../schematics/library.js';
import { blockSatisfied, rotateXZ } from './utils.js';

const MAX_REPAIR_PASSES = 3;
// Above these footprints automatic placement gets unreliable; ask for coords.
const MAX_AUTO_WIDTH = 48;
const MAX_AUTO_HEIGHT = 64;

function scanProgress(bot, goal, position, orientation) {
    const sizex = goal.blocks[0][0].length;
    const sizez = goal.blocks[0].length;
    const sizey = goal.blocks.length;
    let wanted = 0;
    let satisfied = 0;
    for (let y = goal.offset; y < sizey + goal.offset; y++) {
        for (let z = 0; z < sizez; z++) {
            for (let x = 0; x < sizex; x++) {
                // Same rotation convention as BuildGoal.executeNext: the rotated
                // blueprint cell (rx, rz) lands at world offset (x, z).
                const [rx, rz] = rotateXZ(x, z, orientation, sizex, sizez);
                if (rz < 0 || rz >= sizez || rx < 0 || rx >= sizex) continue;
                const blockName = goal.blocks[y - goal.offset][rz][rx];
                if (blockName === null || blockName === '' || blockName === 'air') continue;
                const wx = position.x + x;
                const wy = position.y + y;
                const wz = position.z + z;
                wanted++;
                const block = bot.blockAt(new Vec3(wx, wy, wz));
                if (block && blockSatisfied(blockName, block)) satisfied++;
            }
        }
    }
    return { wanted, satisfied, percent: wanted ? Math.floor((satisfied / wanted) * 100) : 100 };
}

function pickPosition(agent, goal) {
    const sizex = goal.blocks[0][0].length;
    const sizez = goal.blocks[0].length;
    const sizey = goal.blocks.length;
    if (Math.max(sizex, sizez) > MAX_AUTO_WIDTH || sizey > MAX_AUTO_HEIGHT) {
        return { error: `that build is ${sizex}x${sizey}x${sizez}; please give explicit x y z coordinates for it` };
    }
    // Same search BuildGoal performs, but done up front so the placement can be
    // persisted before any (potentially interrupted) build pass.
    for (let x = 0; x < sizex - 1; x++) {
        const position = world.getNearestFreeSpace(agent.bot, sizex - x, 24);
        if (position) return { position };
    }
    return { error: 'could not find enough flat free space nearby; give explicit x y z coordinates' };
}

/**
 * Build one library entry block by block.
 * @param name        library key (filename without extension)
 * @param position    optional Vec3/object corner
 * @param orientation optional rotation 0-3
 * @returns object with status: 'complete' | 'missing' | 'error'
 */
export async function buildSchematic(agent, name, position = null, orientation = null) {
    const loaded = await library.getConstruction(name, agent.bot);
    if (!loaded) {
        const names = library.scan();
        return {
            status: 'error',
            message: `No build named "${name}" in the library. Available: ${names.slice(0, 20).join(', ')}${names.length > 20 ? ', ...' : ''}`,
        };
    }
    const { construction: goal, skipped, unknown, entry } = loaded;

    // Register it so the NPC goal system can resume/repair it by name too.
    agent.npc.constructions[entry.key] = goal;

    if (orientation === null || orientation === undefined) {
        const prev = agent.npc.data.built[entry.key];
        orientation = prev ? prev.orientation : Math.floor(Math.random() * 4);
    }

    if (!position) {
        const prev = agent.npc.data.built[entry.key];
        if (prev) {
            position = new Vec3(prev.position.x, prev.position.y, prev.position.z);
        } else {
            const picked = pickPosition(agent, goal);
            if (picked.error) return { status: 'error', message: picked.error };
            position = picked.position;
        }
    } else if (!(position instanceof Vec3)) {
        position = new Vec3(Math.floor(position.x), Math.floor(position.y), Math.floor(position.z));
    }

    // Persist before the first pass so interruptions/gathering trips resume here.
    agent.npc.data.built[entry.key] = { name: entry.key, position, orientation };

    const warnings = [];
    if (Object.keys(unknown).length > 0) {
        warnings.push(`skipped blocks unknown to Minecraft ${agent.bot.version}: ${formatMaterialCounts(unknown, 8)}`);
    }
    if (Object.keys(skipped).length > 0) {
        warnings.push(`skipped blocks with no placeable item: ${formatMaterialCounts(skipped, 8)}`);
    }

    const before = scanProgress(agent.bot, goal, position, orientation);
    agent.openChat(`Building ${entry.key} (${goal.blocks[0][0].length}x${goal.blocks.length}x${goal.blocks[0].length}), ${before.satisfied}/${before.wanted} blocks already in place...`);

    let res = null;
    for (let pass = 0; pass < MAX_REPAIR_PASSES; pass++) {
        res = await agent.npc.build_goal.executeNext(goal, position, orientation);
        position = res.position;
        orientation = res.orientation;
        agent.npc.data.built[entry.key] = { name: entry.key, position, orientation };

        if (res.missing && Object.keys(res.missing).length > 0) {
            const needed = Object.entries(res.missing)
                .sort((a, b) => b[1] - a[1])
                .map(([blockName, n]) => `${blockName} x${n}`)
                .join(', ');
            return {
                status: 'missing',
                message: `Build paused for ${entry.key}: gather ${needed}, then run !buildSchematic ${entry.key} to resume.`,
                missing: res.missing,
                warnings,
            };
        }
        if (!res.acted) {
            const after = scanProgress(agent.bot, goal, position, orientation);
            return {
                status: 'complete',
                message: `Finished building ${entry.key} (${after.satisfied}/${after.wanted} blocks).` +
                    (warnings.length ? ` Note: ${warnings.join('; ')}.` : ''),
                progress: after,
                warnings,
            };
        }
    }

    const after = scanProgress(agent.bot, goal, position, orientation);
    const remaining = after.wanted - after.satisfied;
    return {
        status: 'missing',
        message: `${entry.key} is ${after.percent}% complete (${after.satisfied}/${after.wanted}); ${remaining} blocks could not be placed yet ` +
            `(usually reach, collision or missing materials). Run !buildSchematic ${entry.key} to retry.` +
            (warnings.length ? ` Note: ${warnings.join('; ')}.` : ''),
        progress: after,
        warnings,
    };
}
