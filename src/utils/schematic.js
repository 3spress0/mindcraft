/**
 * schematic.js
 *
 * Readers for the three modern schematic formats mindcraft can build from,
 * converted into a single normalized voxel model (and, from there, into the
 * mindcraft construction-blueprint shape used by src/agent/npc/build_goal.js):
 *
 *   - .litematic  Litematica mod exports (NBT, gzip, big-endian). Block states
 *                 live in a named palette and the voxels are packed variable
 *                 bit-width longs, which may straddle 64-bit long boundaries.
 *   - .schem      Sponge schematic format v2/v3 (WorldEdit, and Baritone's
 *                 native build format). Palette indices are LEB128 varints.
 *   - .nbt        Vanilla structure-block templates (sparse block list).
 *
 * The classic MCEdit/Schematica .schematic format is intentionally not
 * supported: it stores pre-flattening numeric block ids that require per-version
 * legacy mappings. Export it to .schem/.litematic from WorldEdit or Litematica.
 *
 * Format references:
 *   https://github.com/maruohon/litematica/wiki
 *   https://github.com/SpongePowered/Schematic-Specification
 *   https://minecraft.wiki/w/Structure_Block_file_format
 */

import fs from 'fs';
import nbt from 'prismarine-nbt';

// nbt.parse returns a Promise<{parsed,...}> when called without a callback
// (promisify-ing it would double-wrap and resolve with the tag itself).
const nbtParse = (buffer) => nbt.parse(buffer);

export const VOID = 0xFFFFFFFF;
const AIR_LIKE = new Set(['air', 'cave_air', 'void_air']);

/**
 * Blocks whose inventory item uses a different name than the block state, or
 * which are placed from a bucket. Material lists use item names; the voxel
 * model keeps block names so build verification compares apples to apples.
 */
const BLOCK_TO_ITEM = {
    redstone_wire: 'redstone',
    wall_torch: 'torch',
    soul_wall_torch: 'soul_torch',
    redstone_wall_torch: 'redstone_torch',
    oak_wall_sign: 'oak_sign',
    spruce_wall_sign: 'spruce_sign',
    birch_wall_sign: 'birch_sign',
    jungle_wall_sign: 'jungle_sign',
    acacia_wall_sign: 'acacia_sign',
    dark_oak_wall_sign: 'dark_oak_sign',
    mangrove_wall_sign: 'mangrove_sign',
    cherry_wall_sign: 'cherry_sign',
    bamboo_wall_sign: 'bamboo_sign',
    crimson_wall_sign: 'crimson_sign',
    warped_wall_sign: 'warped_sign',
    water: 'water_bucket',
    lava: 'lava_bucket',
    powder_snow: 'powder_snow_bucket',
};

/**
 * Technical blocks that have no block item and cannot be placed by a survival
 * bot; reported as skipped during a build.
 */
const NO_ITEM_BLOCKS = new Set([
    'farmland', 'dirt_path', 'grass_path', 'frosted_ice', 'fire', 'soul_fire',
    'nether_portal', 'end_portal', 'end_gateway', 'bubble_column', 'moving_piston',
    'piston_head', 'end_portal_frame', 'light', 'structure_void',
    'tall_seagrass', 'kelp_plant', 'weeping_vines_plant',
    'twisting_vines_plant', 'cave_vines_plant',
]);

/**
 * Block states whose inventory ITEM name differs from the block name and which
 * a bot places by item. Applied when emitting build cells (water/lava are kept
 * as-is: the cheat builder /setblocks them directly and placeBlock resolves
 * buckets in survival).
 */
const CONSTRUCTION_RENAME = {
    redstone_wire: 'redstone',
    wall_torch: 'torch',
    soul_wall_torch: 'soul_torch',
    redstone_wall_torch: 'redstone_torch',
    oak_wall_sign: 'oak_sign',
    spruce_wall_sign: 'spruce_sign',
    birch_wall_sign: 'birch_sign',
    jungle_wall_sign: 'jungle_sign',
    acacia_wall_sign: 'acacia_sign',
    dark_oak_wall_sign: 'dark_oak_sign',
    mangrove_wall_sign: 'mangrove_sign',
    cherry_wall_sign: 'cherry_sign',
    bamboo_wall_sign: 'bamboo_sign',
    crimson_wall_sign: 'crimson_sign',
    warped_wall_sign: 'warped_sign',
};

