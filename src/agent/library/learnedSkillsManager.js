import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * LearnedSkillsManager - Manages dynamically loaded learnedSkills
 * Provides a unified skill access interface with caching and incremental updates
 */
export class LearnedSkillsManager {
    constructor() {
        this.skillsCache = new Map();
        this.docsCache = new Map();
        this.lastModified = new Map();
    }

    async getLearnedSkillsForBot(botName) {
        if (!botName) return [];

        const cacheKey = botName;
        const skillsPath = this._getSkillsPath(botName);
        
        const needsUpdate = await this._needsCacheUpdate(skillsPath, cacheKey);
        
        if (!needsUpdate && this.skillsCache.has(cacheKey)) {
            return this.skillsCache.get(cacheKey);
        }

        const skillModules = await this._loadSkillModulesFromPath(skillsPath);
        this.skillsCache.set(cacheKey, skillModules);
        
        return skillModules;
    }

    async hasSkill(botName, skillName) {
        const skillModules = await this.getLearnedSkillsForBot(botName);
        return skillModules.some(module => module.functionName === skillName);
    }

    async getSkillDocs(botName) {
        if (!botName) return [];

        const cacheKey = botName;
        const skillsPath = this._getSkillsPath(botName);
        
        const needsUpdate = await this._needsCacheUpdate(skillsPath, cacheKey);
        
        if (!needsUpdate && this.docsCache.has(cacheKey)) {
            return this.docsCache.get(cacheKey);
        }

        const docs = await this._extractDocsFromPath(skillsPath);
        this.docsCache.set(cacheKey, docs);
        
        return docs;
    }

    validateSkillContent(content) {
        try {
            if (!content.includes('export async function')) {
                return { valid: false, error: 'Skill file must export async function' };
            }
            
            const forbidden = [
                'require(',
                'eval(',
                '__dirname',
                '__filename',
                'process.exit',
                'fs.writeFile',
                'fs.unlink'
            ];
            
            for (const pattern of forbidden) {
                if (content.includes(pattern)) {
                    return { valid: false, error: `Skill code forbidden to use: ${pattern}` };
                }
            }
            
            const openBraces = (content.match(/\{/g) || []).length;
            const closeBraces = (content.match(/\}/g) || []).length;
            if (openBraces !== closeBraces) {
                return { valid: false, error: 'Syntax error: unmatched braces' };
            }
            
            return { valid: true };
        } catch (error) {
            return { valid: false, error: `Validation error: ${error.message}` };
        }
    }


    _getSkillsPath(botName) {
        const projectRoot = path.resolve(__dirname, '../../..');
        return path.join(projectRoot, 'bots', botName, 'learnedSkills');
    }

    async _needsCacheUpdate(skillsPath, cacheKey) {
        try {
            const files = await this._getSkillFiles(skillsPath);
            
            for (const file of files) {
                const filePath = path.join(skillsPath, file);
                const stats = await fs.stat(filePath);
                const lastMod = this.lastModified.get(filePath);
                
                if (!lastMod || stats.mtime.getTime() > lastMod) {
                    return true;
                }
            }
            
            return false;
        } catch (error) {
            return true;
        }
    }

    async _loadSkillModulesFromPath(skillsPath) {
        const skillModules = [];
        
        try {
            const files = await this._getSkillFiles(skillsPath);
            
            for (const file of files) {
                const filePath = path.join(skillsPath, file);
                
                try {
                    const content = await fs.readFile(filePath, 'utf8');
                    
                    const validation = this.validateSkillContent(content);
                    if (!validation.valid) {
                        console.warn(`Skipping invalid skill file ${file}: ${validation.error}`);
                        continue;
                    }
                    
                    const functionMatch = content.match(/export\s+async\s+function\s+(\w+)/);
                    if (!functionMatch) {
                        console.warn(`No exported function found in ${file}`);
                        continue;
                    }
                    
                    const functionName = functionMatch[1];
                    
                    skillModules.push({
                        filePath,
                        content,
                        functionName
                    });
                    
                    const stats = await fs.stat(filePath);
                    this.lastModified.set(filePath, stats.mtime.getTime());
                    
                } catch (error) {
                    console.warn(`Failed to load skill file ${file}: ${error.message}`);
                }
            }
        } catch (error) {
            console.log(`learnedSkills folder doesn't exist or inaccessible: ${skillsPath}`);
        }
        
        return skillModules;
    }

    async _getSkillFiles(skillsPath) {
        try {
            const files = await fs.readdir(skillsPath);
            return files.filter(file => file.endsWith('.js'));
        } catch (error) {
            return [];
        }
    }


    async _extractDocsFromPath(skillsPath) {
        const docs = [];
        
        try {
            const files = await this._getSkillFiles(skillsPath);
            
            for (const file of files) {
                const filePath = path.join(skillsPath, file);
                
                try {
                    const content = await fs.readFile(filePath, 'utf8');
                    
                    const docContent = this._extractDocFromContent(content, file);
                    if (docContent) {
                        docs.push(docContent);
                    }
                } catch (error) {
                    console.warn(`Failed to extract documentation ${file}: ${error.message}`);
                }
            }
        } catch (error) {
            // Folder doesn't exist, return empty array
        }
        
        return docs;
    }

    _extractDocFromContent(content, fileName) {
        try {
            const jsdocMatch = content.match(/\/\*\*([\s\S]*?)\*\//);
            
            const functionMatch = content.match(/export async function (\w+)\([^)]*\)/);
            
            if (!functionMatch) return null;
            
            const functionName = functionMatch[1];
            const functionSignature = functionMatch[0];
            
            let doc = `learnedSkills.${functionName}\n${functionSignature}`;
            
            if (jsdocMatch) {
                const cleanDoc = jsdocMatch[1]
                    .replace(/^\s*\*/gm, '')
                    .replace(/^\s+/gm, '')
                    .trim();
                
                doc += `\n${cleanDoc}`;
            }
            
            return doc;
        } catch (error) {
            console.warn(`Failed to extract documentation ${fileName}: ${error.message}`);
            return null;
        }
    }
}

export default LearnedSkillsManager;
