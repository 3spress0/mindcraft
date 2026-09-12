import fs from 'fs';
import path from 'path';
import { minimatch } from 'minimatch';

//LS Tool - Lists directory contents with detailed metadata
export class LSTool {
    static description = 'List files and directories in a path with detailed metadata';
    static inputSchema = {
        type: "object",
        properties: {
            path: { 
                type: "string", 
                description: "Absolute path to the directory to list" 
            },
            ignore: { 
                type: "array", 
                description: "Array of glob patterns to ignore",
                items: { type: "string" }
            }
        },
        required: ["path"]
    };

    constructor(agent = null) {
        this.name = 'LS';
        this.agent = agent;
    }

    /**
     * Execute the ls operation
     * @param {Object} params - The ls parameters
     * @param {string} params.path - Absolute path to the directory
     * @param {Array} params.ignore - Array of glob patterns to ignore
     * @returns {Object} Result object
     */
    async execute(params) {
        try {
            const { path: dirPath, ignore = [] } = params;

            if (!dirPath) {
                throw new Error('Missing required parameter: path');
            }
            if (!fs.existsSync(dirPath)) {
                throw new Error(`Directory does not exist: ${dirPath}`);
            }

            const stats = fs.statSync(dirPath);
            if (!stats.isDirectory()) {
                throw new Error(`Path is not a directory: ${dirPath}`);
            }
            const entries = fs.readdirSync(dirPath);
            const results = [];

            for (const entry of entries) {
                const fullPath = path.join(dirPath, entry);
                
                if (this.shouldIgnore(entry, ignore)) {
                    continue;
                }

                try {
                    const entryStats = fs.statSync(fullPath);
                    const isDirectory = entryStats.isDirectory();
                    
                    let size;
                    if (isDirectory) {
                        size = this.countDirectoryItems(fullPath);
                    } else {
                        size = entryStats.size;
                    }

                    results.push({
                        name: entry,
                        path: fullPath,
                        relativePath: entry,
                        type: isDirectory ? 'directory' : 'file',
                        size,
                        modified: entryStats.mtime,
                        permissions: this.getPermissions(entryStats.mode)
                    });
                } catch (error) {
                    continue;
                }
            }

            results.sort((a, b) => {
                if (a.type !== b.type) {
                    return a.type === 'directory' ? -1 : 1;
                }
                return a.name.localeCompare(b.name);
            });

            return {
                success: true,
                message: `Listed ${results.length} items in ${path.basename(dirPath)}`,
                path: dirPath,
                totalItems: results.length,
                directories: results.filter(item => item.type === 'directory').length,
                files: results.filter(item => item.type === 'file').length,
                items: results
            };

        } catch (error) {
            return {
                success: false,
                message: `## List Tool Error ##\n**Error:** ${error.message}`
            };
        }
    }

    shouldIgnore(entry, ignorePatterns) {
        for (const pattern of ignorePatterns) {
            if (minimatch(entry, pattern)) {
                return true;
            }
        }
        return false;
    }

    countDirectoryItems(dirPath) {
        try {
            const entries = fs.readdirSync(dirPath);
            let count = entries.length;
            
            for (const entry of entries) {
                const fullPath = path.join(dirPath, entry);
                try {
                    const stats = fs.statSync(fullPath);
                    if (stats.isDirectory()) {
                        count += this.countDirectoryItems(fullPath);
                    }
                } catch (error) {
                    continue;
                }
            }
            
            return count;
        } catch (error) {
            return 0;
        }
    }

    getPermissions(mode) {
        const permissions = [];
        
        permissions.push((mode & 0o400) ? 'r' : '-');
        permissions.push((mode & 0o200) ? 'w' : '-');
        permissions.push((mode & 0o100) ? 'x' : '-');
        
        permissions.push((mode & 0o040) ? 'r' : '-');
        permissions.push((mode & 0o020) ? 'w' : '-');
        permissions.push((mode & 0o010) ? 'x' : '-');
        
        permissions.push((mode & 0o004) ? 'r' : '-');
        permissions.push((mode & 0o002) ? 'w' : '-');
        permissions.push((mode & 0o001) ? 'x' : '-');
        
        return permissions.join('');
    }
}

export default LSTool;
