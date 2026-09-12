import fs from 'fs';
import path from 'path';

//Edit Tool - Performs exact string replacements in files
export class EditTool {
    static description = 'Edit existing file by replacing old_string with new_string';
    static inputSchema = {
        type: "object",
        properties: {
            file_path: { 
                type: "string", 
                description: "Absolute path to the file to edit" 
            },
            old_string: { 
                type: "string", 
                description: "The exact text to replace" 
            },
            new_string: { 
                type: "string", 
                description: "The new text to replace with" 
            },
            replace_all: { 
                type: "boolean", 
                description: "Replace all occurrences (default: false)" 
            }
        },
        required: ["file_path", "old_string", "new_string"]
    };

    constructor(agent = null) {
        this.name = 'Edit';
        this.agent = agent;
    }
 
    /**
     * Execute the edit operation
     * @param {Object} params - The edit parameters
     * @param {string} params.file_path - Absolute path to the file
     * @param {string} params.old_string - Text to replace
     * @param {string} params.new_string - Replacement text
     * @param {boolean} params.replace_all - Replace all occurrences
     * @returns {Object} Result object
     */
    async execute(params) {
        try {
            const { file_path, old_string, new_string, replace_all = false } = params;

            if (!file_path || !old_string || new_string === undefined) {
                throw new Error('[Edit Tool] Missing required parameters: file_path, old_string, new_string');
            }

            // Validate old_string and new_string are different
            if (old_string === new_string) {
                throw new Error('[Edit Tool] old_string and new_string must be different');
            }
            if (!fs.existsSync(file_path)) {
                throw new Error(`[Edit Tool] File does not exist: ${file_path}`);
            }
            const content = fs.readFileSync(file_path, 'utf8');
            const escapedOld = old_string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            if (!content.includes(old_string)) {
                throw new Error(`[Edit Tool] String not found in file: "${old_string}"`);
            }
            if (!replace_all) {
                const occurrences = (content.match(new RegExp(escapedOld, 'g')) || []).length;
                if (occurrences > 1) {
                    throw new Error(`[Edit Tool] String "${old_string}" appears ${occurrences} times. Use replace_all=true or provide more context to make it unique`);
                }
            }

            // Perform replacement
            let newContent;
            if (replace_all) {
                newContent = content.replaceAll(old_string, new_string);
            } else {
                newContent = content.replace(old_string, new_string);
            }

            // Write back to file
            fs.writeFileSync(file_path, newContent, 'utf8');
            const replacements = replace_all 
                ? (content.match(new RegExp(escapedOld, 'g')) || []).length
                : 1;
            return {
                success: true,
                message: `Successfully replaced ${replacements} occurrence(s) in ${path.basename(file_path)}`,
                replacements,
                file_path
            };
        } catch (error) {
            return {
                success: false,
                message: `## Edit Tool Error ##\n**Error:** ${error.message}`,
                file_path: params.file_path
            };
        }
    }
}

export default EditTool;
