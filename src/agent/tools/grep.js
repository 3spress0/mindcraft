import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import process from 'process';

//Grep Tool - Powerful regex-based content searching using ripgrep
export class GrepTool {
    static description = 'Search for text content within files using regex patterns';
    static inputSchema = {
        type: "object",
        properties: {
            query: { 
                type: "string", 
                description: "Search query or regex pattern" 
            },
            path: { 
                type: "string", 
                description: "Directory or file to search in" 
            },
            is_regex: { 
                type: "boolean", 
                description: "Treat query as regex pattern (default: false)" 
            }
        },
        required: ["query", "path"]
    };

    constructor(agent = null) {
        this.name = 'Grep';
        this.agent = agent;
    }

    /**
     * Execute the grep search
     * @param {Object} params - The grep parameters
     * @returns {Object} Result object
     */
    async execute(params) {
        try {
            const {
                query: pattern, // inputSchema exposes this as "query"; keep "pattern" internally below
                path: searchPath = process.cwd(),
                glob: globPattern,
                output_mode = 'files_with_matches',
                type,
                head_limit,
                multiline = false,
                '-B': beforeContext,
                '-A': afterContext,
                '-C': context,
                '-n': showLineNumbers = false,
                '-i': caseInsensitive = false
            } = params;

            if (!pattern) {
                throw new Error('Missing required parameter: pattern');
            }

            if (!fs.existsSync(searchPath)) {
                throw new Error(`Path does not exist: ${searchPath}`);
            }

            const args = [];

            args.push(pattern);

            if (caseInsensitive) {
                args.push('-i');
            }
            if (multiline) {
                args.push('-U', '--multiline-dotall');
            }

            switch (output_mode) {
                case 'files_with_matches':
                    args.push('-l');
                    break;
                case 'count':
                    args.push('-c');
                    break;
                case 'content':
                    if (showLineNumbers) {
                        args.push('-n');
                    }
                    if (context !== undefined) {
                        args.push('-C', context.toString());
                    } else {
                        if (beforeContext !== undefined) {
                            args.push('-B', beforeContext.toString());
                        }
                        if (afterContext !== undefined) {
                            args.push('-A', afterContext.toString());
                        }
                    }
                    break;
            }

            if (type) {
                args.push('--type', type);
            }
            if (globPattern) {
                args.push('--glob', globPattern);
            }

            args.push(searchPath);

            const result = await this.executeRipgrep(args);

            let output = result.stdout;

            if (head_limit && output) {
                const lines = output.split('\n');
                output = lines.slice(0, head_limit).join('\n');
            }

            const matches = output ? output.split('\n').filter(line => line.trim()).length : 0;

            return {
                success: true,
                message: `Found ${matches} matches for pattern "${pattern}"`,
                pattern,
                searchPath,
                output_mode,
                matches,
                output: output || 'No matches found'
            };

        } catch (error) {
            return {
                success: false,
                message: `## Grep Tool Error ##\n**Error:** ${error.message}`
            };
        }
    }

    executeRipgrep(args) {
        return new Promise((resolve, reject) => {
            const rg = spawn('rg', args, {
                stdio: ['pipe', 'pipe', 'pipe']
            });

            let stdout = '';
            let stderr = '';

            rg.stdout.on('data', (data) => {
                stdout += data.toString();
            });

            rg.stderr.on('data', (data) => {
                stderr += data.toString();
            });

            rg.on('close', (code) => {
                // ripgrep returns 1 when no matches found, which is not an error
                if (code === 0 || code === 1) {
                    resolve({ stdout, stderr, code });
                } else {
                    reject(new Error(`ripgrep failed with code ${code}: ${stderr}`));
                }
            });

            rg.on('error', (error) => {
                if (error.code === 'ENOENT') {
                    reject(new Error('ripgrep (rg) is not installed. Please install ripgrep first.'));
                } else {
                    reject(error);
                }
            });
        });
    }
}

export default GrepTool;
