import * as skills from '../library/skills.js';
import * as world from '../library/world.js';
import settings from '../settings.js';
import convoManager from '../conversation.js';
import { buildSchematic } from '../npc/schematic_build.js';
import { Vec3 } from 'vec3';
import { mineBlocks as baritoneMineBlocks, status as baritoneStatus } from '../baritone/baritone.js';
import { setProfileName } from '../baritone/settings.js';
import { saveAreaAsLitematic, saveAreaAsSchem } from '../schematics/capture.js';
import { setHome, getHome } from '../navigation/home.js';
import { explore } from '../navigation/exploration.js';
import { replaceTool } from '../library/durability.js';
import { RISK_PRESETS } from '../humanlike/personality.js';
import { getSpotRegistry } from '../storage/placement.js';
import { getMentalMap, POI_TYPES, noteBedIfNear } from '../memory/mental_map.js';
import { planFetch, executeFetch } from '../storage/fetch.js';
import { executeTidy } from '../storage/tidying.js';
import { executeSort } from '../storage/sorting.js';


function runAsAction (actionFn, resume = false, timeout = -1) {
    let actionLabel = null;  // Will be set on first use
    
    const wrappedAction = async function (agent, ...args) {
        // Set actionLabel only once, when the action is first created
        if (!actionLabel) {
            const actionObj = actionsList.find(a => a.perform === wrappedAction);
            actionLabel = actionObj.name.substring(1); // Remove the ! prefix
        }

        const actionFnWithAgent = async () => {
            await actionFn(agent, ...args);
        };
        const code_return = await agent.actions.runAction(`action:${actionLabel}`, actionFnWithAgent, { timeout, resume });
        if (code_return.interrupted && !code_return.timedout)
            return code_return.message || 'Action interrupted before completion.';
        return code_return.message || 'Action completed.';
    };

    return wrappedAction;
}

