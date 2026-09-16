import * as world from '../library/world.js';
import * as mc from '../../utils/mcdata.js';
import { getCommandDocs } from './index.js';
import convoManager from '../conversation.js';
import { checkLevelBlueprint, checkBlueprint } from '../tasks/construction_tasks.js';
import { library, formatMaterialCounts } from '../schematics/library.js';
import { load } from 'cheerio';
import { radarReport } from '../sensors/radar.js';
import { previewPath } from '../baritone/baritone.js';
import { GoalBlock } from '../baritone/goals.js';
import { profileDocs, getProfileName } from '../baritone/settings.js';

const pad = (str) => {
    return '\n' + str + '\n';
}

// queries are commands that just return strings and don't affect anything in the world
export const queryList = [
    {
        name: "!stats",
        description: "Get your bot's location, health, hunger, and time of day.", 
        perform: function (agent) {
            let bot = agent.bot;
            let res = 'STATS';
            let pos = bot.entity.position;
            // display position to 2 decimal places
            res += `\n- Position: x: ${pos.x.toFixed(2)}, y: ${pos.y.toFixed(2)}, z: ${pos.z.toFixed(2)}`;
            // Gameplay
            res += `\n- Gamemode: ${bot.game.gameMode}`;
            res += `\n- Health: ${Math.round(bot.health)} / 20`;
            res += `\n- Hunger: ${Math.round(bot.food)} / 20`;
            res += `\n- Biome: ${world.getBiomeName(bot)}`;
            let weather = "Clear";
            if (bot.rainState > 0)
                weather = "Rain";
            if (bot.thunderState > 0)
                weather = "Thunderstorm";
            res += `\n- Weather: ${weather}`;
            // let block = bot.blockAt(pos);
            // res += `\n- Artficial light: ${block.skyLight}`;
            // res += `\n- Sky light: ${block.light}`;
            // light properties are bugged, they are not accurate


            if (bot.time.timeOfDay < 6000) {
                res += '\n- Time: Morning';
            } else if (bot.time.timeOfDay < 12000) {
                res += '\n- Time: Afternoon';
            } else {
                res += '\n- Time: Night';
            }

            // get the bot's current action
            let action = agent.actions.currentActionLabel;
            if (agent.isIdle())
                action = 'Idle';
            res += `\- Current Action: ${action}`;


            let players = world.getNearbyPlayerNames(bot);
            let bots = convoManager.getInGameAgents().filter(b => b !== agent.name);
            players = players.filter(p => !bots.includes(p));

            res += '\n- Nearby Human Players: ' + (players.length > 0 ? players.join(', ') : 'None.');
            res += '\n- Nearby Bot Players: ' + (bots.length > 0 ? bots.join(', ') : 'None.');

            res += '\n' + agent.bot.modes.getMiniDocs() + '\n';
            return pad(res);
        }
    },
    {
        name: "!inventory",
        description: "Get your bot's inventory.",
        perform: function (agent) {
            let bot = agent.bot;
            let inventory = world.getInventoryCounts(bot);
            let res = 'INVENTORY';
            for (const item in inventory) {
                if (inventory[item] && inventory[item] > 0)
                    res += `\n- ${item}: ${inventory[item]}`;
            }
            if (res === 'INVENTORY') {
                res += ': Nothing';
            }
            else if (agent.bot.game.gameMode === 'creative') {
                res += '\n(You have infinite items in creative mode. You do not need to gather resources!!)';
            }

            let helmet = bot.inventory.slots[5];
            let chestplate = bot.inventory.slots[6];
            let leggings = bot.inventory.slots[7];
            let boots = bot.inventory.slots[8];
            res += '\nWEARING: ';
            if (helmet)
                res += `\nHead: ${helmet.name}`;
            if (chestplate)
                res += `\nTorso: ${chestplate.name}`;
            if (leggings)
                res += `\nLegs: ${leggings.name}`;
            if (boots)
                res += `\nFeet: ${boots.name}`;
            if (!helmet && !chestplate && !leggings && !boots)
                res += 'Nothing';

            return pad(res);
        }
    },
    {
        name: "!nearbyBlocks",
        description: "Get the blocks near the bot.",
        perform: function (agent) {
            let bot = agent.bot;
            let res = 'NEARBY_BLOCKS';
            let blocks = world.getNearestBlocks(bot);
            let block_details = new Set();
            
            for (let block of blocks) {
                let details = block.name;
                if (block.name === 'water' || block.name === 'lava') {
                    details += block.metadata === 0 ? ' (source)' : ' (flowing)';
                }
                block_details.add(details);
            }
            for (let details of block_details) {
                res += `\n- ${details}`;
            }
            if (block_details.size === 0) {
                res += ': none';
            } 
            else {
                res += '\n- ' + world.getSurroundingBlocks(bot).join('\n- ');
                res += `\n- First Solid Block Above Head: ${world.getFirstBlockAboveHead(bot, null, 32)}`;
            }
            return pad(res);
        }
    },
    {
        name: "!craftable",
        description: "Get the craftable items with the bot's inventory.",
        perform: function (agent) {
            let craftable = world.getCraftableItems(agent.bot);
            let res = 'CRAFTABLE_ITEMS';
            for (const item of craftable) {
                res += `\n- ${item}`;
            }
            if (res == 'CRAFTABLE_ITEMS') {
                res += ': none';
            }
            return pad(res);
        }
    },
    {
        name: "!entities",
        description: "Get the nearby players and entities.",
        perform: function (agent) {
            let bot = agent.bot;
            let res = 'NEARBY_ENTITIES';
            let players = world.getNearbyPlayerNames(bot);
            let bots = convoManager.getInGameAgents().filter(b => b !== agent.name);
            players = players.filter(p => !bots.includes(p));

            for (const player of players) {
                res += `\n- Human player: ${player}`;
            }
            for (const bot of bots) {
                res += `\n- Bot player: ${bot}`;
            }

            let nearbyEntities = world.getNearbyEntities(bot);
            let entityCounts = {};
            let villagerIds = [];
            let babyVillagerIds = [];
            let villagerDetails = []; // Store detailed villager info including profession
            
            for (const entity of nearbyEntities) {
                if (entity.type === 'player' || entity.name === 'item')
                    continue;
                    
                if (!entityCounts[entity.name]) {
                    entityCounts[entity.name] = 0;
                }
                entityCounts[entity.name]++;
                
                if (entity.name === 'villager') {
                    if (entity.metadata && entity.metadata[16] === 1) {
                        babyVillagerIds.push(entity.id);
                    } else {
                        const profession = world.getVillagerProfession(entity);
                        villagerIds.push(entity.id);
                        villagerDetails.push({
                            id: entity.id,
                            profession: profession
                        });
                    }
                }
            }
            
            for (const [entityType, count] of Object.entries(entityCounts)) {
                if (entityType === 'villager') {
                    let villagerInfo = `${count} ${entityType}(s)`;
                    if (villagerDetails.length > 0) {
                        const detailStrings = villagerDetails.map(v => `(${v.id}:${v.profession})`);
                        villagerInfo += ` - Adults: ${detailStrings.join(', ')}`;
                    }
                    if (babyVillagerIds.length > 0) {
                        villagerInfo += ` - Baby IDs: ${babyVillagerIds.join(', ')} (babies cannot trade)`;
                    }
                    res += `\n- entities: ${villagerInfo}`;
                } else {
                    res += `\n- entities: ${count} ${entityType}(s)`;
                }
            }
            
            if (res == 'NEARBY_ENTITIES') {
                res += ': none';
            }
            return pad(res);
        }
    },
    {
        name: "!radar",
        description: "Radar sweep: exact positions, distances and compass bearings of nearby players, mobs, dropped items and storage containers. Use this to know WHERE everyone and everything is.",
        perform: function (agent) {
            return pad(radarReport(agent.bot));
        }
    },
    {
        name: "!previewPath",
        description: "Preview a path to the given coordinates WITHOUT moving (Baritone #calc): reports whether a path exists and how long it is under the current movement profile.",
        params: {
            'x': { type: 'float', description: 'The x coordinate to path to.', domain: [-Infinity, Infinity] },
            'y': { type: 'float', description: 'The y coordinate to path to.', domain: [-64, 320] },
            'z': { type: 'float', description: 'The z coordinate to path to.', domain: [-Infinity, Infinity] },
        },
        perform: function (agent, x, y, z) {
            const res = previewPath(agent.bot, new GoalBlock(x, y, z));
            if (res.status === 'error') return pad(`Path preview failed: ${res.error}`);
            if (res.ok) {
                return pad(`Path preview [${res.profile}] to (${x}, ${y}, ${z}): SUCCESS — ${res.nodes} steps, cost ${Number(res.cost).toFixed(1)}, computed in ${res.timeMs}ms.`);
            }
            return pad(`Path preview [${res.profile}] to (${x}, ${y}, ${z}): ${res.status} after ${res.timeMs}ms — no usable path right now. Try !setPathProfile("fast") or different coordinates.`);
        }
    },
    {
        name: "!listPathProfiles",
        description: "List the Baritone-style movement profiles (default, legit, fast, builder) and which one is active. Change it with !setPathProfile.",
        perform: function (agent) {
            return pad('Movement profiles:\n' + profileDocs(getProfileName(agent.bot)));
        }
    },
    {
        name: "!modes",
        description: "Get all available modes and their docs and see which are on/off.",
        perform: function (agent) {
            return agent.bot.modes.getDocs();
        }
    },
    {
        name: '!savedPlaces',
        description: 'List all saved locations.',
        perform: async function (agent) {
            return "Saved place names: " + agent.memory_bank.getKeys();
        }
    }, 
    {
        name: '!checkBlueprintLevel',
        description: 'Check if the level is complete and what blocks still need to be placed for the blueprint',
        params: {
            'levelNum': { type: 'int', description: 'The level number to check.', domain: [0, Number.MAX_SAFE_INTEGER] }
        },
        perform: function (agent, levelNum) {
            let res = checkLevelBlueprint(agent, levelNum);
            console.log(res);
            return pad(res);
        }
    }, 
    {
        name: '!checkBlueprint',
        description: 'Check what blocks still need to be placed for the blueprint',
        perform: function (agent) {
            let res = checkBlueprint(agent);
            return pad(res);
        }
    }, 
    {
        name: '!getBlueprint',
        description: 'Get the blueprint for the building',
        perform: function (agent) {
            let res = agent.task.blueprint.explain();
            return pad(res);
        }
    }, 
    {
        name: '!getBlueprintLevel',
        description: 'Get the blueprint for the building',
        params: {
            'levelNum': { type: 'int', description: 'The level number to check.', domain: [0, Number.MAX_SAFE_INTEGER] }
        },
        perform: function (agent, levelNum) {
            let res = agent.task.blueprint.explainLevel(levelNum);
            console.log(res);
            return pad(res);
        }
    },
    {
        name: '!getCraftingPlan',
        description: "Provides a comprehensive crafting plan for a specified item. This includes a breakdown of required ingredients, the exact quantities needed, and an analysis of missing ingredients or extra items needed based on the bot's current inventory.",
        params: {
            targetItem: { 
                type: 'string', 
                description: 'The item that we are trying to craft' 
            },
            quantity: { 
                type: 'int',
                description: 'The quantity of the item that we are trying to craft',
                optional: true,
                domain: [1, Infinity, '[)'], // Quantity must be at least 1,
                default: 1
            }
        },
        perform: function (agent, targetItem, quantity = 1) {
            let bot = agent.bot;

            // Fetch the bot's inventory
            const curr_inventory = world.getInventoryCounts(bot); 
            const target_item = targetItem;
            let existingCount = curr_inventory[target_item] || 0;
            let prefixMessage = '';
            if (existingCount > 0) {
                curr_inventory[target_item] -= existingCount;
                prefixMessage = `You already have ${existingCount} ${target_item} in your inventory. If you need to craft more,\n`;
            }

            // Generate crafting plan
            try {
                let craftingPlan = mc.getDetailedCraftingPlan(target_item, quantity, curr_inventory);
                craftingPlan = prefixMessage + craftingPlan;
                return pad(craftingPlan);
            } catch (error) {
                console.error("Error generating crafting plan:", error);
                return `An error occurred while generating the crafting plan: ${error.message}`;
            }
            
            
        },
    },
    {
        name: '!searchWiki',
        description: 'Search the Minecraft Wiki for the given query.',
        params: {
            'query': { type: 'string', description: 'The query to search for.' }
        },
        perform: async function (agent, query) {
            const url = `https://minecraft.wiki/w/${query}`
            try {
                const response = await fetch(url);
                if (response.status === 404) {
                  return `${query} was not found on the Minecraft Wiki. Try adjusting your search term.`;
                }
                const html = await response.text();
                const $ = load(html);
            
                const parserOutput = $("div.mw-parser-output");
                
                parserOutput.find("table.navbox").remove();

                const divContent = parserOutput.text();
            
                return divContent.trim();
              } catch (error) {
                console.error("Error fetching or parsing HTML:", error);
                return `The following error occurred: ${error}`
              }
        }
    },
    {
        name: '!help',
        description: 'Lists all available commands and their descriptions.',
        perform: async function (agent) {
            return getCommandDocs(agent);
        }
    },
    {
        name: '!planStatus',
        description: 'Show the current planner project: goal, each step with its status (done/active/pending/failed/blocked), progress percentage and critic notes.',
        perform: async function (agent) {
            return pad(agent.plan_runner.statusText());
        }
    },
    {
        name: '!world',
        description: 'Show the persistent world model: self state, active project, known locations, structures, resource deposits, mobs/NPCs, fresh threats and proven recipes, with distances and last-seen ages.',
        perform: async function (agent) {
            if (!agent.world_model) return 'World model unavailable.';
            return pad(agent.world_model.render());
        }
    },
    {
        name: '!where',
        description: 'Query the persistent world model for the nearest known thing, e.g. !where village, !where iron, !where zombie, !where crafting_table. Also accepts a category: !where resources.',
        params: {
            'thing': { type: 'string', description: 'A location/resource/mob/structure name or category (locations, resources, threats, structures, entities, recipes).' },
        },
        perform: async function (agent, thing) {
            if (!agent.world_model) return 'World model unavailable.';
            return pad(agent.world_model.render(String(thing || '').trim()));
        }
    },
    {
        name: '!listBuilds',
        description: 'List every build in the schematic library (Litematica .litematic, Sponge .schem, vanilla structure .nbt and blueprint .json files) with dimensions, block count and main materials.',
        perform: async function () {
            const names = library.scan();
            if (names.length === 0) {
                return pad('The build library is empty. Drop schematic files into the configured schematic_library folder (default ./schematics), then try again.');
            }
            const lines = [`Build library (${names.length}):`];
            for (const name of names) {
                const info = await library.describe(name);
                if (!info) continue;
                const mats = formatMaterialCounts(info.materials, 6);
                lines.push(`- ${info.name} [${info.format}, ${info.width}x${info.height}x${info.length}, ${info.total} blocks]: ${mats}`);
            }
            return pad(lines.join('\n'));
        }
    },
    {
        name: '!buildMaterials',
        description: 'Get the full material list and dimensions of a library build before gathering blocks.',
        params: {
            'name': { type: 'string', description: 'Library build name (filename with or without extension).' },
        },
        perform: async function (agent, name) {
            const info = await library.describe(name);
            if (!info) {
                const names = library.scan();
                return pad(`No build named "${name}". Available: ${names.join(', ')}`);
            }
            const lines = [`${info.name} [${info.format}] ${info.width}x${info.height}x${info.length}, ${info.total} blocks total`];
            if (info.author) lines.push(`Author: ${info.author}`);
            if (info.description) lines.push(info.description);
            lines.push('Materials:');
            const mats = Object.entries(info.materials).sort((a, b) => b[1] - a[1]);
            for (const [block, n] of mats) lines.push(`- ${block} x${n}`);
            if (Object.keys(info.skipped).length > 0) {
                lines.push('Cannot be placed (no block item, skipped at build): ' + formatMaterialCounts(info.skipped, 50));
            }
            return pad(lines.join('\n'));
        }
    },
];
