/**
 * Registry for deterministic, contract-based skills.
 * A skill is an operation larger than a single Mineflayer call. The registry
 * keeps discovery and validation separate from the LLM/tool layer.
 */
export class SkillRegistry {
    constructor() {
        this.skills = new Map();
    }

    register(name, definition) {
        const key = String(name).trim();
        if (!key) throw new Error('Skill name is required');
        if (!definition || typeof definition.execute !== 'function') {
            throw new TypeError(`Skill ${key} must define execute(context, args)`);
        }
        if (this.skills.has(key)) throw new Error(`Skill already registered: ${key}`);
        const skill = {
            name: key,
            description: definition.description ?? '',
            preconditions: definition.preconditions ?? (() => true),
            success: definition.success ?? (() => true),
            failure: definition.failure ?? (() => false),
            interruptible: definition.interruptible !== false,
            recovery: definition.recovery ?? null,
            interruptPolicy: definition.interruptPolicy ?? {},
            execute: definition.execute,
        };
        this.skills.set(key, skill);
        return skill;
    }

    replace(name, definition) {
        this.skills.delete(name);
        return this.register(name, definition);
    }

    unregister(name) {
        return this.skills.delete(name);
    }

    get(name) {
        return this.skills.get(name) ?? null;
    }

    has(name) {
        return this.skills.has(name);
    }

    names() {
        return [...this.skills.keys()];
    }

    describe() {
        return [...this.skills.values()].map(skill => ({
            name: skill.name,
            description: skill.description,
            interruptible: skill.interruptible,
            hasRecovery: !!skill.recovery,
        }));
    }
}
