import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';

import {
    Project, ProjectStore, PROJECT, STEP,
    stepsFromJSON, projectFromGoal, hasDependencyCycle,
} from '../src/agent/planning/project.js';
import { Planner } from '../src/agent/planning/planner.js';

test('steps without phases land in a single default phase and behave like a flat plan', () => {
    const { project } = projectFromGoal('g', {
        steps: [
            { title: 'A', instruction: 'a' },
            { title: 'B', instruction: 'b' },
        ],
    });
    assert.equal(project.phases.length, 1);
    assert.equal(project.nextStep().title, 'A');
    project.markDone(project.nextStep());
    assert.equal(project.nextStep().title, 'B');
});

test('phases order execution: earliest open phase first, regardless of array ordering', () => {
    const { steps, phases } = stepsFromJSON([
        { title: 'Verify golem', instruction: 'v', phase: 3 },
        { title: 'Clear area', instruction: 'c', phase: 2 },
        { title: 'Find village', instruction: 'f', phase: 1 },
        { title: 'Obtain wood', instruction: 'w', phase: 1 },
        { title: 'Build platform', instruction: 'b', phase: 2, depends_on: ['2'] },
    ], [
        { title: 'Preparation' }, { title: 'Construction' }, { title: 'Verification' },
    ]);
    const project = new Project({ goal: 'iron farm', phases, steps, status: PROJECT.ACTIVE });

    const order = [];
    let step;
    while ((step = project.nextStep())) {
        order.push(step.title);
        project.markDone(step);
    }
    assert.deepEqual(order, ['Find village', 'Obtain wood', 'Clear area', 'Build platform', 'Verify golem']);
    assert.equal(project.status, PROJECT.DONE);
});

test('dependency on a later phase still gates the leaf', () => {
    const { steps, phases } = stepsFromJSON([
        { title: 'Collect iron', instruction: 'i', phase: 1 },
        { title: 'Place hoppers', instruction: 'h', phase: 2, depends_on: ['1'] },
        { title: 'Check build', instruction: 'c', phase: 2 },
    ], [{ title: 'Preparation' }, { title: 'Construction' }]);
    const project = new Project({ goal: 'farm', phases, steps, status: PROJECT.ACTIVE });
    assert.equal(project.nextStep().title, 'Collect iron');
    project.markDone(project.nextStep());
    assert.equal(project.nextStep().title, 'Place hoppers');
});

test('parent group steps never execute; they roll up from their sub-task leaves', () => {
    const { steps, phases } = stepsFromJSON([
        { title: 'Place collection system', instruction: 'group', phase: 2 },
        { title: 'Place hoppers', instruction: 'h', phase: 2, parent: '1',
          expected: { kind: 'block_near', block: 'hopper' } },
        { title: 'Place chest', instruction: 'c', phase: 2, parent: '1',
          expected: { kind: 'block_near', block: 'chest' } },
        { title: 'Find village', instruction: 'f', phase: 1 },
    ], [{ title: 'Preparation' }, { title: 'Construction' }]);
    const project = new Project({ goal: 'farm', phases, steps, status: PROJECT.ACTIVE });

    const group = project.steps.find((s) => s.title === 'Place collection system');
    assert.ok(project.isContainer(group));
    assert.equal(group.expected.kind, 'freeform', 'group expectations are rolled up');
    assert.ok(!project.leaves().some((s) => s.id === group.id));

    // First executable is the preparation leaf, never the group
    assert.equal(project.nextStep().title, 'Find village');
    project.markDone(project.nextStep());

    // Leaves under the group execute in order; the group stays open meanwhile
    const hoppers = project.nextStep();
    assert.equal(hoppers.title, 'Place hoppers');
    project.markActive(group); // sanity: derive recomputes; group gets overwritten below
    project.markDone(hoppers);
    assert.notEqual(group.status, STEP.DONE);
    assert.equal(project.nextStep().title, 'Place chest');
    project.markDone(project.nextStep());
    assert.equal(group.status, STEP.DONE, 'group rolls up to done');
    assert.equal(project.status, PROJECT.DONE);
});

