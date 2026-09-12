/**
 * classify.js — version-independent classification of Minecraft entities into
 * world-model categories. Shared by the live event collector and the step
 * ingestion code so both agree on what is a threat vs an animal vs a dropped
 * item.
 */

export const HOSTILE_MOBS = new Set([
    'zombie', 'husk', 'drowned', 'zombie_villager', 'zoglin',
    'skeleton', 'stray', 'wither_skeleton', 'bogged', 'creeper', 'spider', 'cave_spider',
    'witch', 'slime', 'magma_cube', 'ghast', 'blaze', 'enderman', 'endermite', 'phantom',
    'silverfish', 'pillager', 'vindicator', 'evoker', 'ravager', 'vex', 'guardian',
    'elder_guardian', 'shulker', 'hoglin', 'piglin_brute', 'warden', 'wither', 'ender_dragon',
    'killer_bunny', 'illusioner', 'giant',
]);

export const PASSIVE_ANIMALS = new Set([
    'cow', 'pig', 'sheep', 'chicken', 'rabbit', 'mooshroom', 'horse', 'donkey', 'mule',
    'skeleton_horse', 'zombie_horse', 'llama', 'trader_llama', 'cat', 'ocelot', 'wolf',
    'fox', 'panda', 'bee', 'turtle', 'axolotl', 'goat', 'frog', 'tadpole', 'allay',
    'camel', 'sniffer', 'armadillo', 'squid', 'glow_squid', 'cod', 'salmon', 'tropical_fish',
    'pufferfish', 'bat', 'parrot', 'villager', 'wandering_trader', 'iron_golem',
    'snow_golem', 'sniffer', 'npc',
]);

/**
 * @param name entity.name (e.g. 'zombie', 'item', 'cow')
 * @param type entity.type ('mob' | 'player' | 'object' | 'orb' | 'other')
 * @returns {{category:'threat'|'entity'|'resource'|null, kind:string}}
 */
export function classifyEntityLike(name, type) {
    name = String(name || '').toLowerCase();
    if (name === 'item' || (type === 'object' && name === 'item')) {
        return { category: 'resource', kind: 'ground_item' };
    }
    if (type === 'player') return { category: 'entity', kind: 'player' };
    if (HOSTILE_MOBS.has(name) || name.includes('creeper')) return { category: 'threat', kind: name };
    if (PASSIVE_ANIMALS.has(name) || name.includes('villager')) {
        const kind = name.includes('villager') ? 'villager' : (name.includes('golem') ? 'golem' : 'animal');
        return { category: 'entity', kind };
    }
    if (type === 'mob') return { category: 'entity', kind: 'other_mob' };
    return { category: null, kind: null };
}
