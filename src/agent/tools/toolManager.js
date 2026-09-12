import { EditTool } from './edit.js';
import { MultiEditTool } from './multiEdit.js';
import { WriteTool } from './write.js';
import { GlobTool } from './glob.js';
import { GrepTool } from './grep.js';
import { LSTool } from './ls.js';
import { ReadTool } from './read.js';
import { ExecuteTool } from './execute.js';
import { LintTool } from './lint.js';
import { TodoWriteTool } from './todoWrite.js';
import { FinishCodingTool } from './finishCoding.js';
import fs from 'fs';
import path from 'path';

const TOOL_CLASSES = [
    ['Edit', EditTool], ['MultiEdit', MultiEditTool], ['Write', WriteTool],
    ['Execute', ExecuteTool], ['Lint', LintTool], ['Glob', GlobTool],
    ['Grep', GrepTool], ['LS', LSTool], ['Read', ReadTool], ['TodoWrite', TodoWriteTool],
    ['FinishCoding', FinishCodingTool]
];
const REMINDER_THRESHOLD = 60000; 

//Tool Manager - Manages all available tools and executes Tools with workspace validation
export class ToolManager {
    constructor(agent = null) {
        this.agent = agent;
        this.tools = new Map();
        this.workspaces = [];
        this.promptCache = null;
        this.promptCacheTime = 0;
        
        this.initializeTools();
        this.initializeWorkspaces();
    }

    initializeTools() {
        for (const [name, ToolClass] of TOOL_CLASSES) {
            const tool = new ToolClass(this.agent);
            this.tools.set(name, tool);
        }
    }

    initializeWorkspaces() {
        if (!this.agent?.name) {
            this.workspaces = [];
            return;
        }

        if (this.agent.code_workspaces && Array.isArray(this.agent.code_workspaces)) {
            this.workspaces = this.agent.code_workspaces
                .map(ws => ws.replace('{BOT_NAME}', this.agent.name))
                .map(ws => ws.startsWith('/') ? ws.substring(1) : ws); // Remove leading slash for internal processing
        } else {
            console.error(`${COLORS.brightRed}SECURITY: No code_workspaces configured for bot ${this.agent.name}. File operations will be blocked.${COLORS.reset}`);
            this.workspaces = []; 
        }
    }


    async executeTool(Tool) {
        const startTime = Date.now();
        const { tool: toolName, params = {} } = Tool;

        if (!toolName) {
            return this.createErrorResult('unknown', 'Missing tool name in Tool', startTime);
        }

        const toolInstance = this.tools.get(toolName);
        if (!toolInstance) {
            const availableTools = Array.from(this.tools.keys()).join(', ');
            return this.createErrorResult(toolName, `Unknown tool: ${toolName}. Available: ${availableTools}`, startTime);
        }

        try {
            console.log(`${COLORS.brightBlue}[ToolManager]${COLORS.reset} Executing ${COLORS.brightYellow}${toolName}${COLORS.reset} tool...`);
            const result = await toolInstance.execute(params);
            
            if (result.success !== false)
                console.log(`${COLORS.brightGreen}✓ [ToolManager]${COLORS.reset} ${COLORS.brightYellow}${toolName}${COLORS.reset} executed successfully`);
            else 
                console.log(`${COLORS.brightRed}✗ [ToolManager]${COLORS.reset} ${COLORS.brightYellow}${toolName}${COLORS.reset} execution failed: ${result.error || result.message}`);
            
            return { tool: toolName, timestamp: new Date().toISOString(), ...result };
        } catch (error) {
            console.log(`${COLORS.brightRed}✗ [ToolManager]${COLORS.reset} ${COLORS.brightYellow}${toolName || 'unknown'}${COLORS.reset} execution error: ${error.message}`);
            return this.createErrorResult(toolName, error.message, startTime);
        }
    }
    