export class SchematicError extends Error {}

function num(v) {
    if (v == null) return 0;
    if (typeof v === 'bigint') return Number(v);
    if (Array.isArray(v)) {
        // prismarine-nbt scalar TAG_Long simplifies to a [high, low] pair.
        const low = v[1] >>> 0;
        const high = v[0] | 0;
        return high * 0x100000000 + low;
    }
    return v;
}

function ceilLog2(n) {
    let b = 0;
    while ((1 << b) < n) b++;
    return b;
}

/**
 * Unpack Litematica's variable-bit array. Unlike vanilla chunk palettes, an
 * entry is allowed to straddle two longs (see LitematicaBitArray).
 */
export function unpackLitematicaLongs(longs, bitsPerEntry, count) {
    if (bitsPerEntry < 1) throw new SchematicError(`Invalid bits-per-entry: ${bitsPerEntry}`);
    if (bitsPerEntry > 62) throw new SchematicError(`bits-per-entry too large: ${bitsPerEntry}`);
    const mask = (1n << BigInt(bitsPerEntry)) - 1n;
    const out = new Uint32Array(count);
    const bits = BigInt(bitsPerEntry);
    for (let i = 0; i < count; i++) {
        const start = BigInt(i) * bits;
        const longIndex = Number(start / 64n);
        const bitOffset = Number(start % 64n);
        // Java uses UNSIGNED >>> shifts on the packed longs; interpret each
        // long as uint64 so BigInt's arithmetic >> behaves identically.
        let value = BigInt.asUintN(64, longs[longIndex]) >> BigInt(bitOffset);
        if (bitOffset + bitsPerEntry > 64) {
            value |= BigInt.asUintN(64, longs[longIndex + 1]) << BigInt(64 - bitOffset);
        }
        out[i] = Number(value & mask);
    }
    return out;
}

/** Decode Sponge BlockData: unsigned LEB128 varints over a signed byte array. */
export function readSpongeVarints(bytes, count) {
    const out = new Uint32Array(count);
    let p = 0;
    for (let i = 0; i < count; i++) {
        let value = 0;
        let shift = 0;
        let b;
        do {
            if (p >= bytes.length) throw new SchematicError('BlockData ended before all palette indices were read');
            b = bytes[p++] & 0xff;
            value |= (b & 0x7f) << shift;
            shift += 7;
        } while ((b & 0x80) !== 0 && shift < 35);
        out[i] = value >>> 0;
    }
    return out;
}

function asLong(x) {
    if (typeof x === 'bigint') return BigInt.asIntN(64, x);
    if (Array.isArray(x)) {
        // prismarine-nbt long: [high, low] 32-bit parts. Reconstruct exactly,
        // avoiding Number's 53-bit precision loss on packed unsigned longs.
        return (BigInt(x[0] | 0) << 32n) | BigInt(x[1] >>> 0);
    }
    return BigInt.asIntN(64, BigInt(Number(x)));
}

function asLongArray(tag) {
    if (!tag) throw new SchematicError('Missing packed block-state array');
    const arr = tag.value ?? tag;
    return arr.map(asLong);
}

/**
 * @typedef {Object} NormalizedSchematic
 * @property {string} format
 * @property {string} name
 * @property {string} author
 * @property {string} description
 * @property {number} width  X size
 * @property {number} height Y size
 * @property {number} length Z size
 * @property {{x:number,y:number,z:number}} origin trim offset vs the source file
 * @property {Uint32Array} voxels index (y*length+z)*width+x into palette; VOID = empty
 * @property {Array<{name:string, props:Object}>} palette real states start at index 0
 * @property {Array<{id:string,x:number,y:number,z:number}>} tileEntities
 */
class SchematicModel {
    constructor(props) {
        Object.assign(this, props);
    }

    index(x, y, z) {
        return (y * this.length + z) * this.width + x;
    }

    stateAt(x, y, z) {
        if (x < 0 || y < 0 || z < 0 || x >= this.width || y >= this.height || z >= this.length) return null;
        const id = this.voxels[this.index(x, y, z)];
        return id === VOID ? null : this.palette[id];
    }
}