export const actionsList = [
    {
        name: '!newAction',
        description: 'Perform new and unknown custom behaviors that are not available as a command.', 
        params: {
            'prompt': { type: 'string', description: 'A natural language prompt to guide code generation. Make a detailed step-by-step plan.' }
        },
        perform: async function(agent, prompt) {
            if (!settings.allow_insecure_coding) { 
                agent.openChat('newAction is disabled. Enable with allow_insecure_coding=true in settings.js');
                return "newAction not allowed! Code writing is disabled in settings. Notify the user.";
            }
            let result = "";
            const actionFn = async () => {
                try {
                    result = await agent.coder.generateCode(prompt);
                } catch (e) {
                    result = 'Error generating code: ' + e.toString();
                }
            };
            const code_return = await agent.actions.runAction('action:newAction', actionFn, {timeout: settings.code_timeout_mins});
            return result || code_return.message || 'newAction did not produce code or a tool result.';
        }
    },
    {
        name: '!stop',
        description: 'Force stop all actions and commands that are currently executing.',
        perform: async function (agent) {
            await agent.finishInterruptedNativeToolCalls?.('Tool interrupted by user !stop command.');
            await agent.actions.stop();
            agent.clearBotLogs();
            agent.actions.cancelResume();
            agent.bot.emit('idle');
            let msg = 'Agent stopped.';
            if (agent.self_prompter.isActive())
                msg += ' Self-prompting still active.';
            return msg;
        }
    },
    {
        name: '!stfu',
        description: 'Stop all chatting and self prompting, but continue current action.',
        perform: async function (agent) {
            agent.openChat('Shutting up.');
            agent.shutUp();
            return 'Chatting and self-prompting stopped; current action continues.';
        }
    },
    {
        name: '!restart',
        description: 'Restart the agent process.',
        perform: async function (agent) {
            agent.cleanKill();
        }
    },
    {
        name: '!clearChat',
        description: 'Clear the chat history.',
        perform: async function (agent) {
            agent.history.clear();
            return agent.name + "'s chat history was cleared, starting new conversation from scratch.";
        }
    },
    {
        name: '!goToPlayer',
        description: 'Go to the given player.',
        params: {
            'player_name': {type: 'string', description: 'The name of the player to go to.'},
            'closeness': {type: 'float', description: 'How close to get to the player.', domain: [0, Infinity]}
        },
        perform: runAsAction(async (agent, player_name, closeness) => {
            await skills.goToPlayer(agent.bot, player_name, closeness);
        })
    },
    {
        name: '!followPlayer',
        description: 'Endlessly follow the given player.',
        params: {
            'player_name': {type: 'string', description: 'name of the player to follow.'},
            'follow_dist': {type: 'float', description: 'The distance to follow from.', domain: [0, Infinity]}
        },
        perform: runAsAction(async (agent, player_name, follow_dist) => {
            await skills.followPlayer(agent.bot, player_name, follow_dist);
        }, true)
    },
    {
        name: '!goToCoordinates',
        description: 'Go to the given x, y, z location.',
        params: {
            'x': {type: 'float', description: 'The x coordinate.', domain: [-Infinity, Infinity]},
            'y': {type: 'float', description: 'The y coordinate.', domain: [-64, 320]},
            'z': {type: 'float', description: 'The z coordinate.', domain: [-Infinity, Infinity]},
            'closeness': {type: 'float', description: 'How close to get to the location.', domain: [0, Infinity]}
        },
        perform: runAsAction(async (agent, x, y, z, closeness) => {
            await skills.goToPosition(agent.bot, x, y, z, closeness);
        })
    },
    {
        name: '!searchForBlock',
        description: 'Find and go to the nearest block of a given type in a given range.',
        params: {
            'type': { type: 'BlockName', description: 'The block type to go to.' },
            'search_range': { type: 'float', description: 'The range to search for the block. Minimum 32.', domain: [10, 512] }
        },
        perform: runAsAction(async (agent, block_type, range) => {
            if (range < 32) {
                skills.log(agent.bot, `Minimum search range is 32.`);
                range = 32;
            }
            await skills.goToNearestBlock(agent.bot, block_type, 4, range);
        })
    },
    {
        name: '!searchForEntity',
        description: 'Find and go to the nearest entity of a given type in a given range.',
        params: {
            'type': { type: 'string', description: 'The type of entity to go to.' },
            'search_range': { type: 'float', description: 'The range to search for the entity.', domain: [32, 512] }
        },
        perform: runAsAction(async (agent, entity_type, range) => {
            await skills.goToNearestEntity(agent.bot, entity_type, 4, range);
        })
    },
    {
        name: '!moveAway',
        description: 'Move away from the current location in any direction by a given distance.',
        params: {'distance': { type: 'float', description: 'The distance to move away.', domain: [0, Infinity] }},
        perform: runAsAction(async (agent, distance) => {
            await skills.moveAway(agent.bot, distance);
        })
    },
    {
        name: '!rememberHere',
        description: 'Save the current location with a given name.',
        params: {'name': { type: 'string', description: 'The name to remember the location as.' }},
        perform: async function (agent, name) {
            const pos = agent.bot.entity.position;
            agent.memory_bank.rememberPlace(name, pos.x, pos.y, pos.z);
            return `Location saved as "${name}".`;
        }
    },
    {
        name: '!goToRememberedPlace',
        description: 'Go to a saved location.',
        params: {'name': { type: 'string', description: 'The name of the location to go to.' }},
        perform: runAsAction(async (agent, name) => {
            const pos = agent.memory_bank.recallPlace(name);
            if (!pos) {
            skills.log(agent.bot, `No location named "${name}" saved.`);
            return;
            }
            await skills.goToPosition(agent.bot, pos[0], pos[1], pos[2], 1);
        })
    },
    {
        name: '!givePlayer',
        description: 'Give the specified item to the given player.',
        params: { 
            'player_name': { type: 'string', description: 'The name of the player to give the item to.' }, 
            'item_name': { type: 'ItemName', description: 'The name of the item to give.' },
            'num': { type: 'int', description: 'The number of items to give.', domain: [1, Number.MAX_SAFE_INTEGER] }
        },
        perform: runAsAction(async (agent, player_name, item_name, num) => {
            await skills.giveToPlayer(agent.bot, item_name, player_name, num);
        })
    },
    {
        name: '!consume',
        description: 'Eat/drink the given item.',
        params: {'item_name': { type: 'ItemName', description: 'The name of the item to consume.' }},
        perform: runAsAction(async (agent, item_name) => {
            await skills.consume(agent.bot, item_name);
        })
    },
    {
        name: '!equip',
        description: 'Equip the given item.',
        params: {'item_name': { type: 'ItemName', description: 'The name of the item to equip.' }},
        perform: runAsAction(async (agent, item_name) => {
            await skills.equip(agent.bot, item_name);
        })
    },
    {
        name: '!putInChest',
        description: 'Put the given item in the nearest chest.',
        params: {
            'item_name': { type: 'ItemName', description: 'The name of the item to put in the chest.' },
            'num': { type: 'int', description: 'The number of items to put in the chest.', domain: [1, Number.MAX_SAFE_INTEGER] }
        },
        perform: runAsAction(async (agent, item_name, num) => {
            await skills.putInChest(agent.bot, item_name, num);
        })
    },
    {
        name: '!takeFromChest',
        description: 'Take the given items from the nearest chest.',
        params: {
            'item_name': { type: 'ItemName', description: 'The name of the item to take.' },
            'num': { type: 'int', description: 'The number of items to take.', domain: [1, Number.MAX_SAFE_INTEGER] }
        },
        perform: runAsAction(async (agent, item_name, num) => {
            await skills.takeFromChest(agent.bot, item_name, num);
        })
    },
    {
        name: '!viewChest',
        description: 'View the items/counts of the nearest chest.',
        params: { },
        perform: runAsAction(async (agent) => {
            await skills.viewChest(agent.bot);
        })
    },
    {
        name: '!discard',
        description: 'Discard the given item from the inventory.',
        params: {
            'item_name': { type: 'ItemName', description: 'The name of the item to discard.' },
            'num': { type: 'int', description: 'The number of items to discard.', domain: [1, Number.MAX_SAFE_INTEGER] }
        },
        perform: runAsAction(async (agent, item_name, num) => {
            const start_loc = agent.bot.entity.position;
            await skills.moveAway(agent.bot, 5);
            await skills.discard(agent.bot, item_name, num);
            await skills.goToPosition(agent.bot, start_loc.x, start_loc.y, start_loc.z, 0);
        })
    },
    {
        name: '!collectBlocks',
        description: 'Collect the nearest blocks of a given type.',
        params: {
            'type': { type: 'BlockName', description: 'The block type to collect.' },
            'num': { type: 'int', description: 'The number of blocks to collect.', domain: [1, Number.MAX_SAFE_INTEGER] }
        },
        perform: runAsAction(async (agent, type, num) => {
            await skills.collectBlock(agent.bot, type, num);
        }, false, 10) // 10 minute timeout
    },
    {
        name: '!craftRecipe',
        description: 'Craft the requested number of output items from a recipe.',
        params: {
            'recipe_name': { type: 'ItemName', description: 'The name of the output item to craft.' },
            'num': { type: 'int', description: 'The desired number of output items to craft. For recipes that output multiple items, the agent will run the recipe only as many times as needed.', domain: [1, Number.MAX_SAFE_INTEGER] }
        },
        perform: runAsAction(async (agent, recipe_name, num) => {
            await skills.craftRecipe(agent.bot, recipe_name, num);
        })
    },
    {
        name: '!smeltItem',
        description: 'Smelt the given item the given number of times.',
        params: {
            'item_name': { type: 'ItemName', description: 'The name of the input item to smelt.' },
            'num': { type: 'int', description: 'The number of times to smelt the item.', domain: [1, Number.MAX_SAFE_INTEGER] }
        },
        perform: runAsAction(async (agent, item_name, num) => {
            let success = await skills.smeltItem(agent.bot, item_name, num);
            if (success) {
                setTimeout(() => {
                    agent.cleanKill('Safely restarting to update inventory.');
                }, 500);
            }
        })
    },
    {
        name: '!clearFurnace',
        description: 'Take all items out of the nearest furnace.',
        params: { },
        perform: runAsAction(async (agent) => {
            await skills.clearNearestFurnace(agent.bot);
        })
    },
        {
        name: '!placeHere',
        description: 'Place a given block in the current location. Do NOT use to build structures, only use for single blocks/torches.',
        params: {'type': { type: 'BlockOrItemName', description: 'The block type to place.' }},
        perform: runAsAction(async (agent, type) => {
            let pos = agent.bot.entity.position;
            await skills.placeBlock(agent.bot, type, pos.x, pos.y, pos.z);
        })
    },
    {
        name: '!buildSchematic',
        description: 'Build a structure from the schematic library (.litematic, .schem, .nbt or .json) block by block. If materials are missing, the build pauses and resumes when the command is run again after gathering.',
        params: {
            'name': { type: 'string', description: 'Library build name (filename with or without extension). Use !listBuilds to browse.' },
            'x': { type: 'float', description: 'Optional world X of the build corner. Omit to auto-place on nearby flat ground.' },
            'y': { type: 'float', description: 'Optional world Y (ground level) of the build corner.' },
            'z': { type: 'float', description: 'Optional world Z of the build corner.' },
            'rotation': { type: 'int', description: 'Optional rotation 0-3 (90 degree steps). Omit for a random one.' },
        },
        perform: runAsAction(async (agent, name, x, y, z, rotation) => {
            let position = null;
            if (x !== undefined && y !== undefined && z !== undefined) {
                position = new Vec3(x, y, z);
            }
            const orient = rotation === undefined || rotation === null ? null : rotation;
            const result = await buildSchematic(agent, name, position, orient);
            if (result.status === 'error') throw new Error(result.message);
            return result.message;
        })
    },
    {
        name: '!saveArea',
        description: 'Capture a box of the world (two opposite corners) and save it as a Litematica .litematic file in the build library, so it can be listed, quoted and rebuilt with !buildSchematic.',
        params: {
            'name': { type: 'string', description: 'Name for the saved build (no extension needed).' },
            'x1': { type: 'float', description: 'X of the first corner.', domain: [-Infinity, Infinity] },
            'y1': { type: 'float', description: 'Y of the first corner.', domain: [-64, 320] },
            'z1': { type: 'float', description: 'Z of the first corner.', domain: [-Infinity, Infinity] },
            'x2': { type: 'float', description: 'X of the opposite corner.', domain: [-Infinity, Infinity] },
            'y2': { type: 'float', description: 'Y of the opposite corner.', domain: [-64, 320] },
            'z2': { type: 'float', description: 'Z of the opposite corner.', domain: [-Infinity, Infinity] },
        },
        perform: async function (agent, name, x1, y1, z1, x2, y2, z2) {
            try {
                const res = saveAreaAsLitematic(agent.bot, name, { x: x1, y: y1, z: z1 }, { x: x2, y: y2, z: z2 });
                const top = Object.entries(res.materials)
                    .sort((a, b) => b[1] - a[1])
                    .slice(0, 5)
                    .map(([item, n]) => `${item} x${n}`)
                    .join(', ');
                return `Saved "${res.name}.litematic" to the build library: ${res.width}x${res.height}x${res.length}, ${res.totalBlocks} blocks. Main materials: ${top}. It now shows up in !listBuilds and can be rebuilt with !buildSchematic(${res.name}).`;
            } catch (e) {
                return `Could not save the area: ${e.message}`;
            }
        }
    },
    {
        name: '!saveAreaSchem',
        description: 'Capture a box of the world (two opposite corners) and save it as a Sponge/WorldEdit .schem file in the build library — the format Baritone and WorldEdit use.',
        params: {
            'name': { type: 'string', description: 'Name for the saved build (no extension needed).' },
            'x1': { type: 'float', description: 'X of the first corner.', domain: [-Infinity, Infinity] },
            'y1': { type: 'float', description: 'Y of the first corner.', domain: [-64, 320] },
            'z1': { type: 'float', description: 'Z of the first corner.', domain: [-Infinity, Infinity] },
            'x2': { type: 'float', description: 'X of the opposite corner.', domain: [-Infinity, Infinity] },
            'y2': { type: 'float', description: 'Y of the opposite corner.', domain: [-64, 320] },
            'z2': { type: 'float', description: 'Z of the opposite corner.', domain: [-Infinity, Infinity] },
        },
        perform: async function (agent, name, x1, y1, z1, x2, y2, z2) {
            try {
                const res = saveAreaAsSchem(agent.bot, name, { x: x1, y: y1, z: z1 }, { x: x2, y: y2, z: z2 });
                const top = Object.entries(res.materials)
                    .sort((a, b) => b[1] - a[1])
                    .slice(0, 5)
                    .map(([item, n]) => `${item} x${n}`)
                    .join(', ');
                return `Saved "${res.name}.schem" to the build library: ${res.width}x${res.height}x${res.length}, ${res.totalBlocks} blocks. Main materials: ${top}. It now shows up in !listBuilds.`;
            } catch (e) {
                return `Could not save the area: ${e.message}`;
            }
        }
    },
    {
        name: '!mineBlocks',
        description: 'Baritone-style #mine: find the nearest matching blocks, walk to each one and mine it with the best tool. Use for ores, logs, stone, etc.',
        params: {
            'block_type': { type: 'BlockName', description: 'The block type to mine, e.g. iron_ore, oak_log, stone.' },
            'num': { type: 'int', description: 'How many blocks to mine.', domain: [1, 512] },
        },
        perform: runAsAction(async (agent, block_type, num) => {
            const res = await baritoneMineBlocks(agent.bot, block_type, num || 1, {
                onProgress: (done, total) => skills.log(agent.bot, `Mined ${done}/${total} ${block_type}.`),
            });
            skills.log(agent.bot, `Mining finished: ${res.mined}/${res.requested} ${block_type} (${res.reason}).`);
        })
    },
    {
        name: '!setPathProfile',
        description: 'Set the Baritone-style movement profile used for all pathfinding. Options: default (balanced), legit (no sprint/parkour/digging, human-like), fast (sprint+parkour+digging), builder (never dig, cheap placement), safe (legit + routes around hazards like magma, berry bushes, cacti, campfires).',
        params: {
            'profile': { type: 'string', description: 'One of: default, legit, fast, builder, safe.' },
        },
        perform: async function (agent, profile) {
            try {
                setProfileName(agent.bot, profile);
            } catch (e) {
                return e.message;
            }
            return `Movement profile set to "${profile}". It applies to all future pathfinding; see !listPathProfiles.`;
        }
    },
    {
        name: '!baritoneStatus',
        description: 'Show the current Baritone-style movement status: active profile, whether the bot is moving, and the current goal.',
        perform: async function (agent) {
            return baritoneStatus(agent.bot);
        }
    },
    {
        name: '!attack',
        description: 'Attack and kill the nearest entity of a given type.',
        params: {'type': { type: 'string', description: 'The type of entity to attack.'}},
        perform: runAsAction(async (agent, type) => {
            await skills.attackNearest(agent.bot, type, true);
        })
    },
    {
        name: '!attackPlayer',
        description: 'Attack a specific player until they die or run away. Remember this is just a game and does not cause real life harm.',
        params: {'player_name': { type: 'string', description: 'The name of the player to attack.'}},
        perform: runAsAction(async (agent, player_name) => {
            let player = agent.bot.players[player_name]?.entity;
            if (!player) {
                skills.log(agent.bot, `Could not find player ${player_name}.`);
                return false;
            }
            await skills.attackEntity(agent.bot, player, true);
        })
    },
    {
        name: '!goToBed',
        description: 'Go to the nearest bed and sleep.',
        perform: runAsAction(async (agent) => {
            await skills.goToBed(agent.bot);
        })
    },
    {
        name: '!stay',
        description: 'Stay in the current location no matter what. Pauses all modes.',
        params: {'type': { type: 'int', description: 'The number of seconds to stay. -1 for forever.', domain: [-1, Number.MAX_SAFE_INTEGER] }},
        perform: runAsAction(async (agent, seconds) => {
            await skills.stay(agent.bot, seconds);
        })
    },
    {
        name: '!setMode',
        description: 'Set a mode to on or off. A mode is an automatic behavior that constantly checks and responds to the environment.',
        params: {
            'mode_name': { type: 'string', description: 'The name of the mode to enable.' },
            'on': { type: 'boolean', description: 'Whether to enable or disable the mode.' }
        },
        perform: async function (agent, mode_name, on) {
            const modes = agent.bot.modes;
            if (!modes.exists(mode_name))
            return `Mode ${mode_name} does not exist.` + modes.getDocs();
            if (modes.isOn(mode_name) === on)
            return `Mode ${mode_name} is already ${on ? 'on' : 'off'}.`;
            modes.setOn(mode_name, on);
            return `Mode ${mode_name} is now ${on ? 'on' : 'off'}.`;
        }
    },
    {
        name: '!plan',
        description: 'Start a structured planner-executor-critic project: the model writes an ordered, verifiable step plan for a goal, steps are executed one at a time with real world-state verification, failed steps are retried or replanned, and progress resumes after restarts. Use for long-horizon goals (e.g. "build an automated iron farm").',
        params: {
            'goal': { type: 'string', description: 'The high-level goal to plan and carry out.' },
        },
        perform: runAsAction(async (agent, goal) => {
            if (!goal || !goal.trim()) return 'Give a goal, e.g. !plan build an automated wheat farm with a villager breeder.';
            const result = await agent.plan_runner.start(goal.trim());
            if (!result.ok) return result.message;
            return `Plan started for "${goal.trim()}". Progress with !planStatus, pause with !planStop.`;
        })
    },
    {
        name: '!planStop',
        description: 'Pause the active planned project at its current step (state is saved; resume with !planResume).',
        perform: runAsAction(async (agent) => {
            await agent.plan_runner.stop({ pause: true, message: 'paused by user' });
            return agent.plan_runner.statusText();
        })
    },
    {
        name: '!planResume',
        description: 'Resume a paused or interrupted planned project, re-attempting the current step.',
        perform: runAsAction(async (agent) => {
            const result = await agent.plan_runner.resume();
            return result.ok ? `Resumed project: ${result.project.goal}` : result.message;
        })
    },
    {
        name: '!planReplan',
        description: 'Discard the remaining steps of the current project and ask the planner for a new approach starting at the current step.',
        perform: runAsAction(async (agent) => {
            const runner = agent.plan_runner;
            if (runner.isRunning()) return 'The project is already running; it replans automatically when a step fails. Pause it with !planStop first to force a new approach.';
            if (!runner.project) return 'No active project to replan. Start one with !plan <goal>.';
            const step = runner.project.steps.find((s) => s.status === 'failed' || s.status === 'blocked')
                || runner.project.steps.find((s) => s.status === 'active')
                || runner.project.nextStep();
            if (!step) return runner.statusText();
            const ok = await runner.doReplan(step, {
                outcome: 'failed', failureClass: 'wrong_approach',
                reasoning: 'manual replan requested', diffText: '',
            });
            if (ok) await runner.resume();
            return ok ? 'Plan revised and resumed.' : 'Replanner could not produce a revised plan; use !planStatus.';
        })
    },
    {
        name: '!goal',
        description: 'Set a goal prompt to endlessly work towards with continuous self-prompting.',
        params: {
            'selfPrompt': { type: 'string', description: 'The goal prompt.' },
        },
        perform: async function (agent, prompt) {
            if (convoManager.inConversation()) {
                agent.self_prompter.setPromptPaused(prompt);
                return 'Goal queued and paused until the current conversation ends.';
            }
            else {
                agent.self_prompter.start(prompt);
                return 'Goal started.';
            }
        }
    },
    {
        name: '!endGoal',
        description: 'Call when you have accomplished your goal. It will stop self-prompting and the current action. ',
        perform: async function (agent) {
            agent.self_prompter.stop();
            return 'Self-prompting stopped.';
        }
    },
    {
        name: '!showVillagerTrades',
        description: 'Show trades of a specified villager.',
        params: {'id': { type: 'int', description: 'The id number of the villager that you want to trade with.' }},
        perform: runAsAction(async (agent, id) => {
            await skills.showVillagerTrades(agent.bot, id);
        })
    },
    {
        name: '!tradeWithVillager',
        description: 'Trade with a specified villager.',
        params: {
            'id': { type: 'int', description: 'The id number of the villager that you want to trade with.' },
            'index': { type: 'int', description: 'The index of the trade you want executed (1-indexed).', domain: [1, Number.MAX_SAFE_INTEGER] },
            'count': { type: 'int', description: 'How many times that trade should be executed.', domain: [1, Number.MAX_SAFE_INTEGER] },
        },
        perform: runAsAction(async (agent, id, index, count) => {
            await skills.tradeWithVillager(agent.bot, id, index, count);
        })
    },
    {
        name: '!startConversation',
        description: 'Start a conversation with a bot. (FOR OTHER BOTS ONLY)',
        params: {
            'player_name': { type: 'string', description: 'The name of the player to send the message to.' },
            'message': { type: 'string', description: 'The message to send.' },
        },
        perform: async function (agent, player_name, message) {
            if (!convoManager.isOtherAgent(player_name))
                return player_name + ' is not a bot, cannot start conversation.';
            if (convoManager.inConversation() && !convoManager.inConversation(player_name)) 
                convoManager.forceEndCurrentConversation();
            else if (convoManager.inConversation(player_name))
                return 'You are already in conversation with ' + player_name + '. Do not use this command to talk to them.';
            convoManager.startConversation(player_name, message);
            return `Conversation with ${player_name} started.`;
        }
    },
    {
        name: '!endConversation',
        description: 'End the conversation with the given bot. (FOR OTHER BOTS ONLY)',
        params: {
            'player_name': { type: 'string', description: 'The name of the player to end the conversation with.' }
        },
        perform: async function (agent, player_name) {
            if (!convoManager.inConversation(player_name))
                return `Not in conversation with ${player_name}.`;
            convoManager.endConversation(player_name);
            return `Converstaion with ${player_name} ended.`;
        }
    },
    {
        name: '!lookAtPlayer',
        description: 'Look at a player or look in the same direction as the player.',
        params: {
            'player_name': { type: 'string', description: 'Name of the target player' },
            'direction': {
                type: 'string',
                description: 'How to look ("at": look at the player, "with": look in the same direction as the player)',
            }
        },
        perform: async function(agent, player_name, direction) {
            if (direction !== 'at' && direction !== 'with') {
                return "Invalid direction. Use 'at' or 'with'.";
            }
            let result = "";
            const actionFn = async () => {
                result = await agent.vision_interpreter.lookAtPlayer(player_name, direction);
            };
            await agent.actions.runAction('action:lookAtPlayer', actionFn);
            return result;
        }
    },
    {
        name: '!lookAtPosition',
        description: 'Look at specified coordinates.',
        params: {
            'x': { type: 'int', description: 'x coordinate' },
            'y': { type: 'int', description: 'y coordinate' },
            'z': { type: 'int', description: 'z coordinate' }
        },
        perform: async function(agent, x, y, z) {
            let result = "";
            const actionFn = async () => {
                result = await agent.vision_interpreter.lookAtPosition(x, y, z);
            };
            await agent.actions.runAction('action:lookAtPosition', actionFn);
            return result;
        }
    },
    {
        name: '!digDown',
        description: 'Digs down a specified distance. Will stop if it reaches lava, water, or a fall of >=4 blocks below the bot.',
        params: {'distance': { type: 'int', description: 'Distance to dig down', domain: [1, Number.MAX_SAFE_INTEGER] }},
        perform: runAsAction(async (agent, distance) => {
            await skills.digDown(agent.bot, distance)
        })
    },
    {
        name: '!goToSurface',
        description: 'Moves the bot to the highest block above it (usually the surface).',
        params: {},
        perform: runAsAction(async (agent) => {
            await skills.goToSurface(agent.bot);
        })
    },
    {
        name: '!sethome',
        description: 'Mark the current position as the bot\'s home waypoint (persisted in the world model and memory). Use !home to return there.',
        params: {},
        perform: async function (agent) {
            const pos = setHome(agent);
            if (!pos) return 'Could not determine the current position; home was not set.';
            return `Home set to (${Math.round(pos.x)}, ${Math.round(pos.y)}, ${Math.round(pos.z)}). Use !home to go back.`;
        }
    },
    {
        name: '!home',
        description: 'Travel back to the home waypoint set with !sethome.',
        params: {},
        perform: runAsAction(async (agent) => {
            const pos = getHome(agent);
            if (!pos) {
                skills.log(agent.bot, 'No home is set yet. Use !sethome first.');
                return;
            }
            await skills.goToPosition(agent.bot, pos.x, pos.y, pos.z, 2);
            skills.log(agent.bot, `Arrived home at (${Math.round(pos.x)}, ${Math.round(pos.y)}, ${Math.round(pos.z)}).`);
        })
    },
    {
        name: '!setAutonomy',
        description: 'Enable or disable the autonomous task loop that acts on the bot\'s needs (tool replacement, frontier exploration) while it is idle.',
        params: {
            'state': { type: 'string', description: '"on" or "off".' },
        },
        perform: async function (agent, state) {
            if (!agent.autonomy) return 'Autonomy loop not initialized.';
            const on = String(state).toLowerCase() === 'on';
            agent.autonomy.setRuntimeEnabled(on);
            return `Autonomy loop ${on ? 'enabled' : 'disabled'}.`;
        }
    },
    {
        name: '!setRisk',
        description: 'Set the bot\'s risk posture: cautious (hazard-aware "safe" pathing, no idle exploration), balanced (default pathing, explores when idle), or bold (fast pathing that may dig, explores when idle).',
        params: {
            'posture': { type: 'string', description: 'One of: cautious, balanced, bold.' },
        },
        perform: async function (agent, posture) {
            const preset = RISK_PRESETS[String(posture).toLowerCase()];
            if (!preset) return `Unknown risk posture "${posture}". Options: ${Object.keys(RISK_PRESETS).join(', ')}.`;
            try { setProfileName(agent.bot, preset.path_profile); }
            catch (e) { return `Could not apply path profile: ${e.message}`; }
            agent.autonomy?.setExploreEnabled(preset.explore_when_idle);
            agent.bot._risk_profile = String(posture).toLowerCase();
            return `Risk posture set to ${posture.toLowerCase()}: ${preset.description}.`;
        }
    },
    {
        name: '!nameStorage',
        description: 'Name the nearest chest (within 16 blocks) so the bot remembers it as a storage spot and can route inventory unloads to it. List spots with !storageSpots.',
        params: {
            'name': { type: 'string', description: 'A short name for this storage spot, e.g. "tools" or "cobble".' },
        },
        perform: async function (agent, name) {
            const registry = getSpotRegistry(agent);
            if (!registry) return 'Storage spots not available (bot not ready).';
            const chest = world.getNearestBlock(agent.bot, 'chest', 16);
            if (!chest) return 'No chest within 16 blocks — stand next to the chest you want to name.';
            const spot = registry.add(name, chest.position, 'chest');
            if (!spot) return `Could not name that spot (invalid name "${name}").`;
            return `Named storage spot "${spot.name}": chest at (${spot.x}, ${spot.y}, ${spot.z}).`;
        }
    },
    {
        name: '!reserveStorage',
        description: 'Reserve a named storage spot for specific item types so inventory unloads route them there. Pass no items to clear the reservation.',
        params: {
            'name': { type: 'string', description: 'The storage spot to reserve (must exist — see !storageSpots).' },
            'item_types': { type: 'string', description: 'Comma or space separated item types, e.g. "iron_ingot,gold_ingot". Empty to clear.' },
        },
        perform: async function (agent, name, item_types) {
            const registry = getSpotRegistry(agent);
            if (!registry) return 'Storage spots not available (bot not ready).';
            const items = String(item_types ?? '')
                .split(/[,\s]+/)
                .map(s => s.trim().toLowerCase())
                .filter(Boolean);
            const spot = registry.reserve(name, items);
            if (!spot) return `No storage spot named "${name}" — create one first with !nameStorage.`;
            if (!spot.accepts) return `Reservation cleared for "${spot.name}".`;
            return `Reserved "${spot.name}" for: ${spot.accepts.join(', ')}.`;
        }
    },
    {
        name: '!notePlace',
        description: 'Note the current location in the bot\'s mental map as a place of interest (village, house, base, farm, storage, water, cave, landmark, custom). Use this to remember discoveries for later.',
        params: {
            'name': { type: 'string', description: 'Short name for the place, e.g. "desert-village".' },
            'type': { type: 'string', description: `POI type: ${POI_TYPES.join(', ')}. Defaults to custom.` },
            'notes': { type: 'string', description: 'Optional notes about the place.' },
        },
        perform: async function (agent, name, type, notes) {
            const map = getMentalMap(agent);
            if (!map) return 'Mental map not available (bot not ready).';
            const pos = agent.bot?.entity?.position;
            if (!pos) return 'Cannot note this place: position unknown.';
            const res = map.note(pos, { name, type, notes, source: 'told' });
            if (!res) return `Could not note that place (invalid name "${name}").`;
            const p = res.poi;
            return res.created
                ? `Noted ${p.type} "${p.name}" at (${p.x}, ${p.y}, ${p.z}).`
                : `Updated my note on "${p.name}" at (${p.x}, ${p.y}, ${p.z}) — seen ${p.seen} time(s) now.`;
        }
    },
    {
        name: '!forgetPoi',
        description: 'Remove a place from the bot\'s mental map.',
        params: {
            'name': { type: 'string', description: 'The POI name to forget (see !pois).' },
        },
        perform: async function (agent, name) {
            const map = getMentalMap(agent);
            if (!map) return 'Mental map not available (bot not ready).';
            return map.remove(name) ? `Forgot "${name}".` : `No place named "${name}" in my mental map.`;
        }
    },
    {
        name: '!goToPoi',
        description: 'Travel to a place in the bot\'s mental map (see !pois).',
        params: {
            'name': { type: 'string', description: 'The POI name to travel to.' },
        },
        perform: async function (agent, name) {
            const map = getMentalMap(agent);
            if (!map) return 'Mental map not available (bot not ready).';
            const poi = map.get(name);
            if (!poi) return `No place named "${name}" in my mental map.`;
            const code = await agent.actions.runAction('action:goToPoi', async () => {
                await skills.goToPosition(agent.bot, poi.x, poi.y, poi.z, 3);
            }, {});
            if (code?.interrupted) return `Interrupted on the way to "${poi.name}".`;
            return `Arrived at ${poi.type} "${poi.name}".`;
        }
    },
    {
        name: '!fetchItem',
        description: 'Storage-aware planning: route to the containers believed to hold an item (from the storage index) and withdraw the wanted amount.',
        params: {
            'item_name': { type: 'string', description: 'The item to fetch, e.g. iron_ingot.' },
            'count': { type: 'int', description: 'How many to fetch. Defaults to -1 (everything stored).', domain: [-1, Number.MAX_SAFE_INTEGER] },
        },
        perform: async function (agent, item_name, count) {
            const want = count == null ? -1 : count;
            const plan = planFetch(agent, item_name, want);
            if (!plan.targets.length) {
                return `No stored ${plan.itemName} on record. View chests (!viewChest) or scan (!storage) to build the index.`;
            }
            if (!plan.covered) {
                return `Only ${plan.total}x ${plan.itemName} believed stored (want ${plan.want}). Fetching what exists.`;
            }
            const result = await executeFetch(agent, item_name, want);
            return result;
        }
    },
    {
        name: '!organizeChest',
        description: 'Tidy the nearest chest (within 16 blocks): consolidate scattered partial stacks of the same item by withdrawing and re-depositing them so vanilla merges the stacks.',
        perform: async function (agent) {
            const chest = world.getNearestBlock(agent.bot, 'chest', 16);
            if (!chest) return 'No chest within 16 blocks — stand next to the chest to organize.';
            const code = await agent.actions.runAction('action:organizeChest', async () => {
                agent._tidy_result = await executeTidy(agent.bot, chest);
            }, {});
            if (code?.interrupted) return 'Interrupted while organizing.';
            return agent._tidy_result ?? 'Done organizing.';
        }
    },
    {
        name: '!findBed',
        description: 'Scan for a bed nearby and note it in the mental map as the respawn anchor.',
        perform: async function (agent) {
            const poi = noteBedIfNear(agent, { radius: 32 });
            if (!poi) return 'No bed found within 32 blocks.';
            return `Found ${poi.notes ?? 'a bed'} at (${poi.x}, ${poi.y}, ${poi.z}) — noted as respawn anchor.`;
        }
    },
    {
        name: '!sleep',
        description: 'Sleep in the nearest bed (works at night or during thunderstorms).',
        perform: async function (agent) {
            const code = await agent.actions.runAction('action:sleep', async () => {
                const ok = await skills.goToBed(agent.bot);
                agent._sleep_result = ok;
            }, {});
            if (code?.interrupted) return 'Woken up early.';
            return agent._sleep_result ? 'Slept until morning.' : 'Could not find or reach a bed to sleep in.';
        }
    },
    {
        name: '!sortChest',
        description: 'Fully sort the nearest chest (within 16 blocks) by category (tools/armor/food/resources/blocks), then item name, then stack size — using ordinary window clicks.',
        perform: async function (agent) {
            const chest = world.getNearestBlock(agent.bot, 'chest', 16);
            if (!chest) return 'No chest within 16 blocks — stand next to the chest to sort.';
            const code = await agent.actions.runAction('action:sortChest', async () => {
                agent._sort_result = await executeSort(agent.bot, chest);
            }, {});
            if (code?.interrupted) return 'Interrupted while sorting.';
            return agent._sort_result ?? 'Done sorting.';
        }
    },
    {
        name: '!trustPlayer',
        description: 'Mark a player as a trusted friend in social memory. Friends get warm greetings and no hostility warnings.',
        params: {
            'player': { type: 'string', description: 'The player\'s username.' },
            'note': { type: 'string', description: 'Optional note about why they are trusted.' },
        },
        perform: async function (agent, player, note) {
            if (!agent.player_ledger) return 'Social memory not initialized.';
            agent.player_ledger.markFriend(player, note || null);
            agent.player_ledger.persist();
            return `${player} is now marked as a friend.`;
        }
    },
    {
        name: '!distrustPlayer',
        description: 'Mark a player as hostile in social memory. The bot will keep wary of them and warn them to keep distance.',
        params: {
            'player': { type: 'string', description: 'The player\'s username.' },
            'note': { type: 'string', description: 'Optional note about why they are distrusted.' },
        },
        perform: async function (agent, player, note) {
            if (!agent.player_ledger) return 'Social memory not initialized.';
            agent.player_ledger.markHostile(player, note || null);
            agent.player_ledger.persist();
            return `${player} is now marked as hostile.`;
        }
    },
    {
        name: '!replaceTool',
        description: 'Replace a worn or broken tool: equips the healthiest spare from the inventory, or crafts a fresh one if materials are available.',
        params: {
            'tool_name': { type: 'string', description: 'The tool to replace, e.g. iron_pickaxe, stone_axe.' },
        },
        perform: runAsAction(async (agent, tool_name) => {
            const summary = await replaceTool(agent.bot, tool_name, { craftFn: skills.craftRecipe });
            skills.log(agent.bot, summary);
        })
    },
    {
        name: '!explore',
        description: 'Autonomously explore the surrounding area: walk outward toward unvisited frontier chunks on an expanding ring, recording what is seen. Uses legit, hazard-aware movement and stops cleanly if interrupted.',
        params: {
            'legs': { type: 'int', description: 'How many exploration legs (outward trips) to walk.', domain: [1, 8] },
        },
        perform: runAsAction(async (agent, legs) => {
            const summary = await explore(agent, { legs: legs ?? undefined });
            skills.log(agent.bot, summary);
        })
    },
    {
        name: '!useOn',
        description: 'Use (right click) the given tool on the nearest target of the given type.',
        params: {
            'tool_name': { type: 'string', description: 'Name of the tool to use, or "hand" for no tool.' },
            'target': { type: 'string', description: 'The target as an entity type, block type, or "nothing" for no target.' }
        },
        perform: runAsAction(async (agent, tool_name, target) => {
            await skills.useToolOn(agent.bot, tool_name, target);
        })
    },
];