    createErrorResult(tool, message, startTime) {
        return {
            tool,
            timestamp: new Date().toISOString(),
            success: false,
            error: message
        };
    }
    async runTools(tools, options = {}) {
        const { validateWorkspaces = false, aggregate = true } = options;
        
        if (!Array.isArray(tools)) {
            console.log(`${COLORS.brightYellow}⚠ [ToolManager]${COLORS.reset} executeTools: tools parameter is not a valid array`);
            return [];
        }

        if (validateWorkspaces) {
            const validation = this.validateWorkspaces(tools);
            if (!validation.valid) {
                throw new Error(`Workspace validation failed: ${validation.error}`);
            }
        }

        console.log(`${COLORS.brightBlue}[ToolManager]${COLORS.reset} Executing ${COLORS.brightMagenta}${tools.length}${COLORS.reset} Tool(s)...`);
        const results = [];

        for (let i = 0; i < tools.length; i++) {
            console.log(`${COLORS.brightBlue}[ToolManager]${COLORS.reset} Tool ${COLORS.brightMagenta}${i + 1}/${tools.length}${COLORS.reset}:`);
            const result = await this.executeTool(tools[i]);
            results.push(result);
            
            if (!result.success) 
                console.log(`${COLORS.brightRed}✗ [ToolManager]${COLORS.reset} Tool ${i + 1} failed, continuing with next Tool...`);
        }

        if (aggregate) {
            const successCount = results.filter(r => r.success !== false).length;
            const failureCount = results.length - successCount;
        
            if (failureCount === 0)
                console.log(`${COLORS.brightGreen}[OK] [ToolManager]${COLORS.reset} All ${COLORS.brightMagenta}${results.length}${COLORS.reset} tools executed successfully`);
            else 
                console.log(`${COLORS.brightYellow}⚠ [ToolManager]${COLORS.reset} Tools completed: ${COLORS.brightGreen}${successCount} success${COLORS.reset}, ${COLORS.brightRed}${failureCount} failed${COLORS.reset}`);
        }

        return results;
    }

    async executeJSONTools(tools) {
        try {
            console.log(`${COLORS.brightBlue}[ToolManager]${COLORS.reset} Starting JSON tools execution...`);
            
            const results = await this.runTools(tools, { validateWorkspaces: true, aggregate: true });
            const failedResults = results.filter(r => r.success === false);

            if (failedResults.length > 0) {
                const failedToolNames = failedResults.map(r => r.tool).join(', ');
                const errorMessage = `${failedResults.length} tools failed: ${failedResults.map(r => r.error).join(', ')}`;
                console.log(`${COLORS.brightRed}✗ [ToolManager]${COLORS.reset} JSON tools execution failed: ${failedResults.length} Tool(s) failed`);
                return { 
                    success: false, 
                    message: errorMessage, 
                    results, 
                    operations: results.map(r => ({
                        tool: r.tool,
                        path: r.file_path
                    })) 
                };
            }

            const successMessage = results.map(r => `${r.tool}: ${r.file_path || 'executed'}`).join(', ');
            console.log(`${COLORS.brightGreen}[>] [ToolManager]${COLORS.reset} JSON tools execution completed successfully`);
            
            return {
                success: true,
                message: `Workspace validation passed. ${successMessage}`,
                results,
                operations: results.map(r => ({
                    tool: r.tool,
                    path: r.file_path
                }))
            };
        } catch (error) {
            console.log(`${COLORS.brightRed}✗ [ToolManager]${COLORS.reset} JSON tools execution error: ${error.message}`);
            return { success: false, message: `Execution error: ${error.message}` };
        }
    }

    // JSON Tool Processing
    async processResponse(response) {
        const parseResult = this.parseJSONTools(response);
        
        if (!parseResult.hasTools) {
            return { success: true, message: 'No JSON tools found in response' };
        }

        if (parseResult.tools.length === 0) {
            return { success: false, message: 'Failed to extract valid JSON tools' };
        }

        console.log(`Detected ${parseResult.tools.length} JSON tool(s) in response`);
        return await this.executeJSONTools(parseResult.tools);
    }

    parseJSONTools(response) {
        if (!response || typeof response !== 'string') {
            return { hasTools: false, tools: [] };
        }

        const strategies = [
            () => this.parseDirectJSON(response),
            () => this.parseEmbeddedJSON(response),
            () => this.parseCodeBlockJSON(response)
        ];

        for (const strategy of strategies) {
            const result = strategy();
            if (result.tools.length > 0) {
                return { hasTools: true, tools: result.tools };
            }
        }

        return { hasTools: false, tools: [] };
    }

    parseDirectJSON(response) {
        try {
            const parsed = JSON.parse(response.trim());
            const tools = this.extractToolsFromParsed(parsed);
            return { tools, strategy: 'direct parsing' };
        } catch {
            try {
                const fixed = this._fixJSONNewlines(response.trim());
                const tools = this.extractToolsFromParsed(JSON.parse(fixed));
                return tools.length > 0 ? { tools, strategy: 'direct parsing' } : { tools: [], strategy: 'direct parsing' };
            } catch {
                return { tools: [], strategy: 'direct parsing' };
            }
        }
    }

