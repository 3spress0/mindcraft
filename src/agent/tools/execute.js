import fs from 'fs';
import path from 'path';
import { readFile } from 'fs/promises';
import { makeCompartment } from '../library/lockdown.js';
import * as skills from '../library/skills.js';
import * as world from '../library/world.js';
import { Vec3 } from 'vec3';
import { LintTool } from './lint.js';
import { LearnedSkillsManager } from '../library/learnedSkillsManager.js';

// Regex patterns for stack trace parsing
const StackTracePatterns = {
    iife: /^\s*\(async\s*\(\s*bot\s*\)\s*=>\s*\{[\s\S]*?\}\)\s*(\(\))?\s*$/,
    anonymous: /<anonymous>:(\d+):(\d+)/,
    filePath: /at.*?\(([^)]+\.(js|ts)):(\d+):(\d+)\)/,
    filePathAlt: /at.*?([^\s]+\.(js|ts)):(\d+):(\d+)/,
    throwStatements: [
        /^\s*throw\s+error\s*;?\s*$/i,
        /^\s*throw\s+new\s+Error\s*\(/i,
        /^\s*throw\s+\w+\s*;?\s*$/i,
        /^\s*throw\s+.*\.message\s*;?\s*$/i,
        /^\s*throw\s+.*Error\s*\(/i,
        /^\s*throw\s+.*error.*\s*;?\s*$/i
    ]
};


//Execute Tool - Executes JavaScript code files in Minecraft bot context
export class ExecuteTool {
    static description = 'Execute JavaScript code file in the Minecraft bot environment with full access to skills and world APIs. Code MUST be in IIFE format: (async (bot) => { ... }) without trailing parentheses or semicolons';
    static inputSchema = {
        type: "object",
        properties: {
            file_path: { 
                type: "string", 
                description: "Absolute path to the JavaScript file to execute. The file content MUST be in IIFE format: (async (bot) => { your code here }) - no trailing () or semicolon" 
            },
            description: { 
                type: "string", 
                description: "Description of what this code does" 
            }
        },
        required: ["file_path"]
    };

    constructor(agent = null) {
        this.name = 'Execute';
        this.agent = agent;
        this.learnedSkillsManager = new LearnedSkillsManager();
        this.fileCache = new FileContentCache();
        this.errorAnalyzer = new ErrorAnalyzer(this.fileCache);
        this.sandboxManager = new SandboxManager(this.learnedSkillsManager);
        
    }
    
    /**
     * Execute JavaScript files - can handle single file or array of files
     * @param {Object} params - The execution parameters
     * @param {string|Array} params.file_path - Absolute path(s) to JavaScript file(s)
     * @param {Array} [params.executable_files] - Array of executable files to choose from
     * @param {string} [params.description] - Optional description
     * @returns {Object} Result object
     */
    async execute(params) {
        let originalChat = null;
        
        try {
            const targetFile = this._validateAndExtractTargetFile(params);
            const fileData = await this.fileCache.getFileContent(targetFile);
            
            await this._validateFile(targetFile, fileData);
            
            originalChat = this._setupChatCapture();
            const compartment = await this.sandboxManager.createCompartment(this.agent);
            const result = await this._executeWithTimeout(compartment, fileData.content, targetFile);
            return this._formatSuccessResult(result, targetFile, params.description);
            
        } catch (error) {
            return await this._handleExecutionError(error, params, originalChat);
        } finally {
            this._restoreChat(originalChat);
        }
    }

    _validateAndExtractTargetFile(params) {
        const { file_path, executable_files } = params;

        if (!this.agent || !this.agent.bot) {
            throw new Error('[Execute Tool] Agent with bot context is required for execution');
        }

        let targetFile = file_path;
        if (executable_files && Array.isArray(executable_files)) {
            if (executable_files.length === 0) {
                throw new Error('No executable action-code files found - code generation may have failed');
            }

            targetFile = executable_files.find(f => f.includes('action-code'));
            if (!targetFile) {
                throw new Error('No executable action-code file found in provided files');
            }
        }

        if (!targetFile) {
            throw new Error('[Execute Tool] Missing required parameter: file_path or executable_files');
        }

        return targetFile;
    }

    async _validateFile(targetFile, fileData) {
        if (!path.isAbsolute(targetFile)) {
            throw new Error('[Execute Tool] file_path must be an absolute path');
        }

        if (!targetFile.endsWith('.js')) {
            throw new Error('[Execute Tool] Only JavaScript (.js) files can be executed');
        }

        if (!fs.existsSync(targetFile)) {
            throw new Error(`[Execute Tool] File does not exist: ${targetFile}`);
        }

        if (!fileData.content.trim()) {
            throw new Error('[Execute Tool] File is empty or contains no executable code');
        }

        const lintTool = this.agent.coder.codeToolsManager.tools.get('Lint');
        const lintResult = await lintTool.execute({ file_path: targetFile });

        if (!lintResult.success) {
            throw new Error(lintResult.message);
        }
    }

    _setupChatCapture() {
        let originalChat = null;
        
        if (this.agent.bot && this.agent.bot.chat) {
            originalChat = this.agent.bot.chat;
        }
        
        this.agent.bot.chat = (message) => {
            // Limit chat message length to prevent output overflow
            const maxChatLength = 100;
            let chatMessage = message;
            if (chatMessage.length > maxChatLength) {
                chatMessage = chatMessage.substring(0, maxChatLength - 3) + '...';
            }
            this.agent.bot.output += `[CHAT] ${chatMessage}\n`;
            return originalChat.call(this.agent.bot, message);
        };

        return originalChat;
    }

    _restoreChat(originalChat) {
        if (originalChat && this.agent.bot) {
            this.agent.bot.chat = originalChat;
        }
    }

    async _executeWithTimeout(compartment, fileContent, targetFile) {
        const content = fileContent.trim();
        const isIIFE = StackTracePatterns.iife.test(content);
        
        if (!isIIFE) {
            throw new Error(`[Execute Tool] Unsupported code format. Only IIFE format is supported: (async (bot) => { ... })`);
        }
        
        const enhancedWrapper = this._createEnhancedWrapper(content, targetFile);
        const wrappedFunction = compartment.evaluate(enhancedWrapper);
        
        const abortController = new AbortController();
        let timeoutId;
        
        const timeoutPromise = new Promise((_, reject) => {
            timeoutId = setTimeout(() => {
                abortController.abort();
                reject(new Error('Code execution timeout: exceeded 60 seconds'));
            }, 60000); // 60 seconds timeout
        });
        
        try {
            const result = await Promise.race([
                wrappedFunction(this.agent.bot),
                timeoutPromise
            ]);
            
            clearTimeout(timeoutId);
            
            if (this.agent.bot) {
                this.agent.bot.interrupt_code = false;
            }
            
            return result;
            
        } catch (error) {
            clearTimeout(timeoutId);
            
            if (abortController.signal.aborted) {
                this._stopBotActions();
            }
            
            // CRITICAL: Reset interrupt flag after stopping actions to allow retry
            // Without this, coder.js Promise.race will continuously reject with "Interrupted coding session"
            if (this.agent.bot) {
                this.agent.bot.interrupt_code = false;
            }
            
            throw error;
        }
    }

    _createEnhancedWrapper(content, targetFile) {
        const WRAPPER_LINE_OFFSET = 3; // Lines added by wrapper function
        
        return `
            (async function(bot) {
                try {
                    const iifeFunction = ${content};
                    return await iifeFunction(bot);
                } catch (error) {
                    error.sourceFile = '${targetFile}';
                    
                    if (error.stack) {
                        const stackLines = error.stack.split('\\n');
                        const mappedStack = stackLines.map(line => {
                            const lineMatch = line.match(/<anonymous>:(\\d+):(\\d+)/);
                            if (lineMatch) {
                                const errorLine = parseInt(lineMatch[1]);
                                const errorColumn = parseInt(lineMatch[2]);
                                const originalLine = Math.max(1, errorLine - ${WRAPPER_LINE_OFFSET});
                                return line.replace(/<anonymous>:(\\d+)/, \`\${error.sourceFile}:\${originalLine}\`);
                            }
                            return line;
                        });
                        error.stack = mappedStack.join('\\n');
                    }
                    
                    throw error;
                }
            })
        `;
    }

    _stopBotActions() {
        console.log('Code execution was aborted due to timeout, attempting to stop bot actions...');
        
        if (this.agent.bot) {
            try {
                this.agent.bot.clearControlStates();
                if (this.agent.bot.pathfinder) {
                    this.agent.bot.pathfinder.stop();
                }

                this.agent.bot.stopDigging();
                if (this.agent.bot.pvp) {
                    this.agent.bot.pvp.stop();
                }

                if (this.agent.bot.collectBlock) {
                    this.agent.bot.collectBlock.cancelTask();
                }
                this.agent.bot.interrupt_code = true;
                console.log('Successfully stopped all bot actions');
            } catch (stopError) {
                console.warn('Failed to stop bot actions:', stopError.message);
            }
        }
    }

    _formatSuccessResult(result, targetFile, description) {
        const executionOutput = this._captureExecutionOutput();
        
        console.log("Bot connection status:", this.agent.bot?.entity?.position ? "Connected" : "Disconnected");
        console.log("Action manager status:", this.agent.actions ? "Available" : "Not available");

        const fileName = path.basename(targetFile);
        const botPosition = this.agent.bot?.entity?.position;
        
        const executionInfo = {
            file: fileName,
            description: description || 'Code execution',
            botPosition: botPosition ? `(${botPosition.x.toFixed(1)}, ${botPosition.y}, ${botPosition.z.toFixed(1)})` : 'Unknown',
            result: result || 'No return value',
            output: executionOutput
        };
        
        console.log(`Executed: ${executionInfo.file} - ${executionInfo.description}`);
        console.log(`Bot at: ${executionInfo.botPosition}`);
        console.log(`Output: ${executionInfo.output}`);
        
        let message = "## Code Execution Result ##\n" +
            "**File:** " + executionInfo.file + "\n" +
            "**Task:** " + executionInfo.description + "\n" +
            "**Your Position:** " + executionInfo.botPosition + "\n" +
            "**Result:** " + executionInfo.result + "\n" +
            "**Execution Log:** \n" + executionInfo.output;
        
        // Limit message length to 1000 characters
        if (message.length > 500) 
            message = message.substring(0, 497) + '...';
        return {
            success: true,
            message: message,
            file_path: targetFile,
            action: 'execute'
        };
    }

    _captureExecutionOutput() {
        let executionOutput = 'No output captured during execution';
        
        if (this.agent.bot && this.agent.bot.output) {
            const output = this.agent.bot.output.trim();
            if (output) {
                executionOutput = output;
                this.agent.bot.output = '';
            }
        }
        this.agent.bot.chat(executionOutput);
        return executionOutput;
    }

    async _handleExecutionError(error, params, originalChat) {
        this._restoreChat(originalChat);
        
        const executionOutput = this._captureExecutionOutput();
        const codeErrorInfo = await this.errorAnalyzer.analyzeError(error, { ...params, agent: this.agent });
        
        const isTimeoutError = error.message && error.message.includes('Code execution timeout');
        
        let message;
        if (isTimeoutError) {
            message = 
                '## Code Execution Timeout ##\n' +
                '**Error:** Code execution exceeded 60 seconds and was terminated\n' +
                '**Reason:** The code took too long to execute and may have been stuck in an infinite loop, waiting for a resource, or the bot may be stuck in terrain\n' +
                '**Suggestion:** Review the code for potential infinite loops, long-running operations, or blocking calls\n' +
                '**Execution Log:** \n' + executionOutput;
        } else {
            message = 
                '## Code Execution Error ##\n' +
                `**Error:** ${error.message}\n` +
                codeErrorInfo.errorReport + 
                codeErrorInfo.skillSuggestions +
                '\n**Execution Log:** \n' + executionOutput;
        }
                        
        return {
            success: false,
            message: message
        };
    }
}


//String builder for efficient string concatenation
class StringBuilder {
    constructor() {
        this.parts = [];
    }
    
    append(text) {
        this.parts.push(text);
        return this;
    }
    
    appendLine(text = '') {
        this.parts.push(text + '\n');
        return this;
    }
    
    clear() {
        this.parts.length = 0;
        return this;
    }
    
    toString() {
        return this.parts.join('');
    }
}

//File content cache with TTL and LRU eviction
class FileContentCache {
    constructor(maxSize = 100, ttlMs = 300000) {
        this.cache = new Map();
        this.maxSize = maxSize;
        this.ttlMs = ttlMs;
    }
    
    async getFileContent(filePath) {
        const cached = this.cache.get(filePath);
        const now = Date.now();
        
        if (cached && (now - cached.timestamp) < this.ttlMs) {
            try {
                const stats = await fs.promises.stat(filePath);
                if (stats.mtime.getTime() === cached.data.mtime) {
                    return cached.data;
                }
            } catch (error) {
                this.cache.delete(filePath);
            }
        }
        
        try {
            const stats = await fs.promises.stat(filePath);
            const content = await fs.promises.readFile(filePath, 'utf8');
            const lines = content.split('\n');
            
            const fileData = {
                content,
                lines,
                size: stats.size,
                mtime: stats.mtime.getTime()
            };
            
            this._setCache(filePath, fileData, now);
            return fileData;
        } catch (error) {
            throw new Error(`Failed to read file ${filePath}: ${error.message}`);
        }
    }
    
    _setCache(filePath, data, timestamp) {
        if (this.cache.size >= this.maxSize) {
            const firstKey = this.cache.keys().next().value;
            this.cache.delete(firstKey);
        }
        this.cache.set(filePath, { data, timestamp });
    }
}

//Error analyzer for intelligent stack trace processing
class ErrorAnalyzer {
    constructor(fileCache) {
        this.fileCache = fileCache;
        this.stringBuilder = new StringBuilder();
    }
    
    async analyzeError(error, params) {
        const stackFrames = await this._parseStackFrames(error, params);
        const prioritizedFrames = this._prioritizeFrames(stackFrames);
        const meaningfulFrames = this._filterMeaningfulFrames(prioritizedFrames);
        
        return {
            errorReport: this._buildErrorReport(meaningfulFrames, error),
            skillSuggestions: await this._getSkillSuggestions(meaningfulFrames, params)
        };
    }
    
    async _parseStackFrames(error, params) {
        if (!error.stack) return [];
        
        const stackLines = error.stack.split('\n');
        const frames = [];
        
        for (let i = 1; i < stackLines.length; i++) {
            const line = stackLines[i].trim();
            if (!line) continue;
            
            const frameInfo = await this._parseStackLine(line, error, params, i);
            if (frameInfo) {
                frames.push(frameInfo);
            }
        }
        
        return frames;
    }
    
    async _parseStackLine(line, error, params, stackIndex) {
        const isUserCode = this._isUserCodePath(line) || this._hasSourceFile(line, error);
        if (!isUserCode) return null;
        
        const location = this._extractLocation(line, error, params);
        if (!location) return null;
        
        const codeInfo = await this._getCodeContext(location.filePath, location.line);
        
        return {
            ...location,
            stackFrame: line,
            lineContent: codeInfo.lineContent,
            contextLines: codeInfo.contextLines,
            isActionCode: location.filePath.includes('action-code'),
            isLearnedSkill: location.filePath.includes('learnedSkills'),
            isThrowStatement: this._isThrowStatement(codeInfo.lineContent),
            stackIndex
        };
    }
    
    _isUserCodePath(line) {
        const userCodePaths = ['action-code', 'learnedSkills'];
        return userCodePaths.some(path => line.includes(path));
    }
    
    _hasSourceFile(line, error) {
        return error.sourceFile && line.includes(error.sourceFile);
    }
    
    _extractLocation(line, error, params) {
        let errorLine = null;
        let errorColumn = null;
        let filePath = params.file_path;
        
        if (this._hasSourceFile(line, error)) {
            const sourceMatch = line.match(new RegExp(`${error.sourceFile.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:(\\d+):(\\d+)`));
            if (sourceMatch) {
                errorLine = parseInt(sourceMatch[1]);
                errorColumn = parseInt(sourceMatch[2]);
            }
        } else {
            let pathMatch = line.match(StackTracePatterns.filePath);
            if (!pathMatch) {
                pathMatch = line.match(StackTracePatterns.filePathAlt);
            }
            if (pathMatch) {
                filePath = pathMatch[1];
                errorLine = parseInt(pathMatch[3]);
                errorColumn = parseInt(pathMatch[4]);
            }
        }
        
        return errorLine && filePath ? { filePath, line: errorLine, column: errorColumn } : null;
    }
    
    async _getCodeContext(filePath, lineNumber) {
        try {
            const fileData = await this.fileCache.getFileContent(filePath);
            const lines = fileData.lines;
            const lineContent = lines[lineNumber - 1] || '';
            
            const maxContextLines = 4; // Show 2 lines before and after error
            const contextRadius = Math.floor(maxContextLines / 2);
            const startLine = Math.max(0, lineNumber - contextRadius - 1);
            const endLine = Math.min(lines.length - 1, lineNumber + contextRadius);
            const contextLines = [];
            
            for (let i = startLine; i <= endLine; i++) {
                contextLines.push({
                    number: i + 1,
                    content: lines[i] || '',
                    isError: (i + 1) === lineNumber
                });
            }
            
            return { lineContent, contextLines };
        } catch (error) {
            return { lineContent: '', contextLines: [] };
        }
    }
    
    _isThrowStatement(lineContent) {
        const trimmed = lineContent.trim();
        return StackTracePatterns.throwStatements.some(pattern => pattern.test(trimmed));
    }
    
    _prioritizeFrames(frames) {
        const rootCause = frames.filter(f => !f.isThrowStatement);
        const throwStatements = frames.filter(f => f.isThrowStatement);
        
        const prioritized = rootCause.length > 0 ? rootCause : throwStatements;
        
        return prioritized.sort((a, b) => {
            if (a.stackIndex !== b.stackIndex) {
                return b.stackIndex - a.stackIndex;
            }
            if (a.isActionCode !== b.isActionCode) {
                return a.isActionCode ? -1 : 1;
            }
            if (a.isLearnedSkill !== b.isLearnedSkill) {
                return a.isLearnedSkill ? -1 : 1;
            }
            return a.line - b.line;
        });
    }
    
    _filterMeaningfulFrames(frames) {
        return frames.filter(frame => 
            frame.lineContent && frame.lineContent.trim().length > 0
        );
    }
    
    _buildErrorReport(frames, error) {
        if (frames.length === 0) {
            return this._buildFallbackReport(error);
        }
        
        this.stringBuilder.clear();
        this.stringBuilder.append('\n#### ERROR CALL CHAIN ###\n');
        
        frames.forEach((frame, index) => {
            const depth = '  '.repeat(index);
            const arrow = index > 0 ? '↳ ' : '';
            
            this.stringBuilder
                .append(`${depth}${arrow}**${error.message}**\n`)
                .append(`${depth}  File: ${frame.filePath}\n`)
                .append(`${depth}  Location: Line ${frame.line}, Column ${frame.column}\n`)
                .append(`${depth}  Code Context:\n`);
            
            this._appendCodeContext(frame, depth);
            
            if (index < frames.length - 1) {
                this.stringBuilder.append('\n');
            }
        });
        
        if (error.name && error.name !== 'Error') {
            this.stringBuilder.append(`\nError Type: ${error.name}\n`);
        }
        
        return this.stringBuilder.toString();
    }
    
    _appendCodeContext(frame, depth) {
        frame.contextLines.forEach(line => {
            const prefix = line.isError ? '>>> ' : '    ';
            this.stringBuilder.append(`${depth}  ${prefix}${line.number.toString().padStart(3)}: ${line.content}\n`);
            
            if (line.isError && frame.column > 0) {
                const actualPrefix = `${depth}  ${prefix}${line.number.toString().padStart(3)}: `;
                const spaces = ' '.repeat(actualPrefix.length + frame.column - 1);
                this.stringBuilder.append(`${spaces}^\n`);
            }
        });
    }
    
    _buildFallbackReport(error) {
        return `\n#### CODE EXECUTION ERROR INFO ###\nError: ${error.message}\nUnable to map error to source location\n`;
    }
    
    async _getSkillSuggestions(frames, params) {
        if (frames.length === 0) return '';
        
        const errorLineContent = frames[0].lineContent;
        try {
            // Get skill suggestions from the agent's skill library
            const maxSkillSuggestions = 2;
            const skillDocs = await params.agent?.prompter?.skill_libary?.getRelevantSkillDocs(errorLineContent, maxSkillSuggestions);
            return skillDocs ? skillDocs + '\n' : '';
        } catch (error) {
            return '';
        }
    }
}

//Sandbox manager for secure code execution
class SandboxManager {
    constructor(learnedSkillsManager) {
        this.learnedSkillsManager = learnedSkillsManager;
        this.skillsCache = new Map();
        this.skillTimestamps = new Map();
    }
    
    async createCompartment(agent) {
        const compartment = makeCompartment(this._getGlobalConfig());
        const learnedSkills = await this._loadLearnedSkills(compartment, agent);
        compartment.globalThis.learnedSkills = learnedSkills;
        return compartment;
    }
    
    _getGlobalConfig() {
        return {
            Promise,
            console,
            setTimeout,
            setInterval,
            clearTimeout,
            clearInterval,
            ...world,
            ...skills,
            Vec3,
            log: skills.log,
            world: world,
            skills: skills
        };
    }
    
    async _loadLearnedSkills(compartment, agent) {
        const learnedSkills = {};
        
        try {
            const skillModules = await this.learnedSkillsManager.getLearnedSkillsForBot(agent.name);
            const currentFiles = new Set();
            
            for (const module of skillModules) {
                currentFiles.add(module.filePath);
                const lastModified = module.lastModified || 0;
                const cachedTimestamp = this.skillTimestamps.get(module.filePath) || 0; 
                if (lastModified > cachedTimestamp || !this.skillsCache.has(module.functionName)) {
                    console.log(`Loading skill: ${module.functionName}`);
                    const compiledFunction = this._compileSkillInCompartment(compartment, module);
                    if (compiledFunction) {
                        this.skillsCache.set(module.functionName, compiledFunction);
                        this.skillTimestamps.set(module.filePath, lastModified);
                    }
                }
                const skillFunction = this.skillsCache.get(module.functionName);
                if (skillFunction) {
                    learnedSkills[module.functionName] = skillFunction;
                }
            }
            
            this._cleanupDeletedSkills(currentFiles);
            
        } catch (error) {
            console.log(`Failed to load learned skills: ${error.message}`);
        }
        
        return learnedSkills;
    }
    
    _compileSkillInCompartment(compartment, module) {
        try {
            const transformedContent = module.content.replace(/export\s+async\s+function\s+(\w+)/g, 'async function $1');
            
            const codeWithSourceMap = [
                transformedContent,
                `globalThis.${module.functionName} = ${module.functionName};`,
                `//# sourceURL=${module.filePath}`
            ].join('\n');
            
            compartment.evaluate(codeWithSourceMap);
            
            const moduleFunction = compartment.globalThis[module.functionName];
            if (typeof moduleFunction === 'function') {
                return moduleFunction;
            } else {
                console.warn(`Function ${module.functionName} not found in module ${module.filePath}`);
                return null;
            }
        } catch (error) {
            console.warn(`Failed to compile skill ${module.functionName}: ${error.message}`);
            return null;
        }
    }
    
    _cleanupDeletedSkills(currentFiles) {
        const cachedFiles = Array.from(this.skillTimestamps.keys());
        
        for (const cachedFile of cachedFiles) {
            if (!currentFiles.has(cachedFile)) {
                console.log(`Removing deleted skill file from cache: ${cachedFile}`);
                const skillNameFromPath = cachedFile.split('/').pop().replace('.js', '');
                this.skillsCache.delete(skillNameFromPath);
                this.skillTimestamps.delete(cachedFile);
            }
        }
    }
}

export default ExecuteTool;
