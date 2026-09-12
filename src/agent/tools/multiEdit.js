import fs from 'fs';
import path from 'path';
import { EditTool } from './edit.js';

/**
 * MultiEdit Tool - Performs multiple edits on a single file in one atomic operation
 */
export class MultiEditTool {
    static description = 'Perform multiple edits on a single file in one atomic operation';
    static inputSchema = {
        type: "object",
        properties: {
            file_path: { 
                type: "string", 
                description: "Absolute path to the file to edit" 
            },
            edits: {
                type: "array",
                description: "Array of edit operations to perform sequentially",
                items: {
                    type: "object",
                    properties: {
                        old_string: { type: "string", description: "Text to replace" },
                        new_string: { type: "string", description: "Replacement text" },
                        replace_all: { type: "boolean", description: "Replace all occurrences" }
                    },
                    required: ["old_string", "new_string"]
                }
            }
        },
        required: ["file_path", "edits"]
    };

    constructor(agent = null) {
        this.name = 'MultiEdit';
        this.agent = agent;
        this.editTool = new EditTool();
    }

    /**
     * Execute multiple edits atomically on a single file
     * @param {Object} params - The edit parameters
     * @param {string} params.file_path - Absolute path to the file
     * @param {Array} params.edits - Array of edit operations
     * @returns {Object} Result object
     */
    async execute(params) {
        try {
            const { file_path, edits } = params;

            if (!file_path || !edits || !Array.isArray(edits) || edits.length === 0) {
                throw new Error('[MultiEdit Tool] Missing required parameters: file_path and edits array');
            }

            if (!fs.existsSync(file_path)) {
                throw new Error(`[MultiEdit Tool] File does not exist: ${file_path}`);
            }
            for (let i = 0; i < edits.length; i++) {
                const edit = edits[i];
                if (!edit.old_string || edit.new_string === undefined) {
                    throw new Error(`[MultiEdit Tool] Edit ${i + 1}: Missing required parameters old_string or new_string`);
                }
                if (edit.old_string === edit.new_string) {
                    throw new Error(`[MultiEdit Tool] Edit ${i + 1}: old_string and new_string must be different`);
                }
            }

            let content = fs.readFileSync(file_path, 'utf8');
            const originalContent = content;
            const results = [];
            for (let i = 0; i < edits.length; i++) {
                const edit = edits[i];
                const { old_string, new_string, replace_all = false } = edit;

                if (!content.includes(old_string)) {
                    throw new Error(`[MultiEdit Tool] Edit ${i + 1}: String not found in file: "${old_string}"`);
                }
                const escapedOld = old_string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                if (!replace_all) {
                    const occurrences = (content.match(new RegExp(escapedOld, 'g')) || []).length;
                    if (occurrences > 1) {
                        throw new Error(`[MultiEdit Tool] Edit ${i + 1}: String "${old_string}" appears ${occurrences} times. Use replace_all=true or provide more context to make it unique`);
                    }
                }

                const beforeLength = content.length;
                if (replace_all) {
                    content = content.replaceAll(old_string, new_string);
                } else {
                    content = content.replace(old_string, new_string);
                }

                const replacements = replace_all 
                    ? (originalContent.match(new RegExp(escapedOld, 'g')) || []).length
                    : 1;

                results.push({
                    edit: i + 1,
                    old_string: old_string.substring(0, 50) + (old_string.length > 50 ? '...' : ''),
                    new_string: new_string.substring(0, 50) + (new_string.length > 50 ? '...' : ''),
                    replacements,
                    success: true
                });
            }

            fs.writeFileSync(file_path, content, 'utf8');

            const totalReplacements = results.reduce((sum, result) => sum + result.replacements, 0);

            return {
                success: true,
                message: `Successfully applied ${edits.length} edits with ${totalReplacements} total replacements in ${path.basename(file_path)}`,
                file_path,
                edits_applied: edits.length,
                total_replacements: totalReplacements,
                results
            };

        } catch (error) {
            return {
                success: false,
                message: `## MultiEdit Tool Error ##\n**Error:** ${error.message}`,
                file_path: params.file_path
            };
        }
    }
}

export default MultiEditTool;
