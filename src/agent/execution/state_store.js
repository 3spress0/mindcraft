import fs from 'fs/promises';
import path from 'path';

/** Minimal crash-safe task snapshot store. */
export class FileExecutionStateStore {
    constructor(botName, root = path.resolve('bots')) {
        this.file = path.join(root, botName, 'execution_state.json');
    }

    async save(snapshot) {
        await fs.mkdir(path.dirname(this.file), { recursive: true });
        const temporary = `${this.file}.tmp-${process.pid}`;
        await fs.writeFile(temporary, JSON.stringify({ version: 1, savedAt: Date.now(), ...snapshot }, null, 2));
        await fs.rename(temporary, this.file);
    }

    async load() {
        try { return JSON.parse(await fs.readFile(this.file, 'utf8')); } catch { return null; }
    }

    async clear() {
        try { await fs.unlink(this.file); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
}
