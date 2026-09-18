/**
 * Adapters from the execution layer to existing deterministic Mineflayer
 * helpers. Keeping these adapters here lets planners call a skill contract
 * without importing command implementations or writing low-level loops.
 */
export function registerBuiltinSkills(controller) {
    const agent = controller.agent;
    controller.registerMany({
        navigate_to: {
            description: 'Navigate to a world position using the active path profile.',
            preconditions: (_ctx, args) => [args.x, args.y, args.z].every(value => Number.isFinite(Number(value))),
            interruptPolicy: { 'danger.detected': 'interrupt', 'path.blocked': 'interrupt', 'world.block_changed': 'ignore' },
            execute: async (ctx, args) => {
                const { goToPosition } = await import('../library/skills.js');
                const result = await goToPosition(ctx.bot, args.x, args.y, args.z, args.distance ?? 2);
                if (result) ctx.setProgress({ pathSegmentCompleted: true, position: { x: args.x, y: args.y, z: args.z } });
                return result;
            },
        },
        gather_resource: {
            description: 'Find reachable matching blocks, mine them, collect drops, and resume safely.',
            preconditions: (_ctx, args) => !!(args.block_type ?? args.blockType) && Number(args.count ?? args.num ?? 1) > 0,
            interruptPolicy: { 'danger.detected': 'interrupt', 'inventory.full': 'checkpoint', 'world.block_changed': 'ignore' },
            execute: async (ctx, args) => {
                const { mineBlocks } = await import('../baritone/baritone.js');
                return mineBlocks(ctx.bot, args.block_type ?? args.blockType, args.count ?? args.num ?? 1, {
                    types: args.types,
                    returnToEntrance: args.returnToEntrance === true,
                    onProgress: (mined, requested) => ctx.setProgress({ mined, requested }),
                });
            },
        },
        craft_item: {
            description: 'Craft an item and verify the inventory result.',
            preconditions: (_ctx, args) => !!(args.item ?? args.itemName) && Number(args.count ?? args.num ?? 1) > 0,
            interruptPolicy: { 'danger.detected': 'checkpoint', 'inventory.changed': 'checkpoint' },
            execute: async (ctx, args) => {
                const { craftRecipe } = await import('../library/skills.js');
                const result = await craftRecipe(ctx.bot, args.item ?? args.itemName, args.count ?? args.num ?? 1);
                if (result) ctx.setProgress({ recipeCompleted: true, item: args.item ?? args.itemName });
                return result;
            },
        },
        collect_items: {
            description: 'Navigate to nearby dropped items and pick them up.',
            execute: async ctx => {
                const { pickupNearbyItems } = await import('../library/skills.js');
                return pickupNearbyItems(ctx.bot);
            },
        },
        fight: {
            description: 'Approach and fight a specified mob or player.',
            preconditions: (_ctx, args) => !!(args.type ?? args.mob ?? args.player ?? args.player_name),
            execute: async (ctx, args) => {
                const skills = await import('../library/skills.js');
                if (args.player || args.player_name) {
                    const entity = ctx.bot.players?.[args.player ?? args.player_name]?.entity;
                    if (!entity) throw new Error(`Player not currently visible: ${args.player ?? args.player_name}`);
                    return skills.attackEntity(ctx.bot, entity, args.kill !== false);
                }
                return skills.attackNearest(ctx.bot, args.type ?? args.mob, args.kill !== false);
            },
        },
        escape_danger: {
            description: 'Retreat from nearby hostile entities using a repulsive path goal.',
            execute: async (ctx, args) => {
                const { avoidEnemies } = await import('../library/skills.js');
                return avoidEnemies(ctx.bot, args.distance ?? 16);
            },
        },
        explore: {
            description: 'Explore a bounded number of navigation legs and update the world model.',
            execute: async (ctx, args) => {
                const { explore } = await import('../navigation/exploration.js');
                return explore(agent ?? ctx.agent, { legs: args.legs ?? 3, ...args });
            },
        },
        build_structure: {
            description: 'Build a named schematic with persistent progress and verification.',
            execute: async (ctx, args) => {
                const { buildSchematic } = await import('../npc/schematic_build.js');
                return buildSchematic(ctx.agent ?? agent, args.name, args.position ?? null, args.orientation ?? null);
            },
        },
    });
    return controller;
}
