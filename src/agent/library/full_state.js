/**
 * full_state.js — resilient version without top-level await cycles.
 */

import { playerPositionSnapshot, groundItems } from '../sensors/radar.js';
import { dangerSummary } from '../sensors/danger.js';

let _world = null;
let _convoManager = null;

async function loadWorld() {
    if (_world) return _world;
    try {
        const mod = await import("./world.js");
        _world = mod;
    } catch {
        _world = {
            getPosition: (bot) => bot.entity.position,
            getBiomeName: () => 'unknown',
            getNearbyPlayerNames: () => [],
            getInventoryCounts: (bot) => {
                const inv = {};
                for (const slot of bot.inventory.slots || []) if (slot?.name) inv[slot.name] = (inv[slot.name]||0)+slot.count;
                return inv;
            },
            getNearbyEntityTypes: () => [],
            getBlockAtPosition: (bot, x=0,y=0,z=0) => {
                try { return bot.blockAt(bot.entity.position.offset(x,y,z)) || {name:'air'}; } catch { return {name:'air'}; }
            },
            getFirstBlockAboveHead: () => 'none',
        };
    }
    return _world;
}

async function loadConvo() {
    if (_convoManager) return _convoManager;
    try {
        const mod = await import('../conversation.js');
        _convoManager = mod.default || mod;
    } catch {
        _convoManager = { getInGameAgents: () => [], inConversation: () => false };
    }
    return _convoManager;
}

/** Radar player positions, never throwing (sensors must not break state). */
function safePlayerPositions(bot) {
    try {
        return playerPositionSnapshot(bot, 64, 8);
    } catch {
        return [];
    }
}

/** Radar ground items, reduced to a compact counts map so state stays small. */
function safeGroundItems(bot) {
    try {
        const items = groundItems(bot, 16);
        const counts = {};
        for (const it of items) counts[it.item] = (counts[it.item] || 0) + (it.count || 1);
        return counts;
    } catch {
        return {};
    }
}

/** Danger awareness for the LLM: monsters, hazards, darkness — never throws. */
function safeDanger(bot) {
    try {
        return dangerSummary(bot, {});
    } catch {
        return null;
    }
}

export function getFullState(agent) {
    const bot = agent.bot;
    // Use cached world if available, otherwise fallback
    const world = _world || {
        getPosition: (b) => b.entity.position,
        getBiomeName: () => 'unknown',
        getNearbyPlayerNames: () => [],
        getInventoryCounts: (b) => {
            const inv = {};
            for (const slot of b.inventory.slots || []) if (slot?.name) inv[slot.name] = (inv[slot.name]||0)+slot.count;
            return inv;
        },
        getNearbyEntityTypes: () => [],
        getBlockAtPosition: (b, x=0,y=0,z=0) => {
            try { return b.blockAt(b.entity.position.offset(x,y,z)) || {name:'air'}; } catch { return {name:'air'}; }
        },
        getFirstBlockAboveHead: () => 'none',
    };
    const convoManager = _convoManager || { getInGameAgents: () => [], inConversation: () => false, activeConversation: null };

    // Trigger async loads for next call
    void loadWorld();
    void loadConvo();

    const pos = world.getPosition(bot);
    const position = {
        x: Number(pos.x.toFixed(2)),
        y: Number(pos.y.toFixed(2)),
        z: Number(pos.z.toFixed(2))
    };

    let weather = 'Clear';
    if (bot.thunderState > 0) weather = 'Thunderstorm';
    else if (bot.rainState > 0) weather = 'Rain';

    let timeLabel = 'Night';
    if (bot.time.timeOfDay < 6000) timeLabel = 'Morning';
    else if (bot.time.timeOfDay < 12000) timeLabel = 'Afternoon';

    const below = world.getBlockAtPosition(bot, 0, -1, 0).name;
    const legs = world.getBlockAtPosition(bot, 0, 0, 0).name;
    const head = world.getBlockAtPosition(bot, 0, 1, 0).name;

    let players = [];
    try { players = world.getNearbyPlayerNames(bot); } catch {}
    let bots = [];
    try { bots = convoManager.getInGameAgents().filter(b => b !== agent.name); } catch {}
    players = players.filter(p => !bots.includes(p));

    const helmet = bot.inventory.slots[5];
    const chestplate = bot.inventory.slots[6];
    const leggings = bot.inventory.slots[7];
    const boots = bot.inventory.slots[8];

    let activity;
    try {
        if (!agent.isIdle()) {
            activity = { current: agent.actions.currentActionLabel || 'Acting', kind: 'acting' };
        } else if (convoManager.inConversation && convoManager.inConversation()) {
            const who = convoManager.activeConversation?.name;
            activity = { current: who ? `Chatting with ${who}` : 'Chatting', kind: 'chatting' };
        } else if (agent.self_prompter.isStopped()) {
            activity = { current: 'Stopped', kind: 'stopped' };
        } else if (agent.self_prompter.isPaused()) {
            activity = { current: 'Chatting', kind: 'chatting' };
        } else if (agent.self_prompter.isActive()) {
            activity = { current: 'Thinking', kind: 'thinking' };
        } else {
            activity = { current: 'Idle', kind: 'idle' };
        }
    } catch {
        activity = { current: 'Idle', kind: 'idle' };
    }

    const state = {
        name: agent.name,
        gameplay: {
            position,
            dimension: bot.game.dimension,
            gamemode: bot.game.gameMode,
            health: Math.round(bot.health),
            hunger: Math.round(bot.food),
            biome: world.getBiomeName(bot),
            weather,
            timeOfDay: bot.time.timeOfDay,
            timeLabel
        },
        action: {
            current: activity.current,
            kind: activity.kind,
            isIdle: agent.isIdle()
        },
        surroundings: {
            below,
            legs,
            head,
            firstBlockAboveHead: world.getFirstBlockAboveHead(bot, null, 32)
        },
        inventory: {
            counts: world.getInventoryCounts(bot),
            stacksUsed: bot.inventory.items().length,
            totalSlots: bot.inventory.slots.length,
            equipment: {
                helmet: helmet ? helmet.name : null,
                chestplate: chestplate ? chestplate.name : null,
                leggings: leggings ? leggings.name : null,
                boots: boots ? boots.name : null,
                mainHand: bot.heldItem ? bot.heldItem.name : null
            }
        },
        nearby: {
            humanPlayers: players,
            botPlayers: bots,
            entityTypes: world.getNearbyEntityTypes(bot).filter(t => t !== 'player' && t !== 'item'),
            // Legit radar sensors (Meteor/LiquidBounce-style awareness):
            // exact player positions fed into the AI context.
            playerPositions: safePlayerPositions(bot),
            groundItems: safeGroundItems(bot),
        },
        // Legit danger awareness: monsters (with threat scores), hazards,
        // risk level, underground/darkness — so the LLM can reason about
        // safety instead of stumbling into it.
        danger: safeDanger(bot),
        modes: {
            summary: bot.modes.getMiniDocs()
        }
    };

    return state;
}