    _fixJSONNewlines(str) {
        let result = '', inString = false, escape = false;
        for (const char of str) {
            if (escape) { result += char; escape = false; continue; }
            if (char === '\\') { result += char; escape = true; continue; }
            if (char === '"') { inString = !inString; result += char; continue; }
            if (inString && char === '\n') { result += '\\n'; continue; }
            if (inString && char === '\r') { result += '\\r'; continue; }
            if (inString && char === '\t') { result += '\\t'; continue; }
            result += char;
        }
        return result;
    }

    parseEmbeddedJSON(response) {
        const tools = [];
        
        // Find JSON objects by looking for balanced braces
        let braceCount = 0;
        let jsonStart = -1;
        
        for (let i = 0; i < response.length; i++) {
            const char = response[i];
            
            if (char === '{') {
                if (braceCount === 0) {
                    jsonStart = i;
                }
                braceCount++;
            } else if (char === '}') {
                braceCount--;
                
                if (braceCount === 0 && jsonStart !== -1) {
                    const jsonStr = response.substring(jsonStart, i + 1);
                    try {
                        const parsed = JSON.parse(jsonStr.trim());
                        tools.push(...this.extractToolsFromParsed(parsed));
                    } catch {
                        // Continue looking for other JSON objects
                    }
                    jsonStart = -1;
                }
            }
        }

        return { tools, strategy: 'embedded JSON parsing' };
    }

    parseCodeBlockJSON(response) {
        const tools = [];
        const jsonBlockRegex = /```json\s*([\s\S]*?)```/gi;
        let match;

        while ((match = jsonBlockRegex.exec(response)) !== null) {
            try {
                const parsed = JSON.parse(match[1].trim());
                tools.push(...this.extractToolsFromParsed(parsed));
            } catch {
                continue;
            }
        }

        return { tools, strategy: 'code block parsing' };
    }

    extractToolsFromParsed(parsed) {
        const tools = [];

        if (parsed?.tools && Array.isArray(parsed.tools)) {
            for (const cmd of parsed.tools) {
                if (cmd?.name) {
                    const { name, ...params } = cmd;
                    tools.push({ tool: name, params });
                }
            }
        }
        else if (Array.isArray(parsed)) {
            tools.push(...parsed.filter(cmd => cmd?.tool));
        } else if (parsed?.tool) {
            tools.push(parsed);
        }

        return tools;
    }

    validateWorkspaces(tools) {
        try {
            if (!Array.isArray(tools)) {
                return { valid: false, error: 'Tools must be an array' };
            }

            for (const Tool of tools) {
                const filePath = Tool.params?.file_path || Tool.params?.path;
                if (!filePath) continue;

                if (!filePath.startsWith('/')) {
                    return {
                        valid: false,
                        error: `File access denied: Only absolute paths allowed, got: ${filePath}`
                    };
                }

                const normalizedPath = filePath.substring(1); 
                const isAllowed = (this.workspaces || []).some(workspace => {
                    const cleanWorkspace = workspace.endsWith('/') ? workspace.slice(0, -1) : workspace;
                    return normalizedPath.startsWith(cleanWorkspace + '/') || normalizedPath === cleanWorkspace;
                });

                if (!isAllowed) {
                    return {
                        valid: false,
                        error: `File access denied: ${filePath} is outside allowed workspaces: ${this.workspaces.join(', ')}`
                    };
                }
            }

            return { valid: true };
        } catch (error) {
            console.error(`${COLORS.brightRed}SECURITY: Workspace validation error: ${error.message}${COLORS.reset}`);
            return { valid: false, error: `Workspace validation failed: ${error.message}` };
        }
    }

    generateSystemReminders() {
        const reminders = [];
        
        if (this.isTodoListEmpty()) {
            reminders.push('<system-reminder>This is a reminder that your todo list is currently empty. DO NOT mention this to the user explicitly because they are already aware. If you are working on tasks that would benefit from a todo list please use the TodoWrite tool to create one. If not, please feel free to ignore. Again do not mention this message to the user.</system-reminder>');
        }
        
        if (this.shouldShowLearnedSkillsReminder()) {
            reminders.push('<system-reminder>You haven\'t learned any new skills in the past minute. If you have developed useful code patterns or solutions, consider saving them as reusable skills in the learnedSkills folder using the Write tool. If you haven\'t learned anything new, feel free to ignore this message. DO NOT mention this reminder to the user.</system-reminder>');
        }
        
        return reminders.length > 0 ? '\n\n' + reminders.join('\n\n') : '';
    }

