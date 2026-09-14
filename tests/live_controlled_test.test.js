/**
 * tests for the LIVE integration harness (src/agent/live/*).
 *
 * These do not test Minecraft — they test the thing that must be trustworthy
 * before a live run happens: the policy gates (who may be joined, which key
 * may be spent), the phase plan, deterministic verification, and the runner's
 * failure/timeout/abort semantics. Everything here is dependency-free and
 * never opens a socket.
 *
 * `--driver selftest` in the CLI is likewise NOT a live test; it only proves
 * the harness plumbing. See LIVE_TEST_PLAN.md for the ramp.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';

import {
    classifyHost,
    HOST_KIND,
    evaluateNetworkGate,
    validateAuthorizationRecord,
    evaluateCredentialGate,
    redactSecrets,
    parseLeakedHashes,
    sha256,
    TOS_ACK_PHRASE,
} from '../src/agent/live/gates.js';
import { resolvePlan, bindVerifySpec, PHASES, FEATURES } from '../src/agent/live/phases.js';
import { verifySpec } from '../src/agent/live/verify.js';
import { runControlledTest, PHASE_RESULT } from '../src/agent/live/runner.js';
import { SelfTestDriver } from '../src/agent/live/drivers/selftest_driver.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const CLI = path.join(repoRoot, 'scripts', 'live', 'run_controlled_test.js');

const silent = { log: () => { }, error: () => { } };

const VALID_RECORD = {
    server: 'bagelsmp.com',
    automation_permitted: true,
    no_evasion_confirmed: true,
    granted_by: 'StaffMember#0',
    granted_on: '2026-09-01',
    expires_on: '2099-01-01',
    channel: 'discord ticket #1',
    allowed_username: 'nickgurrcrafter5',
    allowed_ports: [25565],
};

/* ------------------------------------------------------------------ gates */

test('live gates: host classification decides how careful we must be', () => {
    assert.equal(classifyHost('localhost'), HOST_KIND.LOOPBACK);
    assert.equal(classifyHost('127.0.0.1'), HOST_KIND.LOOPBACK);
    assert.equal(classifyHost('::1'), HOST_KIND.LOOPBACK);
    assert.equal(classifyHost('192.168.1.40'), HOST_KIND.PRIVATE);
    assert.equal(classifyHost('10.0.0.5'), HOST_KIND.PRIVATE);
    assert.equal(classifyHost('bagelsmp.com'), HOST_KIND.PUBLIC);
    assert.equal(classifyHost('mc.example.net'), HOST_KIND.PUBLIC);
    assert.equal(classifyHost('8.8.8.8'), HOST_KIND.PUBLIC);
    assert.equal(classifyHost(''), HOST_KIND.PUBLIC, 'unknown host must be treated as public');
});

test('live gates: loopback is allowed with no ceremony, public host is refused', () => {
    const local = evaluateNetworkGate({ host: '127.0.0.1', port: 55916, username: 'nickgurrcrafter5', auth: 'offline' });
    assert.equal(local.permitted, true);
    assert.equal(local.mode, 'local');

    const remote = evaluateNetworkGate({ host: 'bagelsmp.com', port: 25565, username: 'nickgurrcrafter5', auth: 'microsoft' });
    assert.equal(remote.permitted, false);
    assert.match(remote.problems.join(' '), /--allow-remote/);
    assert.match(remote.problems.join(' '), /--tos-ack/);
    assert.match(remote.problems.join(' '), /authorization record/);
});

