/**
 * planner.js — turns a goal into a verifiable, dependency-ordered plan, and
 * revises it when the critic says an approach failed.
 *
 * The model is used for *delineation only*: it returns strict JSON; validation,
 * id assignment, dependency mapping and control flow all live in plan.js so a
 * malformed model response can be retried or, failing that, the runner falls
 * back to a single-step plan ("just do the goal") instead of crashing.
 */

import settings from '../settings.js';
import { getFullState } from '../library/full_state.js';
import { projectFromGoal, PlanValidationError, stepsFromJSON, Project, PROJECT } from './plan.js';

const PLAN_SYSTEM = `You are a Minecraft planning agent. You break a high-level goal into a short, concrete,\nordered plan that a separate executor agent (which can use all in-game commands and tools)\nwill carry out step by step.\n\nRules:\n- Produce 3 to 12 steps. Each step must be ONE self-contained, actionable instruction.\n- Order steps so prerequisites come first. Use depends_on with 1-based step numbers only\n  when a step genuinely requires another (most steps are simply sequential).\n- Every step needs a machine-verifiable "expected" outcome. Use these kinds:\n    {"kind":"inventory","item":"oak_log","gained":1}      // inventory must gain/contain items\n    {"kind":"near","x":120,"y":64,"z":-40,"radius":6}     // bot reaches coordinates\n    {"kind":"block_near","block":"crafting_table","radius":8,"atLeast":1}\n    {"kind":"entity_near","entity":"villager","radius":24,"atLeast":1}\n    {"kind":"health_above","level":10}\n    {"kind":"freeform","description":"<what a Minecraft expert would see if done>"}\n- Prefer concrete, checkable expectations over vague ones. Use freeform only when the result\n  is not an inventory/position/block/entity/health fact.\n- For craft/smelt/brew steps ALSO add "expected_delta": exact signed inventory changes, e.g.\n  {"expected_delta":{"inventory.hopper":1,"inventory.iron_ingot":-5}}. Positive numbers mean\n  gains at least N; negative numbers mean exactly |N| consumed (recipes are exact).\n- For steps that place/build blocks use block_near; for gathering use the inventory expectation\n  with "gained". Reuse KNOWN WORLD FACTS instead of rediscovering locations or revisiting\n  depleted sources, and route around listed threats.\n- Steps must be achievable with in-game actions only (move, mine, craft, build, fight, farm,\n  trade, use chests). Never require commands the bot does not have.\n- Consider resources, tools, danger (light, weapons, food) and verification of each stage.\n\nRespond with ONLY a JSON object, no markdown fences, in exactly this shape:\n{\n  "summary": "one-sentence strategy",\n  "constraints": ["e.g. do not destroy player builds"],\n  "completion_criteria": "how a human would know the whole goal is done",\n  "steps": [\n    {"title":"short label","instruction":"detailed instruction for the executor","expected":{...},"expected_delta":{"inventory.item":1},"depends_on":["1"]}\n  ]\n}`;

const REPLAN_SYSTEM = `You are a Minecraft planning agent revising a plan after reality diverged from it.\nYou are given the goal, the steps already completed, the failed step, the critic's diagnosis,\nand the latest world observation. Produce the REMAINING plan (do NOT repeat completed steps).\n\nRules:\n- Produce 1 to 10 concrete, ordered steps that lead from the current situation to the goal.\n- Address the diagnosed failure directly: gather missing prerequisites first, choose a different\n  location/method, or split the failed step into smaller, safer steps.\n- Same expectation format as planning: inventory / near / block_near / entity_near /\n  health_above / freeform, machine-verifiable where possible. Add "expected_delta" for craft\n  and consume steps (signed inventory changes, exact on the cost side).\n- Reuse KNOWN WORLD FACTS and do not repeat a method the critic says failed; prefer a fresh\n  location/material source when the previous one was missing or depleted.\n- depends_on uses 1-based numbers referring to steps IN THIS NEW LIST only.\n- If the goal is genuinely impossible (e.g. requires creative-only items in survival), return\n  {"impossible": true, "reason": "..."}.\n\nRespond with ONLY a JSON object:\n{\n  "summary": "revised strategy",\n  "steps": [ {"title":..., "instruction":..., "expected":{...}, "depends_on":[]} ]\n}`;

/** Extract a JSON object from a model response that may contain fences/prose. */
export function extractJSON(text) {
    if (text == null) throw new Error('empty planner response');
    let raw = String(text).trim();
    const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fence) raw = fence[1].trim();
    const start = raw.indexOf('{');
    const end = raw.lastIndexOf('}');
    if (start === -1 || end <= start) throw new Error('no JSON object in planner response');
    return JSON.parse(raw.slice(start, end + 1));
}

function worldContext(agent) {
    let lines;
    try {
        const state = getFullState(agent);
        const g = state.gameplay;
        const inv = Object.entries(state.inventory?.counts || {})
            .sort((a, b) => b[1] - a[1]).slice(0, 18)
            .map(([k, v]) => `${k} x${v}`).join(', ');
        const entities = [...(state.nearby?.entityTypes || [])].slice(0, 12).join(', ');
        const players = [...(state.nearby?.humanPlayers || [])].join(', ');
        lines = [
            `Position: ${g.position.x}, ${g.position.y}, ${g.position.z} (${g.biome || 'unknown biome'}, ${g.dimension})`,
            `Time/weather: ${g.timeLabel}, ${g.weather}. Health ${g.health}/20, hunger ${g.hunger}/20, game mode ${g.gamemode}`,
            `Inventory: ${inv || 'empty'}`,
            `Nearby entities: ${entities || 'none'}`,
            players ? `Nearby players: ${players}` : null,
            `Ground under bot: ${state.surroundings?.below || 'unknown'}`,
        ].filter(Boolean);
    } catch {
        lines = ['(live world state unavailable)'];
    }
    // Persistent facts are independent of the live snapshot — always include
    // them when available (including right after a restart).
    try {
        const facts = knownFacts(agent);
        if (facts) lines.push('', 'KNOWN WORLD FACTS (persistent memory — reuse these, do not rediscover):', facts);
    } catch { /* model optional */ }
    return lines.join('\n');
}

