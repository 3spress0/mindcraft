/**
 * library.js
 *
 * The bot's build library: a folder of Litematica (.litematic), Sponge
 * (.schem), vanilla structure (.nbt) and mindcraft blueprint (.json) files
 * the bot can browse, report material lists for, and build block by block.
 *
 * Drop schematic files into the configured `schematic_library` folder
 * (default: ./schematics in the project root). The built-in blueprints in
 * src/agent/npc/construction are always available too.
 */

import fs from 'fs';
import path from 'path';
import settings from '../settings.js';
import * as mc from '../../utils/mcdata.js';
import {
    readSchematic,
    toConstruction,
    materialList,
    blockBaseName,
    SUPPORTED_EXTENSIONS,
} from '../../utils/schematic.js';

const BINARY_EXTENSIONS = ['.litematic', '.schem', '.nbt'];
const BUILTIN_DIR = path.join('src', 'agent', 'npc', 'construction');

export function libraryDirs() {
    const dirs = [BUILTIN_DIR];
    const userDir = settings.schematic_library || 'schematics';
    if (!dirs.includes(userDir)) dirs.push(userDir);
    return dirs;
}

export function userLibraryDir() {
    return settings.schematic_library || 'schematics';
}

/**
 * Make sure the user library folder exists and seed it with a README so the
 * feature is discoverable. Safe to call repeatedly.
 */
export function ensureUserLibrary() {
    const dir = userLibraryDir();
    try {
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
            const readme = [
                '# Schematic build library',
                '',
                'Drop building files here and the bot can browse and build them.',
                '',
                'Supported formats:',
                '- `.litematic` — Litematica mod schematics',
                '- `.schem`     — Sponge / WorldEdit schematics (also what Baritone builds)',
                '- `.nbt`       — vanilla structure block templates',
                '- `.json`      — mindcraft blueprint format',
                '',
                'In game, the bot can:',
                '- list everything here with `!listBuilds`',
                '- quote a material list with `!buildMaterials <name>`',
                '- build one with `!buildSchematic <name>` (optionally followed by x y z and a rotation 0-3)',
                '',
                'The classic MCEdit `.schematic` format (numeric pre-1.13 block ids) is not',
                'supported; re-save it as `.schem` or `.litematic` first.',
                '',
            ].join('\n');
            fs.writeFileSync(path.join(dir, 'README.md'), readme);
        }
    } catch (e) {
        console.warn(`[schematics] Could not initialize library folder "${dir}": ${e.message}`);
    }
}

function listFiles(dir) {
    try {
        return fs.readdirSync(dir).filter((f) => {
            const ext = path.extname(f).toLowerCase();
            return SUPPORTED_EXTENSIONS.includes(ext);
        });
    } catch {
        return [];
    }
}

class SchematicLibrary {
    constructor() {
        // key (filename without ext) -> entry descriptor
        this.entries = new Map();
        // cache key -> { mtimeMs, parsed | construction }
        this._cache = new Map();
    }

    /** Scan both library folders. User files override built-in names. */
    scan() {
        ensureUserLibrary();
        this.entries.clear();
        for (const dir of libraryDirs()) {
            for (const file of listFiles(dir)) {
                const ext = path.extname(file).toLowerCase();
                const key = file.slice(0, -ext.length);
                const stat = fs.statSync(path.join(dir, file));
                this.entries.set(key, {
                    key,
                    file,
                    dir,
                    path: path.join(dir, file),
                    ext,
                    format: ext === '.json' ? 'blueprint' : ext.slice(1),
                    mtimeMs: stat.mtimeMs,
                    sizeBytes: stat.size,
                });
            }
        }
        return [...this.entries.keys()].sort();
    }

    /** Resolve a user-supplied name, tolerating extension or case differences. */
    resolve(name) {
        if (this.entries.size === 0) this.scan();
        if (name == null) return null;
        let key = String(name).trim();
        for (const ext of SUPPORTED_EXTENSIONS) {
            if (key.toLowerCase().endsWith(ext)) key = key.slice(0, -ext.length);
        }
        if (this.entries.has(key)) return this.entries.get(key);
        const lower = key.toLowerCase();
        for (const [k, entry] of this.entries) {
            if (k.toLowerCase() === lower) return entry;
        }
        for (const [k, entry] of this.entries) {
            if (k.toLowerCase().includes(lower)) return entry;
        }
        return null;
    }

    async _loadParsed(entry) {
        const cached = this._cache.get(entry.key);
        if (cached && cached.mtimeMs === entry.mtimeMs && cached.parsed) return cached.parsed;
        const parsed = await readSchematic(fs.readFileSync(entry.path), entry.file);
        parsed.name = entry.key;
        this._cache.set(entry.key, { mtimeMs: entry.mtimeMs, parsed });
        return parsed;
    }