test('live gates: a public host needs a matching, unexpired staff record', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'live-auth-'));
    const write = (obj) => {
        const f = path.join(dir, `${obj.allowed_username || 'x'}_${Math.random().toString(36).slice(2)}.json`.replace(/[^a-z0-9_.]/g, '_'));
        fs.writeFileSync(f, JSON.stringify(obj));
        return f;
    };
    const base = {
        host: 'bagelsmp.com', port: 25565, username: 'nickgurrcrafter5',
        auth: 'microsoft', allowRemote: true, tosAck: TOS_ACK_PHRASE,
    };

    const good = evaluateNetworkGate({ ...base, authorizationPath: write(VALID_RECORD) });
    assert.equal(good.permitted, true, good.problems.join('; '));

    const wrongUser = evaluateNetworkGate({ ...base, authorizationPath: write({ ...VALID_RECORD, allowed_username: 'someoneelse' }) });
    assert.equal(wrongUser.permitted, false);
    assert.match(wrongUser.problems.join(' '), /authorizes account/);

    const expired = evaluateNetworkGate({ ...base, authorizationPath: write({ ...VALID_RECORD, expires_on: '2020-01-01' }) });
    assert.equal(expired.permitted, false);
    assert.match(expired.problems.join(' '), /in the past/);

    const notPermitted = evaluateNetworkGate({ ...base, authorizationPath: write({ ...VALID_RECORD, automation_permitted: false }) });
    assert.equal(notPermitted.permitted, false);
    assert.match(notPermitted.problems.join(' '), /automation_permitted/);

    const evading = evaluateNetworkGate({ ...base, authorizationPath: write({ ...VALID_RECORD, no_evasion_confirmed: false }) });
    assert.equal(evading.permitted, false, 'concealing automation from anti-cheat is never authorized');

    const otherHost = evaluateNetworkGate({ ...base, host: 'other-smp.net', authorizationPath: write(VALID_RECORD) });
    assert.equal(otherHost.permitted, false);
    assert.match(otherHost.problems.join(' '), /not "other-smp.net"/);

    // record validation is reusable standalone
    assert.deepEqual(validateAuthorizationRecord(VALID_RECORD, { host: 'bagelsmp.com', username: 'nickgurrcrafter5', port: 25565 }), []);
});

test('live gates: offline auth and --local-only are never valid on a public server', () => {
    const offline = evaluateNetworkGate({ host: 'bagelsmp.com', port: 25565, username: 'nickgurrcrafter5', auth: 'offline', allowRemote: true, tosAck: TOS_ACK_PHRASE, authorizationPath: null });
    assert.equal(offline.permitted, false);
    assert.match(offline.problems.join(' '), /auth=microsoft/);

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'live-auth-'));
    const f = path.join(dir, 'ok.json');
    fs.writeFileSync(f, JSON.stringify(VALID_RECORD));
    const forced = evaluateNetworkGate({ host: 'bagelsmp.com', port: 25565, username: 'nickgurrcrafter5', auth: 'microsoft', allowRemote: true, tosAck: TOS_ACK_PHRASE, authorizationPath: f, forceLocal: true });
    assert.equal(forced.permitted, false);
    assert.match(forced.problems.join(' '), /--local-only/);
});

test('live gates: bad usernames are rejected before wasting a login attempt', () => {
    const bad = evaluateNetworkGate({ host: '127.0.0.1', username: 'a bot name!', auth: 'offline' });
    assert.equal(bad.permitted, false);
    assert.match(bad.problems.join(' '), /Invalid|invalid Minecraft username/);
    assert.equal(evaluateNetworkGate({ host: '127.0.0.1', username: 'nickgurrcrafter5', auth: 'offline' }).permitted, true);
});

/* --------------------------------------------------------- secret hygiene */