/**
 * Build the normalized voxel model from dense (format-local) palette data.
 * @param dims   {x,y,z} voxel dimensions
 * @param states array length x*y*z of {name, props} or null, ordered (y*z+x...)
 *               local index = (ly*sizeZ+lz)*sizeX+lx
 * @param order  local index order; default litematic/sponge order
 */
function buildModel(format, dims, states, meta = {}) {
    const sx = dims.x;
    const sy = dims.y;
    const sz = dims.z;

    // Find the tight bounding box of non-air content and trim it.
    let minX = sx, minY = sy, minZ = sz, maxX = -1, maxY = -1, maxZ = -1;
    const solidLike = (s) => s && !AIR_LIKE.has(s.name.split(':').pop());
    for (let y = 0; y < sy; y++) {
        for (let z = 0; z < sz; z++) {
            for (let x = 0; x < sx; x++) {
                if (solidLike(states[(y * sz + z) * sx + x])) {
                    if (x < minX) minX = x;
                    if (x > maxX) maxX = x;
                    if (y < minY) minY = y;
                    if (y > maxY) maxY = y;
                    if (z < minZ) minZ = z;
                    if (z > maxZ) maxZ = z;
                }
            }
        }
    }
    if (maxX < 0) throw new SchematicError('Schematic contains no blocks');

    const width = maxX - minX + 1;
    const height = maxY - minY + 1;
    const length = maxZ - minZ + 1;

    // Intern distinct block states.
    const palette = [];
    const paletteMap = new Map();
    const intern = (state) => {
        const key = state.name + ' ' + JSON.stringify(state.props || {});
        let id = paletteMap.get(key);
        if (id === undefined) {
            id = palette.length;
            palette.push({ name: state.name, props: state.props || {} });
            paletteMap.set(key, id);
        }
        return id;
    };

    const voxels = new Uint32Array(width * height * length).fill(VOID);
    for (let y = 0; y < height; y++) {
        for (let z = 0; z < length; z++) {
            for (let x = 0; x < width; x++) {
                const state = states[((y + minY) * sz + (z + minZ)) * sx + (x + minX)];
                if (state) voxels[(y * length + z) * width + x] = intern(state);
            }
        }
    }

    const tileEntities = (meta.tileEntities || []).map((t) => ({
        id: t.id,
        x: num(t.x) - minX,
        y: num(t.y) - minY,
        z: num(t.z) - minZ,
    })).filter((t) => t.x >= 0 && t.x < width && t.y >= 0 && t.y < height && t.z >= 0 && t.z < length);

    return new SchematicModel({
        format: meta.format || format,
        name: meta.name || 'schematic',
        author: meta.author || '',
        description: meta.description || '',
        width,
        height,
        length,
        origin: { x: minX, y: minY, z: minZ },
        voxels,
        palette,
        tileEntities,
    });
}

function paletteState(entry) {
    // Litematica / vanilla structure: { Name: 'minecraft:oak_planks', Properties: {...} }
    const name = entry.Name || entry.name || 'minecraft:air';
    const props = {};
    const rawProps = entry.Properties || entry.properties;
    if (rawProps) for (const k of Object.keys(rawProps)) props[k] = String(rawProps[k]);
    return { name: String(name), props };
}