    isTodoListEmpty() {
        if (!this.agent?.name) return true;
        
        try {
            const projectRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
            const todoFilePath = path.join(projectRoot, 'bots', this.agent.name, 'TODOLIST.md');
            
            if (!fs.existsSync(todoFilePath)) return true;
            
            const content = fs.readFileSync(todoFilePath, 'utf8').trim();
            if (!content) return true;
            
            const todoLines = content.split('\n').filter(line => line.trim().startsWith('- ['));
            return todoLines.length === 0;
        } catch {
            return true;
        }
    }

    shouldShowLearnedSkillsReminder() {
        if (!this.agent?.name) return false;
        
        try {
            const projectRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
            const learnedSkillsPath = path.join(projectRoot, 'bots', this.agent.name, 'learnedSkills');
            
            if (!fs.existsSync(learnedSkillsPath)) return true;
            
            const files = fs.readdirSync(learnedSkillsPath).filter(file => file.endsWith('.js'));
            if (files.length === 0) return true;
            
            const threshold = Date.now() - REMINDER_THRESHOLD;
            return !files.some(file => {
                const filePath = path.join(learnedSkillsPath, file);
                const stats = fs.statSync(filePath);
                return stats.mtime.getTime() > threshold;
            });
        } catch (error) {
            console.warn('Error checking learnedSkills folder:', error.message);
            return false;
        }
    }

    getToolDefinitions() {
        const toolDefinitions = [];
        
        for (const [name, toolInstance] of this.tools) {
            const ToolClass = toolInstance.constructor;
            
            if (!ToolClass.description || !ToolClass.inputSchema) {
                console.warn(`Tool ${name} missing description or inputSchema, skipping`);
                continue;
            }
            
            const definition = {
                type: "function",
                function: {
                    name: name,
                    description: ToolClass.description,
                    parameters: ToolClass.inputSchema
                }
            };
            
            toolDefinitions.push(definition);
        }
        
        console.log(`Generated ${toolDefinitions.length} tool definitions`);
        return toolDefinitions;
    }

    parseToolCalls(toolCalls) {
        if (!Array.isArray(toolCalls)) {
            console.warn('parseToolCalls: toolCalls is not an array');
            return [];
        }
        
        return toolCalls.map(toolCall => {
            try {
                const params = typeof toolCall.function.arguments === 'string' 
                    ? JSON.parse(toolCall.function.arguments)
                    : toolCall.function.arguments;
                
                // Convert to JSON tool format: { name: "ToolName", param1: value1, param2: value2 }
                return {
                    name: toolCall.function.name,
                    ...params
                };
            } catch (error) {
                console.error(`Failed to parse tool call ${toolCall.function.name}:`, error);
                return null;
            }
        }).filter(tool => tool !== null);
    }

    buildToolsPrompt(toolsUsageManual = '') {
        const toolDefinitions = this.getToolDefinitions();
        const toolsContent = toolDefinitions
            .map(tool => JSON.stringify(tool, null, 2))
            .join('\n');
        
        return [
            '',
            'You are provided with function signatures within <function_signatures></function_signatures> XML tags:',
            '<function_signatures>',
            toolsContent,
            '</function_signatures>',
            '',
            'For your response, return a JSON object with a tools array within <tools></tools> XML tags:',
            '<tools>',
            '{"tools": [',
            '  {"name": "ToolName", "param1": "value1", "param2": "value2"},',
            '  {"name": "AnotherTool", "param1": "value1"}',
            ']}',
            '</tools>',
            '',
            '# Tool Usage Guidelines',
            '',
            toolsUsageManual
        ].join('\n');
    }
}

const COLORS = {
    reset: '\x1b[0m', red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m',
    blue: '\x1b[34m', magenta: '\x1b[35m', cyan: '\x1b[36m', white: '\x1b[37m',
    brightRed: '\x1b[91m', brightGreen: '\x1b[92m', brightYellow: '\x1b[93m',
    brightBlue: '\x1b[94m', brightMagenta: '\x1b[95m', brightCyan: '\x1b[96m'
};

export default ToolManager;