test('live gates: reports are redacted so evidence can be pasted safely', () => {
    const leaked = 'sk-or-v1-' + 'A'.repeat(32);
    const obj = {
        note: `using key ${leaked} now`,
        OPENROUTER_API_KEY: leaked,
        nested: [{ authorization: `Bearer ${'x'.repeat(24)}` }],
    };
    const out = redactSecrets(obj);
    const text = JSON.stringify(out);
    assert.ok(!text.includes(leaked), 'raw key must not survive redaction');
    assert.match(out.note, /\[redacted:sk-o…\]/);
    assert.match(out.OPENROUTER_API_KEY, /^\[redacted:[0-9a-f]{12}\]$/, 'key-like fields become a digest, not a prefix');
    assert.match(JSON.stringify(out.nested), /\[redacted/);
    assert.equal(redactSecrets({ plan: { gather: { item: 'oak_log' } } }).plan.gather.item, 'oak_log', 'ordinary fields are untouched');
});

test('live gates: credential gate refuses a key whose digest is known-leaked', () => {
    const leakedKey = 'sk-or-v1-' + crypto.randomBytes(16).toString('hex');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'live-cred-'));
    const providers = path.join(dir, 'providers.json');
    fs.writeFileSync(providers, JSON.stringify({ keys: { OPENROUTER_API_KEY: leakedKey }, providers: { openrouter: { keyName: 'OPENROUTER_API_KEY' } } }));

    const bad = evaluateCredentialGate({
        repoRoot: dir,
        providersPath: providers,
        env: {},
        provider: 'openrouter',
        leakedHashes: [sha256(leakedKey)],
    });
    assert.equal(bad.ok, false);
    assert.match(bad.problems.join(' '), /matches a known-leaked key digest/);
    // the report must identify the key without reproducing it
    assert.ok(!JSON.stringify(bad).includes(leakedKey));
    assert.equal(bad.sources[0].sha8, sha256(leakedKey).slice(0, 8));

    const rotated = evaluateCredentialGate({
        repoRoot: dir,
        providersPath: providers,
        env: { OPENROUTER_API_KEY: 'sk-or-v1-' + crypto.randomBytes(16).toString('hex') },
        provider: 'openrouter',
        leakedHashes: [sha256(leakedKey)],
    });
    assert.equal(rotated.ok, true, rotated.problems.join('; '));

    assert.deepEqual(parseLeakedHashes('a=' + sha256(leakedKey) + ', ' + sha256('other')), [sha256(leakedKey), sha256('other')]);
    assert.deepEqual(parseLeakedHashes('not-a-hash'), []);
});

test('live gates: direct mode loads no LLM key at all, and flags keys committed to git', (t) => {
    const direct = evaluateCredentialGate({ repoRoot, env: {}, needsLlm: false });
    assert.equal(direct.ok, true);
    assert.equal(direct.llm, 'disabled');

    if (spawnSync('git', ['--version'], { encoding: 'utf8' }).status !== 0) {
        t.skip('git unavailable');
        return;
    }
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'live-git-'));
    const git = (...args) => spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
    git('init', '-q');
    git('config', 'user.email', 'test@example.invalid');
    git('config', 'user.name', 'test');
    fs.writeFileSync(path.join(dir, 'settings_llm_providers.json'), JSON.stringify({ keys: { OPENROUTER_API_KEY: 'sk-or-v1-' + 'b'.repeat(30) } }));
    git('add', 'settings_llm_providers.json');
    git('commit', '-qm', 'oops');

    const tracked = evaluateCredentialGate({ repoRoot: dir, env: {}, needsLlm: false });
    assert.equal(tracked.ok, false, 'a providers file committed to git is a leaked providers file');
    assert.match(tracked.problems.join(' '), /tracked file settings_llm_providers\.json contains something that looks like an API key/);
});

/* ------------------------------------------------------------------ plan */

test('live plan: features add phases incrementally instead of the bot roaming free', () => {
    const direct = resolvePlan({ features: [FEATURES.DIRECT] });
    const ids = direct.phases.map((p) => p.id);
    assert.deepEqual(ids, ['connect', 'observe', 'report', 'gather', 'craft', 'build', 'persist']);
    assert.ok(!ids.includes('recovery'));

    const full = resolvePlan({ features: [FEATURES.DIRECT, FEATURES.RECOVERY, FEATURES.RECONNECT, FEATURES.PIPELINE] });
    assert.deepEqual(full.phases.map((p) => p.id), PHASES.map((p) => p.id));
    assert.equal(full.phases.find((p) => p.id === 'recovery').requires.includes(FEATURES.RECOVERY), true);

    // every phase states what FakeBot could not have proven
    for (const p of PHASES) assert.ok(p.blindspot && p.blindspot.length > 10, `${p.id} needs a blindspot`);
});

