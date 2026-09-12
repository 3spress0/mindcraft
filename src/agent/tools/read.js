import fs from 'fs';
import path from 'path';

export class ReadTool {
    static description = 'Read and display the contents of a file';
    static inputSchema = {
        type: "object",
        properties: {
            file_path: { 
                type: "string", 
                description: "Absolute path to the file to read" 
            },
            offset: { 
                type: "number", 
                description: "Line number to start reading from (1-indexed, optional)" 
            },
            limit: { 
                type: "number", 
                description: "Number of lines to read (optional)" 
            }
        },
        required: ["file_path"]
    };

    constructor(agent = null) {
        this.name = 'Read';
        this.agent = agent;
    }

    /**
     * Execute the read operation
     * @param {Object} params - The read parameters
     * @param {string} params.file_path - Absolute path to the file
     * @param {number} params.offset - Line offset to start reading from (1-indexed)
     * @param {number} params.limit - Number of lines to read
     * @returns {Object} Result object
     */
    async execute(params) {
        try {
            const { file_path, offset, limit } = params;

            if (!file_path) {
                throw new Error('[Read Tool] Missing required parameter: file_path');
            }
            if (!fs.existsSync(file_path)) {
                throw new Error(`[Read Tool] File does not exist: ${file_path}`);
            }
            const stats = fs.statSync(file_path);
            if (!stats.isFile()) {
                throw new Error(`[Read Tool] Path is not a file: ${file_path}`);
            }
            const content = fs.readFileSync(file_path, 'utf8');
            const lines = content.split('\n');

            let displayLines = lines;
            let startLine = 1;
            let endLine = lines.length;

            if (offset !== undefined) {
                startLine = Math.max(1, offset);
                displayLines = lines.slice(startLine - 1);
            }

            if (limit !== undefined) {
                displayLines = displayLines.slice(0, limit);
                endLine = Math.min(startLine + limit - 1, lines.length);
            } else if (offset !== undefined) {
                endLine = lines.length;
            }

            const formattedContent = displayLines
                .map((line, index) => {
                    const lineNumber = startLine + index;
                    return `     ${lineNumber}→${line}`;
                })
                .join('\n');


            const truncated = offset !== undefined || limit !== undefined;
            const fullLength = lines.length;

            const fileName = path.basename(file_path);
            const sizeInfo = `${stats.size} bytes`;
            const lineInfo = truncated ? 
                `lines ${startLine}-${endLine} of ${fullLength}` : 
                `${fullLength} lines`;
            
            const message = `<file name="${fileName}" ${truncated ? `start_line="${startLine}" end_line="${endLine}" ` : ''}full_length="${fullLength}">\n${formattedContent}\n</file>`;

            return {
                success: true,
                message: message,
                file_path,
                size: stats.size,
                start_line: startLine,
                end_line: endLine,
                full_length: fullLength,
                truncated,
                content: formattedContent
            };

        } catch (error) {
            return {
                success: false,
                message: `## Read Tool Error ##\n**Error:** ${error.message}`
            };
        }
    }
}

export default ReadTool;
