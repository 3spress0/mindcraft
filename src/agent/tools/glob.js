import fs from 'fs';
import path from 'path';
import process from 'process';
import { glob } from 'glob';

/**
 * Glob Tool - Fast file pattern matching using glob syntax
 */
export class GlobTool {
    static description = 'Search for files matching a glob pattern';
    static inputSchema = {
        type: "object",
        properties: {
            pattern: { 
                type: "string", 
                description: "Glob pattern to match files (e.g., '**/*.js')" 
            },
            path: { 
                type: "string", 
                description: "Directory to search in (optional)" 
            }
        },
        required: ["pattern"]
    };

    constructor(agent = null) {
        this.name = 'Glob';
        this.agent = agent;
    }
    

    /**
     * Execute the glob search
     * @param {Object} params - The glob parameters
     * @param {string} params.pattern - The glob pattern to match files against
     * @param {string} params.path - The directory to search in (optional)
     * @returns {Object} Result object
     */
    async execute(params) {
        try {
            const { pattern, path: searchPath } = params;

            if (!pattern) {
                throw new Error('Missing required parameter: pattern');
            }

            const cwd = searchPath || process.cwd();

            if (!fs.existsSync(cwd)) {
                throw new Error(`Directory does not exist: ${cwd}`);
            }

            const matches = await glob(pattern, {
                cwd,
                absolute: true,
                dot: false, // Don't match hidden files by default
                ignore: ['node_modules/**', '.git/**', '**/.DS_Store'] // Common ignore patterns
            });

            const filesWithStats = await Promise.all(
                matches.map(async (filePath) => {
                    try {
                        const stats = fs.statSync(filePath);
                        return {
                            path: filePath,
                            relativePath: path.relative(cwd, filePath),
                            size: stats.size,
                            modified: stats.mtime,
                            isDirectory: stats.isDirectory()
                        };
                    } catch (error) {
                        return null;
                    }
                })
            );

            const sortedFiles = filesWithStats
                .filter(file => file !== null)
                .sort((a, b) => b.modified - a.modified);

            return {
                success: true,
                message: `Found ${sortedFiles.length} matches for pattern "${pattern}"`,
                pattern,
                searchPath: cwd,
                matches: sortedFiles.length,
                files: sortedFiles
            };

        } catch (error) {
            return {
                success: false,
                message: `## Glob Tool Error ##\n**Error:** ${error.message}`
            };
        }
    }
}

export default GlobTool;