test('live plan: timeouts stay conservative, budget is the sum, bad input is refused', () => {
    const base = resolvePlan({ features: [FEATURES.DIRECT] });
    assert.equal(base.budgetMs, base.phases.reduce((a, p) => a + p.timeoutMs, 0));
    assert.ok(base.phases.find((p) => p.id === 'connect').timeoutMs >= 30_000, 'connect must not be tight on a cold server');

    const scaled = resolvePlan({ features: [FEATURES.DIRECT], timeoutScale: 2 });
    assert.equal(scaled.phases.find((p) => p.id === 'connect').timeoutMs, base.phases.find((p) => p.id === 'connect').timeoutMs * 2);
    assert.match(scaled.warnings.length >= 0 ? '' : '', /^$/); // scale up = no warnings
    assert.ok(!resolvePlan({ features: [FEATURES.DIRECT], timeoutScale: 2 }).warnings.some((w) => /shortens/.test(w)));
    assert.ok(resolvePlan({ features: [FEATURES.DIRECT], timeoutScale: 0.1 }).warnings.some((w) => /shortens live timeouts/.test(w)));

    assert.ok(resolvePlan({ features: ['nope'] }).problems.some((p) => /unknown feature/.test(p)));
    assert.ok(resolvePlan({ features: [FEATURES.DIRECT], timeoutScale: 0 }).problems.some((p) => /positive number/.test(p)));
    assert.ok(resolvePlan({ features: [FEATURES.DIRECT], only: ['nonexistent'] }).problems.some((p) => /no runnable phases/.test(p)));
    // the mandatory floor is always on
    assert.ok(resolvePlan({ features: [FEATURES.RECOVERY] }).features.includes(FEATURES.DIRECT));
});

test('live plan: verify specs bind to the task config, not to hardcoded items', () => {
    const plan = resolvePlan({ features: [FEATURES.DIRECT], task: { gather: { item: 'spruce_log', count: 3 }, craft: { item: 'stick', count: 4 } } });
    assert.equal(plan.task.gather.blockType, 'spruce_log');
    const gatherSpec = bindVerifySpec(plan.phases.find((p) => p.id === 'gather').verify, plan.task);
    assert.deepEqual({ item: gatherSpec.item, gained: gatherSpec.gained }, { item: 'spruce_log', gained: 3 });
    assert.equal(gatherSpec.itemFrom, undefined, 'binding must remove the reference keys');
    const worldSpec = bindVerifySpec(plan.phases.find((p) => p.id === 'persist').verify, plan.task);
    assert.deepEqual(worldSpec.expectItems, { stick: 4 }, 'only the crafted item must still be in the inventory');
    assert.deepEqual(worldSpec.gatherAccounting, { item: 'spruce_log', min: 3 }, 'the gathered resource must be held or built, not vanished');
    const recov = bindVerifySpec(plan.phases.find((p) => p.id === 'recovery')?.verify || { kind: 'recovery' }, plan.task);
    assert.equal(recov.kind, 'recovery');
});

/* ------------------------------------------------------------- verify rules */

test('live verify: phases pass on observed world change only', () => {
    const snap = {
        position: { x: 1, y: 64, z: 1 }, health: 20, food: 18, dimension: 'overworld',
        inventory: { oak_log: 2 }, inventoryBefore: { oak_log: 0 },
        nearbyBlockTypes: ['grass_block', 'dirt'], nearbyEntities: [], chunksLoaded: 9,
        placedBlocks: [{ x: 1, y: 64, z: 1, name: 'oak_planks', confirmed: true }],
    };
    assert.equal(verifySpec({ kind: 'inventory_gain', item: 'oak_log', gained: 2 }, snap).satisfied, true);
    const short = verifySpec({ kind: 'inventory_gain', item: 'oak_log', gained: 5 }, snap);
    assert.equal(short.satisfied, false);
    assert.match(short.evidence, /\+2 \(before 0, after 2, need >= 5\)/);

    // no gain at all is the classic false success: the call returned, nothing happened
    const none = verifySpec({ kind: 'inventory_gain', item: 'cobblestone', gained: 1 }, snap);
    assert.equal(none.satisfied, false);
    assert.equal(none.checks[0].passed, false);
});

