import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { EventBus, ExecutionController, InterruptManager, SkillRegistry, registerBuiltinSkills } from '../src/agent/execution/index.js';

describe('execution architecture', () => {
    test('EventBus publishes, wildcard handlers observe, and history is bounded', async () => {
        const bus = new EventBus();
        bus.maxHistory = 2;
        const seen = [];
        bus.on('goal.completed', event => seen.push(event.type));
        bus.on('*', event => seen.push(`*:${event.type}`));
        await bus.publish('goal.completed', { ok: true });
        await bus.publish('one');
        await bus.publish('two');
        assert.deepEqual(seen, ['goal.completed', '*:goal.completed', '*:one', '*:two']);
        assert.equal(bus.recent(null, 10).length, 2);
    });

    test('SkillRegistry enforces contracts and lists reusable skills', () => {
        const registry = new SkillRegistry();
        registry.register('gather_resource', { description: 'Gather a resource', execute: async () => 3 });
        assert.equal(registry.has('gather_resource'), true);
        assert.deepEqual(registry.names(), ['gather_resource']);
        assert.equal(registry.describe()[0].description, 'Gather a resource');
        assert.throws(() => registry.register('bad', {}), /must define execute/);
        assert.throws(() => registry.register('gather_resource', { execute() {} }), /already registered/);
    });

    test('built-in skill registry exposes high-level operations', () => {
        const controller = new ExecutionController({ agent: { bot: {} } });
        registerBuiltinSkills(controller);
        assert.deepEqual(controller.registry.names(), [
            'navigate_to', 'gather_resource', 'craft_item', 'collect_items',
            'fight', 'escape_danger', 'explore', 'build_structure',
        ]);
        controller.dispose();
    });

    test('controller runs a skill and persists resumable state', async () => {
        const bus = new EventBus();
        const saved = [];
        const controller = new ExecutionController({ eventBus: bus, stateStore: state => saved.push(state) });
        controller.register('gather_resource', {
            preconditions: (_ctx, args) => args.count > 0,
            execute: async (ctx, args) => {
                ctx.setProgress({ gathered: args.count });
                return { gathered: args.count };
            },
            success: (_ctx, result) => result.gathered === 4,
        });
        const result = await controller.run('gather_resource', { count: 4 }, { goalId: 'wood-1' });
        assert.equal(result.status, 'completed');
        assert.equal(result.taskId, 'wood-1');
        assert.equal(controller.isBusy(), false);
        assert.ok(saved.length >= 2);
    });

    test('critical event interrupts an active skill and does not silently resume', async () => {
        const bus = new EventBus();
        const controller = new ExecutionController({ eventBus: bus });
        controller.register('long_skill', {
            execute: async ctx => {
                while (true) {
                    ctx.checkpoint();
                    await new Promise(resolve => setTimeout(resolve, 2));
                }
            },
        });
        const running = controller.run('long_skill');
        await new Promise(resolve => setTimeout(resolve, 5));
        await bus.publish('danger.detected', { danger: 'lava' });
        const result = await running;
        assert.equal(result.status, 'interrupted');
        assert.match(result.error.message, /Interrupted by danger.detected/);
    });

    test('medium events are queued while a skill owns the controller', async () => {
        const bus = new EventBus();
        const manager = new InterruptManager({ eventBus: bus });
        manager.begin('task-1', 'LOW');
        const result = await bus.publish('inventory.full', {});
        assert.equal(result.results.length, 1); // InterruptManager's wildcard handler
        assert.equal(manager.snapshot().pending.length, 1);
        manager.end('task-1');
        assert.equal(manager.snapshot().pending.length, 0);
        manager.dispose();
    });
});