test('progress counts leaves, and phase progress is per phase', () => {
    const { steps, phases } = stepsFromJSON([
        { title: 'Build structure', instruction: 'g' },
        { title: 'Sub A', instruction: 'a', parent: '1' },
        { title: 'Sub B', instruction: 'b', parent: '1' },
        { title: 'Finish', instruction: 'f' },
    ]);
    const project = new Project({ goal: 'x', phases, steps, status: PROJECT.ACTIVE });
    assert.equal(project.progress().total, 3, 'group step is not counted');
    const first = project.nextStep();
    project.markDone(first);
    assert.equal(project.progress().done, 1);
});

test('invalid phase/parent references are repaired with warnings', () => {
    const { steps, phases, problems } = stepsFromJSON([
        { title: 'A', instruction: 'a', phase: 9 },
        { title: 'B', instruction: 'b', parent: '2' }, // forward parent invalid
        { title: 'C', instruction: 'c', parent: '1' }, // valid (earlier step)
    ], [{ title: 'Only' }]);
    assert.ok(problems.some((p) => p.includes('phase')));
    assert.ok(problems.some((p) => p.includes('parent')));
    assert.equal(steps[0].phaseId, phases[0].id, 'bad phase falls back to first');
    assert.equal(steps[1].parentId, null, 'forward parent dropped');
    assert.equal(steps[2].parentId, steps[0].id);
});