test('live verify: craft consumes materials and build must be re-readable in-world', () => {
    const snap = {
        inventory: { crafting_table: 1, oak_log: 0 }, inventoryBefore: { oak_log: 1 },
        placedBlocks: [{ x: 0, y: 64, z: 0, name: 'oak_planks', confirmed: false },
        { x: 1, y: 64, z: 0, name: 'oak_planks', confirmed: true }],
    };
    const craft = verifySpec({ kind: 'inventory_have', item: 'crafting_table', atLeast: 1 }, snap);
    assert.equal(craft.satisfied, true);
    assert.match(craft.evidence, /consumed: oak_log -1/);
    assert.equal(verifySpec({ kind: 'inventory_have', item: 'furnace', atLeast: 1 }, snap).satisfied, false);

    const unconfirmed = verifySpec({ kind: 'blocks_placed', minBlocks: 2 }, snap, { expectBlocks: [{ x: 0, y: 64, z: 0 }, { x: 1, y: 64, z: 0 }] });
    assert.equal(unconfirmed.satisfied, false, '1 of 2 blocks confirmed must not pass a minBlocks=2 requirement');
});

test('live verify: an interruption that did not actually happen is a failure, not a pass', () => {
    const vacuous = verifySpec({ kind: 'recovery', requireAnyOf: ['retried'], mustNotCrash: true }, { recovery: { interrupted: false, retried: true } });
    assert.equal(vacuous.satisfied, false);
    assert.match(vacuous.evidence, /nothing was interrupted/);

    const crashed = verifySpec({ kind: 'recovery', requireAnyOf: ['retried', 'resumed'] }, { recovery: { interrupted: true, resumed: true, crashed: true, detail: 'boom' } });
    assert.equal(crashed.satisfied, false);
    assert.match(crashed.evidence, /crashed: boom/);

    const good = verifySpec({ kind: 'recovery', requireAnyOf: ['retried', 'resumed'], finalGoal: { item: 'oak_log', gained: 2 } }, { recovery: { interrupted: true, retried: true }, inventory: { oak_log: 2 } });
    assert.equal(good.satisfied, true, good.evidence);
});

test('live verify: reconnect claims are checked, not assumed', () => {
    const snap = { placedBlocks: [{ x: 0, y: 64, z: 0, name: 'oak_planks', confirmed: true }], inventory: { oak_log: 1 }, reconnect: { performed: true, connected: false, reconnectMs: 9999, blocksSurvived: false, inventorySurvived: true, stateRestored: true } };
    const res = verifySpec({ kind: 'world_state', minBlocks: 1, expectItems: { oak_log: 1 } }, snap, { reconnectEnabled: true });
    assert.equal(res.satisfied, false);
    assert.match(res.evidence, /FAIL reconnect completed/);
    assert.match(res.evidence, /FAIL build survived reconnect/);
    // and when reconnect was not requested, the phase must not silently demand it
    const without = verifySpec({ kind: 'world_state', minBlocks: 1, expectItems: {} }, { placedBlocks: [{ confirmed: true }], inventory: {} }, { reconnectEnabled: false });
    assert.equal(without.satisfied, true, 'no reconnect demanded when the feature is off');
    assert.match(without.evidence, /ok reconnect performed: skipped/);
});

test('live verify: persistence claims read the agent state files, and refuse corrupt ones', () => {
    const base = { placedBlocks: [{ confirmed: true }], inventory: { crafting_table: 1 } };
    const good = verifySpec({ kind: 'world_state', minBlocks: 1 }, { ...base, persistence: [{ name: 'world_model.json', present: true, bytes: 900, parseable: true }] }, {});
    assert.equal(good.satisfied, true, good.evidence);
    const corrupt = verifySpec({ kind: 'world_state', minBlocks: 1 }, { ...base, persistence: [{ name: 'plan_project.json', present: true, bytes: 12, parseable: false }] }, {});
    assert.equal(corrupt.satisfied, false);
    assert.match(corrupt.evidence, /unparseable: plan_project\.json/);
    const absent = verifySpec({ kind: 'world_state', minBlocks: 1 }, base, {});
    assert.equal(absent.satisfied, true, 'an absent file is reported as not-yet-written, not faked as verified');
    assert.match(absent.evidence, /no world_model\/project files yet/);
});

