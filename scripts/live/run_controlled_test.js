#!/usr/bin/env node
/**
 * run_controlled_test.js — live integration test CLI.
 *
 * Runs the controlled sequence from `src/agent/live/phases.js` against either
 * the dependency-free harness driver or a real Mineflayer server. All policy
 * and credential gates are evaluated before a driver can open a socket.
 *
 * `--features direct` is protocol-only and makes no LLM calls. A remote host
 * is permitted when it is explicitly selected with `--host` (or by explicitly
 * using `--from-settings`) and uses Microsoft authentication.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import {
    evaluateNetworkGate,
    evaluateCredentialGate,
    parseLeakedHashes,
    redactSecrets,
    EXIT,
} from '../../src/agent/live/gates.js';
import { resolvePlan, ALL_FEATURES, FEATURES } from '../../src/agent/live/phases.js';
import { runControlledTest } from '../../src/agent/live/runner.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');

const HELP = `Usage: node scripts/live/run_controlled_test.js [options]

target
  --driver <selftest|mineflayer>  default: selftest (selftest never uses network)
  --host <h> --port <n>           server to join (loopback default)
  --username <name>               Minecraft account to join as
  --auth <offline|microsoft>      offline is local-only; remote requires microsoft
  --version <1.21.x|auto>         pin the protocol version (default: auto)
  --from-settings                 take host/port/auth/version from settings.js

task
  --features <list>               ${ALL_FEATURES.join(', ')} (default: direct)
  --only <phases>                 run exactly these phase ids, in harness order
  --gather-item/--gather-count    phase 4 target
  --craft-item/--craft-count      phase 5 target
  --build-block/--build-size      phase 6 structure (NxN platform)
  --timeout-scale <f>             scale all phase timeouts (default: 1)
  --deadline <ms>                 global cap across selected phases

policy and credentials (checked before any socket)
  --local-only                    refuse public/remote hosts
  --providers <path>              LLM providers file (default: settings_llm_providers.json)
  --provider <name>               which provider this run may use
  --leaked-key-hashes <hashes>    SHA-256 digests (or @file) of keys never to use
  --rotation-ack                  confirm a rotated key before enabling pipeline

output
  --preflight                     gates + credential check + plan, connect to nothing
  --print-plan                    print resolved preflight/plan information and exit
  --report-dir <dir>              default results/live (gitignored); --no-report disables
  --json                          machine-readable report on stdout
  --quiet                         suppress phase logs and the normal summary
  --help, -h                      show this help

exit codes: 0 all selected phases verified · 1 invalid config/phase failure · 2 policy gate refusal
`;

function parseArgs(argv) {
    const opts = {
        driver: 'selftest', host: null, port: null, username: null, auth: null,
        version: null, fromSettings: false, features: ['direct'], only: null,
        task: {}, timeoutScale: 1, deadline: null, localOnly: false,
        providers: null, provider: null, leakedKeyHashes: null, rotationAck: false,
        preflight: false, printPlan: false, reportDir: path.join(repoRoot, 'results', 'live'),
        json: false, quiet: false, help: false, badOption: false, parseError: null,
    };

    const value = (flag, index) => {
        const next = argv[index + 1];
        if (next == null || next.startsWith('--')) throw new Error(`${flag} requires a value`);
        return next;
    };

    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        try {
            switch (a) {
                case '--driver': opts.driver = value(a, i++); break;
                case '--host': opts.host = value(a, i++); break;
                case '--port': opts.port = Number(value(a, i++)); break;
                case '--username': opts.username = value(a, i++); break;
                case '--auth': opts.auth = value(a, i++); break;
                case '--version': opts.version = value(a, i++); break;
                case '--from-settings': opts.fromSettings = true; break;
                case '--features': opts.features = String(value(a, i++)).split(',').map((s) => s.trim()).filter(Boolean); break;
                case '--only': opts.only = String(value(a, i++)).split(',').map((s) => s.trim()).filter(Boolean); break;
                case '--gather-item': opts.task.gather = { ...(opts.task.gather || {}), item: value(a, i++) }; break;
                case '--gather-count': opts.task.gather = { ...(opts.task.gather || {}), count: Number(value(a, i++)) }; break;
                case '--craft-item': opts.task.craft = { ...(opts.task.craft || {}), item: value(a, i++) }; break;
                case '--craft-count': opts.task.craft = { ...(opts.task.craft || {}), count: Number(value(a, i++)) }; break;
                case '--build-block': opts.task.build = { ...(opts.task.build || {}), block: value(a, i++) }; break;
                case '--build-size': opts.task.build = { ...(opts.task.build || {}), size: Number(value(a, i++)) }; break;
                case '--timeout-scale': opts.timeoutScale = Number(value(a, i++)); break;
                case '--deadline': opts.deadline = Number(value(a, i++)); break;
                case '--local-only': opts.localOnly = true; break;
                case '--providers': opts.providers = value(a, i++); break;
                case '--provider': opts.provider = value(a, i++); break;
                case '--leaked-key-hashes': opts.leakedKeyHashes = value(a, i++); break;
                case '--rotation-ack': opts.rotationAck = true; break;
                case '--report-dir': opts.reportDir = value(a, i++); break;
                case '--no-report': opts.reportDir = null; break;
                case '--preflight': opts.preflight = true; break;
                case '--print-plan': opts.printPlan = true; break;
                case '--json': opts.json = true; break;
                case '--quiet': opts.quiet = true; break;
                case '--help': case '-h': opts.help = true; break;
                default:
                    if (a.startsWith('--driver=')) opts.driver = a.slice('--driver='.length);
                    else throw new Error(`unknown option: ${a}`);
            }
        } catch (err) {
            opts.badOption = true;
            opts.parseError = err.message;
            break;
        }
    }
    return opts;
}

const REQUIRED_PACKAGES = ['mineflayer', 'mineflayer-pathfinder', 'mineflayer-collectblock', 'minecraft-data'];

function checkRealDriverDeps() {
    const missing = REQUIRED_PACKAGES.filter((pkg) => {
        try { return !fs.existsSync(path.join(repoRoot, 'node_modules', pkg, 'package.json')); }
        catch { return true; }
    });
    if (missing.length) throw new Error(`real driver dependencies are missing: ${missing.join(', ')}; run npm install first`);
    if (!fs.existsSync(path.join(repoRoot, 'node_modules', '.bin'))) {
        console.warn('[live] warning: node_modules/.bin is missing; patch-package may not have run');
    }
}

function loadLeakedHashes(value) {
    if (!value) return parseLeakedHashes(process.env.LIVE_TEST_LEAKED_KEY_HASHES || '');
    if (!value.startsWith('@')) return parseLeakedHashes(value);
    try { return parseLeakedHashes(fs.readFileSync(path.resolve(value.slice(1)), 'utf8')); }
    catch (err) { throw new Error(`cannot read leaked key hash file ${value}: ${err.message}`); }
}

function exitForPreflight({ gate, credentialGate, plan }) {
    if (plan.problems.length) return EXIT.FAILED;
    if (!gate.permitted || !credentialGate.ok) return EXIT.GATE;
    return EXIT.OK;
}

async function main() {
    const opts = parseArgs(process.argv.slice(2));
    if (opts.badOption) {
        if (opts.parseError) console.error(opts.parseError);
        console.error('Use --help to list valid options.');
        process.exitCode = EXIT.FAILED;
        return;
    }
    if (opts.help) {
        console.log(HELP);
        process.exitCode = EXIT.OK;
        return;
    }
    if (!['selftest', 'mineflayer'].includes(opts.driver)) {
        console.error(`unknown driver "${opts.driver}" (expected selftest or mineflayer)`);
        process.exitCode = EXIT.FAILED;
        return;
    }

    const log = opts.quiet || opts.json ? { log: () => { }, error: () => { } } : console;
    let settings = {};
    if (opts.fromSettings || opts.host == null || opts.port == null || opts.auth == null || opts.version == null) {
        try { settings = (await import('../../settings.js')).default; }
        catch (err) {
            if (opts.driver === 'mineflayer') {
                console.error(`[live] cannot read settings.js: ${err.message}`);
                process.exitCode = EXIT.FAILED;
                return;
            }
        }
    }

    const host = opts.host ?? settings.host ?? '127.0.0.1';
    const port = opts.port ?? settings.port ?? 55916;
    const auth = opts.auth ?? settings.auth ?? 'offline';
    const version = opts.version ?? settings.minecraft_version ?? 'auto';
    // Existing settings files use the first profile filename as the default
    // bot name. Keep that compatibility while allowing an explicit live
    // username to override it (especially for Microsoft-auth remote runs).
    const username = opts.username
        ?? settings.username
        ?? settings.live_username
        ?? settings.profiles?.[0]?.replace(/\.json$/, '')
        ?? null;
    const explicitTarget = opts.host !== null || opts.fromSettings;

    const plan = resolvePlan({
        features: opts.features, task: opts.task, timeoutScale: opts.timeoutScale,
        deadlineMs: opts.deadline, only: opts.only,
    });
    const needsLlm = plan.features.includes(FEATURES.PIPELINE);
    let leakedHashes;
    try { leakedHashes = loadLeakedHashes(opts.leakedKeyHashes); }
    catch (err) {
        console.error(`[live] ${err.message}`);
        process.exitCode = EXIT.FAILED;
        return;
    }
    const gate = evaluateNetworkGate({
        host, port, username, auth, version, explicitTarget, localOnly: opts.localOnly,
    });
    const credentialGate = evaluateCredentialGate({
        repoRoot, providersPath: opts.providers ?? settings.llm_providers, env: process.env,
        needsLlm, provider: opts.provider ?? null, leakedHashes,
    });
    if (needsLlm && !opts.rotationAck) {
        credentialGate.problems.push('LLM features are enabled: pass --rotation-ack after rotating any previously exposed key');
        credentialGate.ok = false;
    }

    if (opts.printPlan || opts.preflight) {
        printPreflight({ gate, credentialGate, plan, opts, host, port, auth, username, version, needsLlm, leakedHashes: leakedHashes.length });
    }
    if (opts.printPlan) {
        // This is intentionally before dependency checks, driver construction,
        // and runControlledTest: printing a plan has no side effects or socket.
        process.exitCode = exitForPreflight({ gate, credentialGate, plan });
        return;
    }
    if (opts.preflight) {
        process.exitCode = exitForPreflight({ gate, credentialGate, plan });
        return;
    }
    if (plan.problems.length) {
        for (const problem of plan.problems) console.error(`plan: ${problem}`);
        process.exitCode = EXIT.FAILED;
        return;
    }

    // A refused gate gets a report without loading Mineflayer. This preserves
    // the no-socket invariant and makes a bad target actionable even when npm
    // dependencies have not been installed yet.
    if (!gate.permitted || !credentialGate.ok) {
        const report = await runControlledTest({
            driver: { name: opts.driver }, plan, gate, credentialGate, log, reportDir: opts.reportDir,
        });
        if (opts.json) console.log(JSON.stringify(redactSecrets(report), null, 2));
        else {
            printSummary(report, gate, credentialGate);
            const source = report.abortedBy === 'credential_gate' ? credentialGate : gate;
            console.error(`refused by the ${report.abortedBy} before opening a socket:`);
            for (const problem of source.problems || []) console.error(`  - ${problem}`);
        }
        process.exitCode = EXIT.GATE;
        return;
    }

    if (!opts.quiet && !opts.json) printTarget({ host, port, username, auth, version, features: plan.features, phases: plan.phases.map((p) => p.id) });
    if (opts.driver === 'mineflayer') checkRealDriverDeps();
    const driver = await buildDriver(opts, { host, port, auth, username, version, log });
    const report = await runControlledTest({ driver, plan, gate, credentialGate, log, reportDir: opts.reportDir });

    if (opts.json) console.log(JSON.stringify(redactSecrets(report), null, 2));
    else if (!opts.quiet) printSummary(report, gate, credentialGate);
    process.exitCode = report.status === 'passed' ? EXIT.OK : EXIT.FAILED;
}

async function buildDriver(opts, cfg) {
    if (opts.driver === 'selftest') {
        const { SelfTestDriver } = await import('../../src/agent/live/drivers/selftest_driver.js');
        return new SelfTestDriver({ inventory: {} });
    }
    if (!cfg.username) throw new Error('--username is required for a Mineflayer live run');
    const { MineflayerDriver } = await import('../../src/agent/live/drivers/mineflayer_driver.js');
    return new MineflayerDriver({
        host: cfg.host, port: cfg.port, auth: cfg.auth, username: cfg.username, version: cfg.version,
        log: { log: (...args) => (opts.quiet ? null : console.log(...args)), error: (...args) => console.error(...args) },
    });
}

function printTarget({ host, port, username, auth, version, features, phases }) {
    console.log('[live] resolved target:');
    console.log(`  host: ${host}`);
    console.log(`  port: ${port}`);
    console.log(`  username: ${username || '(none)'}`);
    console.log(`  auth: ${auth}`);
    console.log(`  Minecraft version: ${version}`);
    console.log(`  selected features: ${features.join(', ') || '(none)'}`);
    console.log(`  selected phases: ${phases.join(', ') || '(none)'}`);
}

function printPreflight({ gate, credentialGate, plan, opts, host, port, auth, username, version, needsLlm, leakedHashes }) {
    console.log('=== live integration preflight ===');
    printTarget({ host, port, username, auth, version, features: plan.features, phases: plan.phases.map((p) => p.id) });
    console.log(`host class:  ${gate.hostKind} (${gate.mode})`);
    console.log(`driver:      ${opts.driver}`);
    console.log(`llm:         ${needsLlm ? 'ENABLED (pipeline)' : 'disabled — this run makes zero API calls'}`);
    console.log(`leaked-key digests loaded: ${leakedHashes}`);
    console.log('');
    console.log(`network gate:      ${gate.permitted ? 'PERMITTED' : 'REFUSED'}`);
    for (const problem of gate.problems) console.log(`   - ${problem}`);
    for (const warning of gate.warnings) console.log(`   ~ ${warning}`);
    console.log(`credential gate:   ${credentialGate.ok ? 'OK' : 'REFUSED'}`);
    for (const problem of credentialGate.problems) console.log(`   - ${problem}`);
    for (const warning of credentialGate.warnings) console.log(`   ~ ${warning}`);
    console.log('');
    console.log('plan:');
    for (const phase of plan.phases) {
        console.log(`   ${phase.id.padEnd(10)} ${(phase.timeoutMs / 1000).toFixed(1)}s  ${phase.title}`);
        console.log(`   ${''.padEnd(10)}        proves: ${phase.blindspot}`);
    }
    if (plan.excludedPhases?.length) {
        console.log(`excluded by --only (intentional): ${plan.excludedPhases.map((p) => p.id).join(', ')}`);
    }
    console.log(`budget: ${(plan.budgetMs / 1000).toFixed(1)}s total${plan.deadlineMs ? `, deadline ${plan.deadlineMs}ms` : ''}`);
    for (const warning of plan.warnings) console.log(`   ~ ${warning}`);
    for (const problem of plan.problems) console.log(`   - ${problem}`);
}

function printSummary(report, gate, credentialGate) {
    console.log('');
    console.log(`=== live run ${report.id || ''}: ${report.status.toUpperCase()} ===`);
    for (const phase of report.phases) {
        const mark = phase.result === 'passed' ? 'ok  ' : phase.result === 'skipped' ? 'skip' : 'FAIL';
        console.log(`[${mark}] ${phase.phase.padEnd(10)} ${phase.result.padEnd(9)} ${phase.durationMs != null ? `${String(Math.round(phase.durationMs)).padStart(6)}ms` : '       -'}  ${phase.title}`);
        if (phase.error) for (const line of String(phase.error).split('\n')) console.log(`        ${line}`);
    }
    if (report.summary) console.log(`phases: ${report.summary.passed}/${report.summary.total} verified, ${report.summary.failed} failed`);
    if (report.excludedPhases?.length) console.log(`intentionally excluded by --only: ${report.excludedPhases.map((p) => p.id).join(', ')}`);
    if (gate?.warnings?.length) for (const warning of gate.warnings) console.log(`note: ${warning}`);
    if (!credentialGate.ok) console.log('note: credential gate problems above');
    console.log('');
}

main().catch((err) => {
    console.error(`[live] fatal: ${err?.stack || err}`);
    process.exitCode = EXIT.FAILED;
});