test('hierarchical project round-trips through the store preserving phases, parent and recovery', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mindcraft-hier-'));
    try {
        const { steps, phases } = stepsFromJSON([
            { title: 'Group', instruction: 'g', phase: 1 },
            { title: 'Leaf', instruction: 'l', phase: 1, parent: '1' },
        ], [{ title: 'Preparation' }]);
        const project = new Project({ goal: 'farm', phases, steps, status: PROJECT.ACTIVE });
        project.steps.find((s) => s.title === 'Leaf').lastRecovery = {
            action: 'navigate', reason: 'target_depleted',
            evidence: ['usable iron_ore deposit 180m away'], guidance: 'travel', target: { pos: { x: 1 } },
        };
        const store = new ProjectStore('testbot', dir);
        store.save(project);
        const loaded = store.load();
        assert.equal(loaded.phases.length, 1);
        assert.equal(loaded.phases[0].title, 'Preparation');
        const leaf = loaded.steps.find((s) => s.title === 'Leaf');
        assert.equal(leaf.parentId, loaded.steps[0].id);
        assert.equal(leaf.lastRecovery.reason, 'target_depleted');
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('replan keeps completed phases and merges new steps/phases via replaceRemaining', () => {
    const { steps, phases } = stepsFromJSON([
        { title: 'Find village', instruction: 'f', phase: 1 },
        { title: 'Build platform', instruction: 'b', phase: 2 },
    ], [{ title: 'Preparation' }, { title: 'Construction' }]);
    const project = new Project({ goal: 'farm', phases, steps, status: PROJECT.ACTIVE });
    project.markDone(project.nextStep()); // preparation done

    // Replanner emits a fresh phase with new steps (its own local phase ids).
    const replan = stepsFromJSON([
        { title: 'Clear new site', instruction: 'c', phase: 1 },
        { title: 'Rebuild platform', instruction: 'r', phase: 1, depends_on: ['1'] },
    ], [{ title: 'Revision: relocate' }]);
    project.replaceRemaining(replan.steps, 'wrong_approach', replan.phases);

    assert.equal(project.phases.length, 3, 'revision phase appended');
    const kept = project.steps.filter((s) => s.status === STEP.DONE);
    assert.equal(kept.length, 1);
    assert.equal(kept[0].title, 'Find village');
    // New steps belong to the appended revision phase
    assert.equal(project.phaseById(replan.steps[0].phaseId).title, 'Revision: relocate');
    const leafOrder = [];
    let s;
    while ((s = project.nextStep())) { leafOrder.push(s.title); project.markDone(s); }
    assert.deepEqual(leafOrder, ['Clear new site', 'Rebuild platform']);
});

test('replanned steps without phases inherit the first project phase', () => {
    const { project } = projectFromGoal('g', {
        phases: [{ title: 'One' }, { title: 'Two' }],
        steps: [{ title: 'A', instruction: 'a', phase: 1 }],
    });
    project.markDone(project.nextStep());
    const { steps } = stepsFromJSON([{ title: 'B', instruction: 'b' }]);
    project.replaceRemaining(steps, 'transient');
    assert.equal(project.phaseById(steps[0].phaseId).id, project.phases[0].id);
});

test('render shows phase headers, indentation for sub-tasks and recovery reasons', () => {
    const { project } = projectFromGoal('iron farm', {
        phases: [{ title: 'Preparation' }, { title: 'Construction' }],
        steps: [
            { title: 'Find village', instruction: 'f', phase: 1 },
            { title: 'Place collection', instruction: 'g', phase: 2 },
            { title: 'Place hoppers', instruction: 'h', phase: 2, parent: '2' },
        ],
    });
    const leaf = project.steps.find((s) => s.title === 'Place hoppers');
    leaf.lastRecovery = { action: 'navigate', reason: 'alternate_deposit_known', evidence: ['deposit 180m away'], guidance: '', target: null };
    project.markFailed(leaf, 'alternate_deposit_known: ...');
    const text = project.render();
    assert.match(text, /Preparation/);
    assert.match(text, /Construction/);
    assert.match(text, /▸ Place collection/);
    assert.match(text, /recovery: navigate \(alternate_deposit_known\)/);
    assert.match(text, /deposit 180m away/);
});

test('planner parses a phased model response including subtasks', async () => {
    const planJSON = JSON.stringify({
        summary: 'iron farm',
        phases: [{ title: 'Preparation' }, { title: 'Construction' }, { title: 'Verification' }],
        steps: [
            { title: 'Find village', instruction: 'find', phase: 1,
              expected: { kind: 'entity_near', entity: 'villager', atLeast: 2 } },
            { title: 'Collection', instruction: 'group', phase: 2 },
            { title: 'Place hoppers', instruction: 'place', phase: 2, parent: '2',
              expected: { kind: 'block_near', block: 'hopper' } },
        ],
    });
    const planner = new Planner({ prompter: {}, bot: {} }, { sendRequest: async () => planJSON });
    const { project, warnings } = await planner.createPlan('iron farm');
    assert.equal(warnings.length, 0);
    assert.equal(project.phases.length, 3);
    assert.equal(project.leaves().length, 2);
    const titles = [];
    let s;
    while ((s = project.nextStep())) { titles.push(s.title); project.markDone(s); }
    assert.deepEqual(titles, ['Find village', 'Place hoppers']);
});

test('replan response may carry phases', async () => {
    const { project } = projectFromGoal('farm', {
        steps: [{ title: 'A', instruction: 'a' }],
    });
    const replanJSON = JSON.stringify({
        summary: 'relocated',
        phases: [{ title: 'Revision' }],
        steps: [{ title: 'New approach', instruction: 'x', phase: 1 }],
    });
    const planner = new Planner({ prompter: {}, bot: {} }, { sendRequest: async () => replanJSON });
    const failed = project.steps[0];
    project.markFailed(failed, 'wrong approach');
    const result = await planner.replan(project, failed, { reasoning: 'bad site', failureClass: 'wrong_approach' });
    assert.equal(result.phases.length, 1);
    assert.equal(result.steps[0].phaseId, result.phases[0].id);
});

test('dependency cycles are still detected with hierarchical steps', () => {
    const { steps } = stepsFromJSON([
        { title: 'A', instruction: 'a', depends_on: ['2'] },
        { title: 'B', instruction: 'b', depends_on: ['1'] },
    ]);
    assert.ok(hasDependencyCycle(steps));
});