/* ---------------------------------------------------------------- runner */

test('live runner: refuses to touch the driver when a gate says no', async () => {
    const driver = new SelfTestDriver({ inventory: {} });
    const plan = resolvePlan({ features: [FEATURES.DIRECT, FEATURES.RECOVERY, FEATURES.RECONNECT] });
    const gate = evaluateNetworkGate({ host: 'bagelsmp.com', port: 25565, username: 'nickgurrcrafter5', auth: 'microsoft' });
    const report = await runControlledTest({ driver, plan, gate, credentialGate: { ok: true }, log: silent });
    assert.equal(report.status, 'aborted_by_gate');
    assert.equal(report.abortedBy, 'network_gate');
    assert.deepEqual(driver.calls, [], 'no phase may run before the gate passes');
    assert.ok(report.problems.length >= 3);
});

test('live runner: credential refusal also stops before connect', async () => {
    const driver = new SelfTestDriver({});
    const plan = resolvePlan({ features: [FEATURES.DIRECT] });
    const gate = evaluateNetworkGate({ host: '127.0.0.1', port: 55916, username: 'tester_bot', auth: 'offline' });
    const cred = { ok: false, problems: ['key matches known-leaked digest'], llm: 'disabled' };
    const report = await runControlledTest({ driver, plan, gate, credentialGate: cred, log: silent });
    assert.equal(report.status, 'aborted_by_gate');
    assert.equal(report.abortedBy, 'credential_gate');
    assert.deepEqual(driver.calls, []);
});

test('live runner: all eight controlled phases verify end to end', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'live-report-'));
    const driver = new SelfTestDriver({ inventory: {} });
    const plan = resolvePlan({ features: [FEATURES.DIRECT, FEATURES.RECOVERY, FEATURES.RECONNECT] });
    const gate = evaluateNetworkGate({ host: '127.0.0.1', port: 55916, username: 'tester_bot', auth: 'offline' });
    const report = await runControlledTest({ driver, plan, gate, credentialGate: { ok: true, llm: 'disabled' }, log: silent, reportDir: dir });

    assert.equal(report.status, 'passed', JSON.stringify(report.phases.filter((p) => p.result !== 'passed')));
    assert.equal(report.summary.passed, 8);
    assert.deepEqual(driver.calls, ['connect', 'observe', 'report', 'gather', 'craft', 'build', 'interrupt', 'verify_world_state', 'teardown']);
    for (const p of report.phases) {
        assert.ok(p.blindspot, 'evidence must say what FakeBot could not have validated');
        assert.ok(p.budgetMs > 0);
    }
    const files = fs.readdirSync(dir);
    assert.ok(files.some((f) => f.endsWith('.json')) && files.some((f) => f.endsWith('.md')));
    const onDisk = JSON.parse(fs.readFileSync(path.join(dir, files.find((f) => f.endsWith('.json'))), 'utf8'));
    assert.equal(onDisk.id, report.id);
    assert.ok(report.blindspotsCovered.length === 8);
});