async function parseLitematic(buffer) {
    const { parsed } = await nbtParse(buffer);
    const root = nbt.simplify(parsed);
    const regions = root.Regions;
    if (!regions || typeof regions !== 'object') throw new SchematicError('Litematic has no Regions compound');
    const regionNames = Object.keys(regions);
    if (regionNames.length === 0) throw new SchematicError('Litematic has no regions');

    const meta = root.Metadata || {};
    const merged = [];
    let enclosing = null;
    for (const rName of regionNames) {
        const region = regions[rName];
        const size = region.Size;
        const sizeAbs = { x: Math.abs(num(size.x)), y: Math.abs(num(size.y)), z: Math.abs(num(size.z)) };
        if (sizeAbs.x < 1 || sizeAbs.y < 1 || sizeAbs.z < 1) {
            throw new SchematicError(`Region "${rName}" has an invalid size`);
        }
        // Size can be negative; the region then extends from Position towards
        // the negative axis. Normalize to a min corner.
        const pos = region.Position || { x: 0, y: 0, z: 0 };
        const minCorner = {
            x: num(size.x) >= 0 ? num(pos.x) : num(pos.x) + num(size.x) + 1,
            y: num(size.y) >= 0 ? num(pos.y) : num(pos.y) + num(size.y) + 1,
            z: num(size.z) >= 0 ? num(pos.z) : num(pos.z) + num(size.z) + 1,
        };

        const rawPalette = region.BlockStatePalette || [];
        if (!Array.isArray(rawPalette) || rawPalette.length === 0) {
            throw new SchematicError(`Region "${rName}" has no block-state palette`);
        }
        const paletteEntries = rawPalette.map(paletteState);

        let packedTag = region.BlockStates;
        let bitsPerEntry;
        let packed;
        if (packedTag && Array.isArray(packedTag.data)) {
            packed = asLongArray(packedTag.data);
            bitsPerEntry = packedTag.bits != null ? num(packedTag.bits) : Math.max(2, ceilLog2(paletteEntries.length));
        } else if (packedTag && packedTag.type === 'longArray') {
            packed = asLongArray(packedTag);
            bitsPerEntry = Math.max(2, ceilLog2(paletteEntries.length));
        } else if (Array.isArray(packedTag)) {
            // Old format: BlockStates was a bare long array on the region.
            packed = asLongArray(packedTag);
            bitsPerEntry = Math.max(2, ceilLog2(paletteEntries.length));
        } else {
            throw new SchematicError(`Region "${rName}" has no packed BlockStates`);
        }

        const volume = sizeAbs.x * sizeAbs.y * sizeAbs.z;
        const indices = unpackLitematicaLongs(packed, bitsPerEntry, volume);
        const states = new Array(volume);
        for (let i = 0; i < volume; i++) {
            const entry = paletteEntries[indices[i]];
            states[i] = entry && !AIR_LIKE.has(entry.name.split(':').pop()) ? entry : null;
        }

        const te = [];
        for (const t of (region.BlockEntities || region.TileEntities || [])) {
            const p = t.pos || [];
            te.push({
                id: String(t.id || 'minecraft:air'),
                x: minCorner.x + (Array.isArray(p) ? num(p[0]) : num(t.x)),
                y: minCorner.y + (Array.isArray(p) ? num(p[1]) : num(t.y)),
                z: minCorner.z + (Array.isArray(p) ? num(p[2]) : num(t.z)),
            });
        }

        merged.push({ minCorner, dims: sizeAbs, states, tileEntities: te });
        const maxCorner = {
            x: minCorner.x + sizeAbs.x - 1,
            y: minCorner.y + sizeAbs.y - 1,
            z: minCorner.z + sizeAbs.z - 1,
        };
        if (!enclosing) {
            enclosing = { min: { ...minCorner }, max: maxCorner };
        } else {
            enclosing.min.x = Math.min(enclosing.min.x, minCorner.x);
            enclosing.min.y = Math.min(enclosing.min.y, minCorner.y);
            enclosing.min.z = Math.min(enclosing.min.z, minCorner.z);
            enclosing.max.x = Math.max(enclosing.max.x, maxCorner.x);
            enclosing.max.y = Math.max(enclosing.max.y, maxCorner.y);
            enclosing.max.z = Math.max(enclosing.max.z, maxCorner.z);
        }
    }

    // Merge every region into one enclosing dense grid.
    const dims = {
        x: enclosing.max.x - enclosing.min.x + 1,
        y: enclosing.max.y - enclosing.min.y + 1,
        z: enclosing.max.z - enclosing.min.z + 1,
    };
    const allStates = new Array(dims.x * dims.y * dims.z).fill(null);
    const allTE = [];
    for (const m of merged) {
        for (let y = 0; y < m.dims.y; y++) {
            for (let z = 0; z < m.dims.z; z++) {
                for (let x = 0; x < m.dims.x; x++) {
                    const s = m.states[(y * m.dims.z + z) * m.dims.x + x];
                    if (s) {
                        const gx = m.minCorner.x - enclosing.min.x + x;
                        const gy = m.minCorner.y - enclosing.min.y + y;
                        const gz = m.minCorner.z - enclosing.min.z + z;
                        allStates[(gy * dims.z + gz) * dims.x + gx] = s;
                    }
                }
            }
        }
        for (const t of m.tileEntities) {
            allTE.push({
                id: t.id,
                x: t.x - enclosing.min.x,
                y: t.y - enclosing.min.y,
                z: t.z - enclosing.min.z,
            });
        }
    }

    return buildModel('litematic', dims, allStates, {
        format: 'litematic',
        name: cleanName(meta.Name || regionNames[0]),
        author: meta.Author || '',
        description: meta.Description || '',
        tileEntities: allTE,
    });
}