/** Persistent world-model facts relevant to planning, or null when empty. */
function knownFacts(agent) {
    try {
        const model = agent.world_model;
        if (!model) return null;
        const text = model.summaryForPlanner({ maxLines: settings.world_model?.summary_max_lines ?? 40 });
        if (!text || text.startsWith('Self:') && text.split('\n').length <= 1) return null;
        // The live "Self:" line duplicates worldContext; drop it.
        return text.split('\n').filter((l) => !l.startsWith('Self:')).join('\n').trim() || null;
    } catch {
        return null;
    }
}

export class Planner {
    constructor(agent, { sendRequest = null } = {}) {
        this.agent = agent;
        // Injection seam for tests / future model router.
        this._sendRequest = sendRequest;
    }

    config() {
        return { ...(settings.planning || {}) };
    }

    async _model(messages, system) {
        if (this._sendRequest) return this._sendRequest(messages, system);
        const model = this.agent.prompter.chat_model;
        const opts = { cacheScope: 'planning', transportCacheScope: 'planning' };
        return await model.sendRequest(messages, system, '***', null, opts);
    }

    /**
     * Create a Project for a goal.
     * @returns {Promise<{project: Project, warnings: string[]}>}
     */
    async createPlan(goal, { attempts = null } = {}) {
        const tries = attempts ?? this.config().planner_attempts ?? 2;
        let lastError = null;
        for (let i = 0; i < tries; i++) {
            const user = [
                `GOAL: ${goal}`,
                '',
                'CURRENT WORLD STATE:',
                worldContext(this.agent),
                '',
                i > 0 ? `Your previous response was invalid (${lastError?.message || lastError}). Return correct JSON only.` : 'Produce the plan JSON now.',
            ].join('\n');
            const res = await this._model([{ role: 'user', content: user }], PLAN_SYSTEM);
            try {
                const json = extractJSON(res);
                if (!Array.isArray(json.steps) || json.steps.length === 0) {
                    throw new PlanValidationError(['JSON has no steps array'], json);
                }
                const { project, warnings } = projectFromGoal(goal, json);
                if (warnings.length) console.warn('[planning] plan warnings:', warnings.join('; '));
                return { project, warnings };
            } catch (err) {
                lastError = err;
                console.warn('[planning] plan parse/validation failed, retrying:', err.message);
            }
        }
        // Fallback: a single verifiable step rather than abandoning the goal.
        console.warn('[planning] falling back to single-step plan:', lastError?.message);
        const project = new Project({
            goal,
            summary: 'single-step fallback plan',
            status: PROJECT.ACTIVE,
            steps: [{
                title: goal.slice(0, 80),
                instruction: `Achieve this goal using whatever Minecraft actions are appropriate: ${goal}. When done, stop.`,
                expected: { kind: 'freeform', description: `goal achieved: ${goal}` },
            }],
        });
        project.touch('fallback plan (model output unusable)');
        return { project, warnings: ['planner produced unusable JSON; used single-step fallback'] };
    }

    /**
     * Revise the remaining plan after a failed step.
     * @returns {PlanStep[]} or null when the model declares the goal impossible.
     */
    async replan(project, failedStep, critique, { attempts = null } = {}) {
        const tries = attempts ?? this.config().planner_attempts ?? 2;
        const completed = project.steps.filter((s) => s.status === 'done' || s.status === 'skipped');
        let lastError = null;
        for (let i = 0; i < tries; i++) {
            const user = [
                `GOAL: ${project.goal}`,
                project.completionCriteria ? `DONE WHEN: ${project.completionCriteria}` : null,
                '',
                `COMPLETED STEPS (do not repeat):\n${completed.map((s, i) => `${i + 1}. ${s.title}`).join('\n') || '(none)'}`,
                '',
                `FAILED STEP: ${failedStep.title}\nInstruction: ${failedStep.instruction}`,
                `CRITIC DIAGNOSIS: ${critique.reasoning || critique.failureClass || 'failed'} (class: ${critique.failureClass})`,
                `OBSERVED CHANGE:\n${critique.diffText || 'no observable change'}`,
                '',
                'CURRENT WORLD STATE:',
                worldContext(this.agent),
                '',
                i > 0 ? `Previous response was invalid (${lastError?.message || lastError}). Return correct JSON only.` : 'Produce the remaining-plan JSON now.',
            ].filter(Boolean).join('\n');
            const res = await this._model([{ role: 'user', content: user }], REPLAN_SYSTEM);
            try {
                const json = extractJSON(res);
                if (json.impossible) return { impossible: true, reason: String(json.reason || 'declared impossible') };
                const { steps, problems } = stepsFromJSON(json.steps);
                if (steps.length === 0 || problems.some((p) => p.includes('cycle'))) {
                    throw new PlanValidationError(problems, json);
                }
                if (problems.length) console.warn('[planning] replan warnings:', problems.join('; '));
                return { steps, summary: String(json.summary || '').slice(0, 300), warnings: problems };
            } catch (err) {
                lastError = err;
                console.warn('[planning] replan parse/validation failed, retrying:', err.message);
            }
        }
        return null; // signal: cannot revise; escalate to human
    }
}