test('live runner: a failing mutating phase halts the rest of the mutations but still tears down', async () => {
    const driver = new SelfTestDriver({ inventory: {}, failPhase: 'gather' });
    const plan = resolvePlan({ features: [FEATURES.DIRECT] });
    const gate = evaluateNetworkGate({ host: '127.0.0.1', port: 55916, username: 'tester_bot', auth: 'offline' });
    const report = await runControlledTest({ driver, plan, gate, credentialGate: { ok: true }, log: silent });
    const byId = Object.fromEntries(report.phases.map((p) => [p.phase, p]));
    assert.equal(report.status, 'failed');
    assert.equal(byId.gather.result, PHASE_RESULT.ERRORED);
    assert.equal(byId.craft.result, PHASE_RESULT.NOT_RUN);
    assert.equal(byId.build.result, PHASE_RESULT.NOT_RUN);
    assert.notEqual(byId.persist.result, PHASE_RESULT.PASSED, 'the final world-state check must not bless a broken world');
    assert.equal(byId.persist.result, PHASE_RESULT.FAILED, 'read-only verification still runs so the report explains the state');
    assert.ok(driver.calls.includes('teardown'), 'teardown must always run');
    assert.ok(driver.calls.includes('report'), 'read-only phases before the failure still ran');
});

test('live runner: a failed connect stops the run instead of cascading', async () => {
    const driver = new SelfTestDriver({ failPhase: 'connect' });
    const plan = resolvePlan({ features: [FEATURES.DIRECT, FEATURES.RECOVERY] });
    const gate = evaluateNetworkGate({ host: '127.0.0.1', port: 55916, username: 'tester_bot', auth: 'offline' });
    const report = await runControlledTest({ driver, plan, gate, credentialGate: { ok: true }, log: silent });
    assert.equal(report.status, 'failed');
    assert.equal(report.phases[0].phase, 'connect');
    assert.equal(report.phases[0].result, PHASE_RESULT.ERRORED);
    for (const p of report.phases.slice(1)) {
        assert.equal(p.result, PHASE_RESULT.NOT_RUN, `${p.phase} must not run after login failed`);
        assert.match(p.error, /run stopped after the connect phase/);
    }
    assert.deepEqual(driver.calls, ['connect', 'teardown'], 'no world interaction, and quit still attempted');
});

test('live runner: a hung phase is timed out, not awaited forever', async () => {
    const driver = new SelfTestDriver({ hangPhase: 'gather' });
    const plan = resolvePlan({ features: [FEATURES.DIRECT], timeoutScale: 0.02 }); // clamped to 1s floors
    const gate = evaluateNetworkGate({ host: '127.0.0.1', port: 55916, username: 'tester_bot', auth: 'offline' });
    const t0 = Date.now();
    const report = await runControlledTest({ driver, plan, gate, credentialGate: { ok: true }, log: silent });
    const elapsed = Date.now() - t0;
    const gather = report.phases.find((p) => p.phase === 'gather');
    assert.equal(gather.result, PHASE_RESULT.TIMED_OUT);
    assert.match(gather.error, /exceeded its \d+ms timeout/);
    assert.ok(elapsed < 15_000, `the run must not hang; took ${elapsed}ms`);
    assert.ok(driver.calls.includes('teardown'));
});

test('live runner: a false-success gather (no real gain) fails verification even when the driver returns happily', async () => {
    // Driver that "succeeds" but changes nothing in the world: exactly the
    // class of bug FakeBot cannot catch and the observer exists to catch.
    const lying = Object.assign(Object.create(Object.getPrototypeOf(new SelfTestDriver({}))), new SelfTestDriver({}), {
        name: 'lying',
        async gather() { this.calls.push('gather'); return { ok: true }; },
    });
    const plan = resolvePlan({ features: [FEATURES.DIRECT] });
    const gate = evaluateNetworkGate({ host: '127.0.0.1', port: 55916, username: 'tester_bot', auth: 'offline' });
    const report = await runControlledTest({ driver: lying, plan, gate, credentialGate: { ok: true }, log: silent });
    const gather = report.phases.find((p) => p.phase === 'gather');
    assert.equal(gather.result, PHASE_RESULT.FAILED);
    assert.match(gather.error, /inventory:oak_log/);
    assert.equal(report.status, 'failed');
});