async function parseSponge(buffer) {
    const { parsed } = await nbtParse(buffer);
    const root = nbt.simplify(parsed);
    const width = num(root.Width);
    const height = num(root.Height);
    const length = num(root.Length);
    if (!width || !height || !length) throw new SchematicError('Sponge schematic has invalid dimensions');

    // Palette is name -> index.
    const paletteById = new Map();
    for (const [stateName, id] of Object.entries(root.Palette || {})) {
        const [name, propsString] = stateName.split('[');
        const props = {};
        if (propsString) {
            propsString.replace(/\]$/, '').split(',').forEach((pair) => {
                const [k, v] = pair.split('=');
                props[k] = v;
            });
        }
        paletteById.set(num(id), { name, props });
    }

    const volume = width * height * length;
    const indices = readSpongeVarints(root.BlockData || [], volume);
    const states = new Array(volume);
    for (let i = 0; i < volume; i++) {
        const entry = paletteById.get(indices[i]);
        states[i] = entry && !AIR_LIKE.has(entry.name.split(':').pop()) ? entry : null;
    }

    const offset = root.Offset || [0, 0, 0];
    const te = (root.BlockEntities || []).map((t) => {
        const p = t.Pos || t.pos || [];
        return {
            id: String(t.Id || t.id || 'minecraft:air'),
            x: Array.isArray(p) ? num(p[0]) + num(offset[0]) : num(t.x),
            y: Array.isArray(p) ? num(p[1]) + num(offset[1]) : num(t.y),
            z: Array.isArray(p) ? num(p[2]) + num(offset[2]) : num(t.z),
        };
    });

    return buildModel('sponge', { x: width, y: height, z: length }, states, {
        format: 'sponge',
        name: cleanName(root.Metadata?.Name) || 'sponge_schematic',
        author: '',
        description: '',
        tileEntities: te,
    });
}

async function parseStructure(buffer) {
    const { parsed } = await nbtParse(buffer);
    const root = nbt.simplify(parsed);
    const sizeList = root.size || [];
    const [width, height, length] = [num(sizeList[0]), num(sizeList[1]), num(sizeList[2])];
    if (!width || !height || !length) throw new SchematicError('Structure NBT has an invalid size');

    const paletteEntries = (root.palette || []).map(paletteState);
    const volume = width * height * length;
    const states = new Array(volume).fill(null);
    for (const b of root.blocks || []) {
        const p = b.pos || [];
        const x = num(p[0]);
        const y = num(p[1]);
        const z = num(p[2]);
        if (x < 0 || y < 0 || z < 0 || x >= width || y >= height || z >= length) continue;
        const entry = paletteEntries[num(b.state)];
        if (entry && !AIR_LIKE.has(entry.name.split(':').pop())) {
            states[(y * length + z) * width + x] = entry;
        }
    }

    const te = [];
    for (const b of root.blocks || []) {
        if (!b.nbt) continue;
        const p = b.pos || [];
        te.push({ id: String(b.nbt.id || 'minecraft:air'), x: num(p[0]), y: num(p[1]), z: num(p[2]) });
    }

    return buildModel('structure', { x: width, y: height, z: length }, states, {
        format: 'structure',
        name: 'vanilla_structure',
        author: '',
        description: '',
        tileEntities: te,
    });
}

function cleanName(name) {
    if (!name) return null;
    return String(name).replace(/\.[^.]+$/, '').replace(/[^a-zA-Z0-9_\- ]/g, '_').trim() || null;
}

