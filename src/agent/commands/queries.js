import * as world from '../library/world.js';
import * as mc from '../../utils/mcdata.js';
import { getCommandDocs } from './index.js';
import convoManager from '../conversation.js';
import { checkLevelBlueprint, checkBlueprint } from '../tasks/construction_tasks.js';
import { library, formatMaterialCounts } from '../schematics/library.js';
import { load } from 'cheerio';
import * as radarModule from '../sensors/radar.js';
import { previewPath, status as baritoneStatus } from '../baritone/baritone.js';
import { GoalBlock } from '../baritone/goals.js';
import { profileDocs, getProfileName } from '../baritone/settings.js';
import { getStorageIndex, saveStorageIndex } from '../storage/index.js';
import { getSpotRegistry } from '../storage/placement.js';
import { getHome } from '../navigation/home.js';
import { hazardReport, scanHazards } from '../navigation/hazards.js';
import * as skills from '../library/skills.js';
import { toolsReport } from '../library/durability.js';

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
            return pad(radarModule.radarReport(agent.bot));
        }
    },
    {
        name: "!hazards",
        description: "Scan the local area for navigation hazards (lava, fire, magma, berry bushes, cacti, campfires, soul sand, cobwebs) with positions and distances. Useful before building or pathing somewhere.",
        params: {
            'radius': { type: 'int', description: 'Scan radius in blocks (1-24, default 12).', domain: [1, 24] },
        },
        perform: function (agent, radius) {
            return pad(hazardReport(agent.bot, { radius: radius || 12 }));
        }
    },
    {
        name: "!routeCache",
        description: "Show the navigation route cache (successful paths remembered to skip pathfinding on repeat trips), or clear it.",
        params: {
            'action': { type: 'string', description: 'Optional: pass "clear" to empty the cache; otherwise shows stats.' },
        },
        perform: function (agent, action) {
            if (String(action || '').toLowerCase() === 'clear') {
                const n = skills.clearRouteCache(agent.bot);
                return pad(`Route cache cleared (${n} route(s) dropped).`);
            }
            const stats = skills.routeCacheStats(agent.bot);
            if (!stats) return pad('Route caching is disabled (settings.navigation.route_cache.enabled).');
            return pad(`Route cache: ${stats.entries}/${stats.maxEntries} routes remembered (TTL ${Math.round(stats.ttlMs / 60000)} min). Stored at ${stats.file}.`);
        }
    },
    {
        name: "!tools",
        description: "Report the durability of every tool in the inventory, flagging worn/broken ones and whether replacements are craftable or which materials are missing.",
        perform: function (agent) {
            return pad(toolsReport(agent.bot));
        }
    },
    {
        name: "!autonomyStatus",
        description: "Show the autonomous task loop status: on/off, cooldown, last run, current needs, and recent action history. Use !setAutonomy to toggle.",
        perform: function (agent) {
            if (!agent.autonomy) return pad('Autonomy loop not initialized.');
            return pad(agent.autonomy.summarize());
        }
    },
    {
        name: "!social",
        description: "Show social memory: every player the bot remembers with trust level (friend/neutral/hostile), sighting counts, and last distance. Use !trustPlayer / !distrustPlayer to update trust.",
        perform: function (agent) {
            if (!agent.player_ledger) return pad('Social memory not initialized.');
            return pad(agent.player_ledger.summarize());
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
        name: "!storage",
        description: "Show the storage index: every container the bot has opened or scanned, where it is, and what was last seen inside.",
        perform: function (agent) {
            const index = getStorageIndex(agent);
            // Seed positions of unopened containers from the legit radar scan.
            try {
                const { storageScan } = radarModule;
                const scan = storageScan(agent.bot, 24);
                for (const c of scan.positions) index.notePosition(c.type, { x: c.x, y: c.y, z: c.z });
            } catch { /* scan is an optional enrichment */ }
            saveStorageIndex(agent);
            return pad(index.render());
        }
    },
    {
        name: "!findItem",
        description: "Look up where an item is believed to be stored: searches the container index and reports every container holding it with counts and positions.",
        params: {
            'item_name': { type: 'string', description: 'The item to locate, e.g. iron_ingot.' },
        },
        perform: function (agent, item_name) {
            const index = getStorageIndex(agent);
            const hits = index.findItem(item_name);
            if (hits.length === 0) {
                return pad(`No indexed container is known to hold ${item_name}. Open or view chests (!viewChest) to build the index, or check the inventory with !inventory.`);
            }
            const lines = [`${item_name} found in ${hits.length} container(s):`];
            for (const h of hits) {
                lines.push(`- ${h.type} at (${h.x}, ${h.y}, ${h.z}): x${h.count}`);
            }
            return pad(lines.join('\n'));
        }
    },
    {
        name: "!storageSpots",
        description: "List the bot's named storage spots (from !nameStorage) that it routes deposits to when unloading its inventory.",
        perform: function (agent) {
            const registry = getSpotRegistry(agent);
            if (!registry) return pad('Storage spots not available (bot not ready).');
            const spots = registry.list();
            if (!spots.length) return pad('No named storage spots yet. Point the bot at a chest with !nameStorage <name>.');
            const lines = [`STORAGE SPOTS (${spots.length})`];
            for (const s of spots) {
                lines.push(`- ${s.name}: ${s.type} at (${s.x}, ${s.y}, ${s.z})`);
            }
            return pad(lines.join('\n'));
        }
    },
    {
        name: "!memory",
        description: "Inspect the bot's memory: saved places, the home waypoint, and a summary of the persistent world model.",
        perform: function (agent) {
            const lines = ['MEMORY'];
            const keys = agent.memory_bank?.getKeys?.() || '';
            lines.push(keys ? `Saved places: ${keys}` : 'Saved places: none');
            const home = getHome(agent);
            lines.push(home
                ? `Home: (${home.x}, ${home.y}, ${home.z})`
                : 'Home: not set (use !sethome)');
            try {
                if (agent.world_model?.render) {
                    lines.push('', agent.world_model.render().split('\n').slice(0, 12).join('\n'));
                }
            } catch { /* world model optional */ }
            return pad(lines.join('\n'));
        }
    },
    {
        name: "!status",
        description: "Unified status: current action, health/hunger/position, movement profile and goal, plan progress, and nearby players in one report.",
        perform: function (agent) {
            const bot = agent.bot;
            const lines = ['STATUS'];

            // Self
            const pos = bot.entity?.position;
            const action = agent.isIdle?.() ? 'Idle' : (agent.actions?.currentActionLabel || 'Acting');
            lines.push(`Action: ${action}`);
            if (pos) lines.push(`Position: (${pos.x.toFixed(1)}, ${pos.y.toFixed(1)}, ${pos.z.toFixed(1)})`);
            lines.push(`Health: ${Math.round(bot.health ?? 0)}/20, Hunger: ${Math.round(bot.food ?? 0)}/20`);

            // Humanlike behavior layer (state machine + attention)
            try {
                const fsm = agent.behavior_state;
                if (fsm) {
                    let line = `Behavior: state=${fsm.current}`;
                    if (fsm.activity) line += `, doing=${fsm.activity}`;
                    if (fsm.hasPendingResume?.()) line += `, will-resume=${fsm.peekPendingResume()}`;
                    lines.push(line);
                }
                const attn = agent.attention?.summarize?.();
                if (attn) lines.push(`Attention: ${attn.players} player(s), ${attn.mobs} mob(s), ${attn.items} item(s) seen recently`);
                if (agent.personality) lines.push(`Personality: ${agent.personality.preset} (seed ${agent.personality.seed})`);
                if (agent.autonomy) {
                    const last = agent.autonomy.lastRun;
                    lines.push(`Autonomy: ${agent.autonomy.enabled ? 'on' : 'off'}${last ? `, last=${last.kind}` : ''}`);
                }
            } catch { /* behavior layer optional */ }

            // Navigation (Baritone layer)
            try {
                lines.push(`Navigation: ${baritoneStatus(bot)}`);
            } catch { /* pathfinder not loaded */ }

            // Plan
            try {
                if (agent.plan_runner?.statusText) {
                    const plan = String(agent.plan_runner.statusText()).split('\n').filter(Boolean);
                    lines.push(`Plan: ${plan[0] || 'none'}`);
                }
            } catch { /* no plan runner */ }

            // Nearby players (radar)
            try {
                const { playerIntel } = radarModule;
                const players = playerIntel(bot, 64);
                lines.push(players.length
                    ? `Nearby players: ${players.map(p => `${p.username} ${p.distance}m ${p.bearing}`).join(', ')}`
                    : 'Nearby players: none in range');
            } catch { /* radar optional */ }

            return pad(lines.join('\n'));
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