test('live runner: writes a redacted report even when the snapshot mentions a key', async () => {
    const secret = 'sk-or-v1-' + 'c'.repeat(30);
    const driver = new SelfTestDriver({});
    driver.notes = secret;
    const origSnapshot = driver.snapshot.bind(driver);
    driver.snapshot = async () => ({ ...(await origSnapshot()), note: `configured with ${secret}`, api_key: secret });
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'live-report-'));
    const plan = resolvePlan({ features: [FEATURES.DIRECT] });
    const gate = evaluateNetworkGate({ host: '127.0.0.1', port: 55916, username: 'tester_bot', auth: 'offline' });
    const report = await runControlledTest({ driver, plan, gate, credentialGate: { ok: true }, log: silent, reportDir: dir });
    const file = fs.readdirSync(dir).find((f) => f.endsWith('.json'));
    const text = fs.readFileSync(path.join(dir, file), 'utf8');
    assert.equal(report.status, 'passed');
    assert.ok(!text.includes(secret), 'no credential may reach disk in a report artifact');
});

/* ------------------------------------------------------------------- CLI */

test('live CLI: selftest run exits 0 and prints machine-readable report', () => {
    const res = spawnSync('node', [CLI, '--driver', 'selftest', '--features', 'direct,recovery,reconnect', '--json', '--no-report'], { encoding: 'utf8', cwd: repoRoot, timeout: 60_000 });
    assert.equal(res.status, 0, res.stderr);
    const report = JSON.parse(res.stdout);
    assert.equal(report.driver, 'selftest');
    assert.equal(report.status, 'passed');
    assert.equal(report.phases.length, 8);
    assert.equal(report.gates.network.mode, 'local');
    assert.equal(report.gates.credentials.llm, 'disabled');
});

test('live CLI: refuses a public host with exit code 2 and never connects', () => {
    const res = spawnSync('node', [CLI, '--preflight', '--host', 'bagelsmp.com', '--port', '25565', '--username', 'nickgurrcrafter5', '--auth', 'microsoft'], { encoding: 'utf8', cwd: repoRoot, timeout: 30_000 });
    assert.equal(res.status, 2, res.stdout + res.stderr);
    assert.match(res.stdout, /network gate:      REFUSED/);
    assert.match(res.stdout, /--tos-ack authorized-by-server-staff/);

    const run = spawnSync('node', [CLI, '--driver', 'selftest', '--host', 'bagelsmp.com', '--username', 'nickgurrcrafter5', '--auth', 'microsoft', '--no-report'], { encoding: 'utf8', cwd: repoRoot, timeout: 30_000 });
    assert.equal(run.status, 2, 'a refused gate must exit non-zero even without --preflight');
    assert.match(run.stdout, /aborted_by_gate/i);
    assert.match(run.stderr, /--tos-ack|authorization record/);
});

test('live CLI: --print-plan lists each phase with its conservative timeout', () => {
    const res = spawnSync('node', [CLI, '--print-plan', '--driver', 'selftest', '--features', 'direct,recovery', '--no-report', '--quiet'], { encoding: 'utf8', cwd: repoRoot, timeout: 30_000 });
    assert.equal(res.status, 0, res.stderr);
    for (const id of ['connect', 'observe', 'report', 'gather', 'craft', 'build', 'recovery', 'persist']) {
        assert.match(res.stdout, new RegExp(`^\\s+${id}\\s+\\d+\\.\\ds`, 'm'), `${id} should be listed with a timeout`);
    }
    assert.match(res.stdout, /budget: \d+\.\ds total/);
    assert.match(res.stdout, /llm:         disabled/);
});

test('live CLI: unknown options and bad features fail loudly', () => {
    const badOpt = spawnSync('node', [CLI, '--nope'], { encoding: 'utf8', cwd: repoRoot, timeout: 30_000 });
    assert.equal(badOpt.status, 1);
    assert.match(badOpt.stderr, /unknown option: --nope/);
    const badFeat = spawnSync('node', [CLI, '--print-plan', '--features', 'yolo'], { encoding: 'utf8', cwd: repoRoot, timeout: 30_000 });
    assert.match(badFeat.stdout + badFeat.stderr, /unknown feature "yolo"/);
});