/**
 * Parse a schematic buffer by extension/content.
 * @param {Buffer} buffer raw file bytes
 * @param {string} filename used to pick the format (.litematic/.schem/.nbt)
 * @returns {Promise<NormalizedSchematic>}
 */
export async function readSchematic(buffer, filename = '') {
    const lower = filename.toLowerCase();
    try {
        if (lower.endsWith('.litematic')) return await parseLitematic(buffer);
        if (lower.endsWith('.schem')) return await parseSponge(buffer);
        if (lower.endsWith('.nbt')) return await parseStructure(buffer);
    } catch (e) {
        if (e instanceof SchematicError) throw e;
        throw new SchematicError(`Failed to parse ${filename}: ${e.message}`);
    }
    throw new SchematicError(`Unsupported schematic extension: ${filename} (use .litematic, .schem or .nbt)`);
}

/** Strip the minecraft: namespace from a block state name. */
export function blockBaseName(stateName) {
    const i = stateName.indexOf(':');
    return i >= 0 ? stateName.slice(i + 1) : stateName;
}

/**
 * Material list of a schematic: { itemName: count } using inventory item names
 * (redstone_wire -> redstone etc.). Air and no-item technical blocks excluded.
 */
export function materialList(schematic, { includeNoItem = false } = {}) {
    const counts = {};
    const skipped = {};
    for (const state of schematic.palette) {
        const base = blockBaseName(state.name);
        let n = 0;
        for (const id of schematic.voxels) {
            if (id !== VOID && schematic.palette[id] === state) n++;
        }
        if (n === 0) continue;
        const item = BLOCK_TO_ITEM[base] || base;
        if (NO_ITEM_BLOCKS.has(base)) {
            skipped[base] = (skipped[base] || 0) + n;
            if (includeNoItem) counts[item] = (counts[item] || 0) + n;
            continue;
        }
        counts[item] = (counts[item] || 0) + n;
    }
    return { materials: counts, skipped };
}

/**
 * Convert a normalized schematic into the mindcraft construction-blueprint
 * shape consumed by src/agent/npc/build_goal.js:
 *   { name, offset, blocks: [y][z][x] } where each cell is a block name,
 *   'air' (clear this spot) or '' (leave any existing terrain untouched).
 *
 * `resolve` optionally validates names against the connected bot version:
 *   resolve(blockName) -> truthy when the block exists in this version.
 * Unknown names become '' and are reported in `skipped` instead of causing an
 * endless unplaceable-material loop.
 */
export function toConstruction(schematic, { name = null, resolve = null } = {}) {
    const blocks = [];
    const skipped = {};
    const unknown = {};
    for (let y = 0; y < schematic.height; y++) {
        const layer = [];
        for (let z = 0; z < schematic.length; z++) {
            const row = [];
            for (let x = 0; x < schematic.width; x++) {
                const state = schematic.stateAt(x, y, z);
                if (!state) {
                    row.push('air');
                    continue;
                }
                const base = blockBaseName(state.name);
                if (NO_ITEM_BLOCKS.has(base)) {
                    skipped[base] = (skipped[base] || 0) + 1;
                    row.push('');
                    continue;
                }
                // Build from the inventory item when the placed state differs.
                const cellName = CONSTRUCTION_RENAME[base] || base;
                if (resolve && !resolve(cellName)) {
                    unknown[cellName] = (unknown[cellName] || 0) + 1;
                    row.push('');
                    continue;
                }
                row.push(cellName);
            }
            layer.push(row);
        }
        blocks.push(layer);
    }
    return {
        construction: {
            name: name || schematic.name || 'schematic',
            offset: 0,
            blocks,
        },
        skipped,
        unknown,
    };
}

/** Read and parse a schematic straight from a file path. */
export async function readSchematicFile(filePath) {
    const buffer = fs.readFileSync(filePath);
    return await readSchematic(buffer, filePath);
}

export const SUPPORTED_EXTENSIONS = ['.litematic', '.schem', '.nbt', '.json'];
export { BLOCK_TO_ITEM, CONSTRUCTION_RENAME, NO_ITEM_BLOCKS, AIR_LIKE };
