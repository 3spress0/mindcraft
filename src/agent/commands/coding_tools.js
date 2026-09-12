import settings from '../settings.js';

/**
 * Bridges the standalone coding-agent tool suite (Coder.codeToolsManager, a ToolManager
 * instance backed by src/agent/tools/*.js) onto ultimate's existing !command / native
 * function-calling pipeline (commands/index.js -> commands/tool_adapter.js).
 *
 * Each entry below is a normal command object -- tool_adapter.js already knows how to turn
 * commandList entries into native tool-call schemas, so these tools get exposed to
 * function-calling models for free, with no changes to tool_adapter.js required.
 *
 * Complex/nested parameters (arrays, objects) are passed as JSON-encoded strings since the
 * existing param-type system (see TYPE_MAP in tool_adapter.js) only maps to JSON-schema
 * primitives. They are parsed back into real arrays/objects before reaching the underlying
 * Tool classes.
 */

function jsonParam(raw, fallback) {
    if (raw === undefined || raw === null || raw === '') return fallback;
    if (typeof raw !== 'string') return raw; // already an object/array
    try {
        return JSON.parse(raw);
    } catch (e) {
        throw new Error(`Invalid JSON for parameter: ${e.message}`);
    }
}

function toolsEnabled(agent) {
    return !!settings.allow_agent_coding_tools && !!agent?.coder?.codeToolsManager;
}

function disabledMessage(name) {
    return `${name} is disabled. Enable with allow_agent_coding_tools=true in settings.js`;
}

async function runTool(agent, toolName, params) {
    if (!toolsEnabled(agent)) return disabledMessage(`!${toolName.charAt(0).toLowerCase() + toolName.slice(1)}`);
    const result = await agent.coder.codeToolsManager.executeTool({ tool: toolName, params });
    return result?.message || (result?.success === false ? `${toolName} failed: ${result?.error || 'unknown error'}` : JSON.stringify(result));
}

export const codingToolsList = [
    {
        name: '!read',
        description: 'Read the contents of a file from an allowed code workspace.',
        params: {
            'file_path': { type: 'string', description: 'Absolute path to the file to read.' },
            'offset': { type: 'int', description: '1-indexed line number to start reading from.', optional: true },
            'limit': { type: 'int', description: 'Number of lines to read.', optional: true }
        },
        perform: async function (agent, file_path, offset, limit) {
            return await runTool(agent, 'Read', { file_path, offset, limit });
        }
    },
    {
        name: '!write',
        description: 'Write or overwrite a file at the given path inside an allowed code workspace.',
        params: {
            'file_path': { type: 'string', description: 'Absolute path to the file.' },
            'content': { type: 'string', description: 'Content to write to the file.' }
        },
        perform: async function (agent, file_path, content) {
            return await runTool(agent, 'Write', { file_path, content });
        }
    },
    {
        name: '!edit',
        description: 'Edit an existing file by replacing an exact string match.',
        params: {
            'file_path': { type: 'string', description: 'Absolute path to the file to edit.' },
            'old_string': { type: 'string', description: 'The exact text to replace.' },
            'new_string': { type: 'string', description: 'The new text to replace it with.' },
            'replace_all': { type: 'boolean', description: 'Replace all occurrences instead of just the first.', optional: true }
        },
        perform: async function (agent, file_path, old_string, new_string, replace_all) {
            return await runTool(agent, 'Edit', { file_path, old_string, new_string, replace_all });
        }
    },
    {
        name: '!multiEdit',
        description: 'Perform several string-replacement edits on one file atomically.',
        params: {
            'file_path': { type: 'string', description: 'Absolute path to the file to edit.' },
            'edits': { type: 'string', description: 'JSON array of {old_string, new_string, replace_all?} objects, applied in order.' }
        },
        perform: async function (agent, file_path, edits) {
            return await runTool(agent, 'MultiEdit', { file_path, edits: jsonParam(edits, []) });
        }
    },
    {
        name: '!grep',
        description: 'Search file contents for a text or regex pattern.',
        params: {
            'query': { type: 'string', description: 'Search query or regex pattern.' },
            'path': { type: 'string', description: 'Directory or file to search in.' },
            'is_regex': { type: 'boolean', description: 'Treat query as a regex pattern.', optional: true }
        },
        perform: async function (agent, query, path, is_regex) {
            return await runTool(agent, 'Grep', { query, path, is_regex });
        }
    },
    {
        name: '!glob',
        description: 'Find files matching a glob pattern.',
        params: {
            'pattern': { type: 'string', description: "Glob pattern to match files, e.g. '**/*.js'." },
            'path': { type: 'string', description: 'Directory to search in.', optional: true }
        },
        perform: async function (agent, pattern, path) {
            return await runTool(agent, 'Glob', { pattern, path });
        }
    },
    {
        name: '!ls',
        description: 'List files and directories at a path with metadata.',
        params: {
            'path': { type: 'string', description: 'Absolute path to the directory to list.' },
            'ignore': { type: 'string', description: 'JSON array of glob patterns to ignore.', optional: true }
        },
        perform: async function (agent, path, ignore) {
            return await runTool(agent, 'LS', { path, ignore: jsonParam(ignore, []) });
        }
    },
    {
        name: '!execute',
        description: 'Execute a JavaScript IIFE file, e.g. (async (bot) => { ... }), in the bot environment with full skills/world API access. Same risk class as newAction: requires allow_insecure_coding.',
        params: {
            'file_path': { type: 'string', description: 'Absolute path to the JavaScript file to execute.' },
            'description': { type: 'string', description: 'Description of what this code does.', optional: true }
        },
        perform: async function (agent, file_path, description) {
            if (!settings.allow_insecure_coding) {
                return 'execute is disabled. Enable with allow_insecure_coding=true in settings.js';
            }
            return await runTool(agent, 'Execute', { file_path, description });
        }
    },
    {
        name: '!lint',
        description: 'Validate a JavaScript file for syntax errors and unknown skill/world/learnedSkills calls, without executing it.',
        params: {
            'file_path': { type: 'string', description: 'Absolute path to the JavaScript file to validate.' }
        },
        perform: async function (agent, file_path) {
            return await runTool(agent, 'Lint', { file_path });
        }
    },
    {
        name: '!todoWrite',
        description: 'Create or update the coding-session TODO list.',
        params: {
            'todos': { type: 'string', description: 'JSON array of {content, status, id} objects. status is one of pending, in_progress, completed.' }
        },
        perform: async function (agent, todos) {
            return await runTool(agent, 'TodoWrite', { todos: jsonParam(todos, []) });
        }
    },
    {
        name: '!finishCoding',
        description: 'Finish the current coding session and return a summary to the main agent.',
        params: {
            'summary': { type: 'string', description: 'Comprehensive summary of what was accomplished during the coding session.' }
        },
        perform: async function (agent, summary) {
            return await runTool(agent, 'FinishCoding', { summary });
        }
    }
];