    _loadBlueprint(entry) {
        const cached = this._cache.get(entry.key);
        if (cached && cached.mtimeMs === entry.mtimeMs && cached.construction) return cached.construction;
        const construction = JSON.parse(fs.readFileSync(entry.path, 'utf8'));
        if (!construction.blocks || !Array.isArray(construction.blocks)) {
            throw new Error(`Blueprint ${entry.file} is missing a "blocks" 3D array`);
        }
        if (construction.offset == null) construction.offset = 0;
        padBlueprint(construction);
        this._cache.set(entry.key, { mtimeMs: entry.mtimeMs, construction });
        return construction;
    }

    /** Parsed SchematicModel for binary formats (null for .json blueprints). */
    async getSchematic(name) {
        const entry = this.resolve(name);
        if (!entry) return null;
        if (entry.ext === '.json') return null;
        return await this._loadParsed(entry);
    }

    /**
     * Return a mindcraft construction blueprint for any library entry.
     * When `bot` is given, block names are validated against the connected
     * Minecraft version and unknown/unplaceable blocks are skipped + reported.
     */
    async getConstruction(name, bot = null) {
        const entry = this.resolve(name);
        if (!entry) return null;
        if (entry.ext === '.json') {
            return { construction: this._loadBlueprint(entry), skipped: {}, unknown: {}, entry };
        }
        const schematic = await this._loadParsed(entry);
        const resolver = bot && bot.registry ? (blockName) => this._blockExistsInVersion(bot, blockName) : null;
        const { construction, skipped, unknown } = toConstruction(schematic, {
            name: entry.key,
            resolve: resolver,
        });
        return { construction, skipped, unknown, entry, schematic };
    }

    _blockExistsInVersion(bot, blockName) {
        // Blocks must exist in this world version and be obtainable; a few
        // liquid/special blocks are placed from buckets or interactions.
        const placeableExceptions = new Set(['water', 'lava', 'powder_snow']);
        if (placeableExceptions.has(blockName)) return true;
        if (mc.getBlockId(blockName) == null && mc.getItemId(blockName) == null) return false;
        return true;
    }

    /** Metadata + materials for every library entry (binary files parsed lazily). */
    async describeAll() {
        if (this.entries.size === 0) this.scan();
        const out = [];
        for (const entry of this.entries.values()) {
            out.push(await this.describe(entry.key));
        }
        return out;
    }

    async describe(name) {
        const entry = this.resolve(name);
        if (!entry) return null;
        if (entry.ext === '.json') {
            const construction = this._loadBlueprint(entry);
            const counts = {};
            let total = 0;
            for (const layer of construction.blocks) {
                for (const row of layer) {
                    for (const cell of row) {
                        if (cell && cell !== 'air' && cell !== '') {
                            counts[cell] = (counts[cell] || 0) + 1;
                            total++;
                        }
                    }
                }
            }
            const height = construction.blocks.length;
            const length = construction.blocks[0].length;
            const width = construction.blocks[0][0].length;
            return {
                name: entry.key, format: 'blueprint', file: entry.file,
                width, height, length, total,
                materials: counts, skipped: {}, unknown: {},
            };
        }
        const schematic = await this._loadParsed(entry);
        const { materials, skipped } = materialList(schematic);
        let total = 0;
        for (const n of Object.values(materials)) total += n;
        return {
            name: entry.key,
            format: schematic.format,
            file: entry.file,
            width: schematic.width,
            height: schematic.height,
            length: schematic.length,
            total,
            materials,
            skipped,
            unknown: {},
            author: schematic.author,
            description: schematic.description,
        };
    }
}

/**
 * Guarantee a rectangular blocks[y][z][x] prism by padding ragged rows with '',
 * matching the normalization the NPC controller applies to built-in blueprints.
 */
export function padBlueprint(construction) {
    const blocks = construction.blocks;
    const sizez = blocks[0].length;
    const sizex = blocks[0][0].length;
    const max = Math.max(sizex, sizez);
    for (let y = 0; y < blocks.length; y++) {
        for (let z = 0; z < max; z++) {
            if (z >= blocks[y].length) blocks[y].push([]);
            for (let x = blocks[y][z].length; x < max; x++) blocks[y][z].push('');
        }
    }
    return construction;
}

// Single shared instance; scans are cheap and caches survive across calls.
export const library = new SchematicLibrary();

export function formatMaterialCounts(materials, limit = 12) {
    const entries = Object.entries(materials).sort((a, b) => b[1] - a[1]);
    const head = entries.slice(0, limit).map(([name, n]) => `${name} x${n}`).join(', ');
    const more = entries.length > limit ? `, +${entries.length - limit} more (use !buildMaterials)` : '';
    return head + more;
}

export { blockBaseName };
