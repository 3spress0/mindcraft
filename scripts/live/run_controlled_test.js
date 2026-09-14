#!/usr/bin/env node
/**
 * run_controlled_test.js — live integration test CLI (stage 2-4 of the ramp).
 *
 * Runs the controlled 8-phase sequence from `src/agent/live/phases.js` against
 * a real Minecraft server, verifying every phase against observed world state.
 * The FakeBot benchmark stays where it is — this complements it, it does not
 * replace it.
 *
 *   # 0. check the policy gates and the plan, connect to nothing:
 *   node scripts/live/run_controlled_test.js --preflight
 *
 *   # 1. prove the harness plumbing works (no Minecraft involved):
 *   node scripts/live/run_controlled_test.js --driver selftest
 *
 *   # 2. first real run against your own local server, protocol layer only:
 *   node scripts/live/run_controlled_test.js --driver mineflayer \
 *        --host 127.0.0.1 --port 55916 --username nickgurrcrafter5 --auth offline
 *
 *   # 3. add interruption/recovery, then reconnect/persistence:
 *   node scripts/live/run_controlled_test.js --driver mineflayer --features direct,recovery
 *   node scripts/live/run_controlled_test.js --driver mineflayer --features direct,recovery,reconnect
 *
 * Public hosts (e.g. a shared SMP) are refused unless BOTH an explicit
 * --tos-ack authorized-by-server-staff and --authorization <record.json> that
 * names the staff member who permitted automation are supplied. See
 * LIVE_TEST_PLAN.md. No flag bypasses that.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import {
    evaluateNetworkGate,
    evaluateCredentialGate,
    parseLeakedHashes,
    redactSecrets,
    TOS_ACK_PHRASE,
    EXIT,
} from '../../src/agent/live/gates.js';
import { resolvePlan, ALL_FEATURES, FEATURES } from '../../src/agent/live/phases.js';
import { runControlledTest } from '../../src/agent/live/runner.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');

const HELP = `Usage: node scripts/live/run_controlled_test.js [options]

target
  --driver <selftest|mineflayer>  default: selftest (no network at all)
  --host <h> --port <n>           server to join (loopback by default)
  --username <name>               account the bot joins as
  --auth <offline|microsoft>      offline is only acceptable on your own server
  --version <1.21.x|auto>         pin the protocol version (default: auto)
  --from-settings                 take host/port/auth/version from settings.js

task
  --features <list>               ${ALL_FEATURES.join(', ')} (default: direct)
  --only <phases>                 comma list of phase ids to run
  --gather-item/--gather-count    phase 4 target
  --craft-item/--craft-count      phase 5 target
  --build-block/--build-size      phase 6 structure (NxN platform)
  --timeout-scale <f>             scale all phase timeouts (default 1 = conservative)
  --deadline <ms>                 global cap across all phases

policy gates (enforced before any socket is opened)
  --allow-remote                  required for any non-local host
  --tos-ack ${TOS_ACK_PHRASE}    required for any non-local host
  --authorization <path.json>     staff authorization record (non-local hosts)
  --local-only                    refuse non-local hosts even with the above
  --providers <path>              LLM providers file (default settings_llm_providers.json)
  --provider <name>               which provider this run may use
  --leaked-key-hashes <hashes>    sha256 digests (or @file) of keys that must never be used
  --rotation-ack                  confirm the leaked key was rotated at the provider

output
  --preflight                     gates + credential check + plan, connect to nothing
  --print-plan                    print the resolved plan and exit
  --report-dir <dir>              default results/live (gitignored); --no-report to disable
  --json                          machine-readable report on stdout
  --quiet                         only print the summary line

exit codes: 0 all phases verified · 1 a phase failed · 2 refused by a policy gate
`;

function parseArgs(argv) {
    const opts = {
        driver: 'selftest',
        host: null,
        port: null,
        username: null,
        auth: null,
        version: 'auto',
        fromSettings: false,
        features: ['direct'],
        only: null,
        task: {},
        timeoutScale: 1,
        deadline: null,
        allowRemote: false,
        tosAck: null,
        authorization: null,
        localOnly: false,
        providers: null,
        provider: null,
        leakedKeyHashes: null,
        rotationAck: false,
        preflight: false,
        printPlan: false,
        reportDir: path.join(repoRoot, 'results', 'live'),
        json: false,
        quiet: false,
        help: false,
    };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        const next = () => argv[++i];
        switch (a) {
            case '--driver': opts.driver = next(); break;
            case '--host': opts.host = next(); break;
            case '--port': opts.port = Number(next()); break;
            case '--username': opts.username = next(); break;
            case '--auth': opts.auth = next(); break;
            case '--version': opts.version = next(); break;
            case '--from-settings': opts.fromSettings = true; break;
            case '--features': opts.features = String(next()).split(',').map((s) => s.trim()).filter(Boolean); break;
            case '--only': opts.only = String(next()).split(',').map((s) => s.trim()).filter(Boolean); break;
            case '--gather-item': opts.task.gather = { ...(opts.task.gather || {}), item: next() }; break;
            case '--gather-count': opts.task.gather = { ...(opts.task.gather || {}), count: Number(next()) }; break;
            case '--craft-item': opts.task.craft = { ...(opts.task.craft || {}), item: next() }; break;
            case '--craft-count': opts.task.craft = { ...(opts.task.craft || {}), count: Number(next()) }; break;
            case '--build-block': opts.task.build = { ...(opts.task.build || {}), block: next() }; break;
            case '--build-size': opts.task.build = { ...(opts.task.build || {}), size: Number(next()) }; break;
            case '--timeout-scale': opts.timeoutScale = Number(next()); break;
            case '--deadline': opts.deadline = Number(next()); break;
            case '--allow-remote': opts.allowRemote = true; break;
            case '--tos-ack': opts.tosAck = next(); break;
            case '--authorization': opts.authorization = next(); break;
            case '--local-only': opts.localOnly = true; break;
            case '--providers': opts.providers = next(); break;
            case '--provider': opts.provider = next(); break;
            case '--leaked-key-hashes': opts.leakedKeyHashes = next(); break;
            case '--rotation-ack': opts.rotationAck = true; break;
            case '--report-dir': opts.reportDir = next(); break;
            case '--no-report': opts.reportDir = null; break;
            case '--preflight': opts.preflight = true; break;
            case '--print-plan': opts.printPlan = true; break;
            case '--json': opts.json = true; break;
            case '--quiet': opts.quiet = true; break;
            case '--help': case '-h': opts.help = true; break;
            default:
                if (a.startsWith('--driver=')) { opts.driver = a.slice(9); break; }
                console.error(`unknown option: ${a}`);
                opts.help = true;
                opts.badOption = true;
        }
    }
    return opts;
}

const REQUIRED_PACKAGES = ['mineflayer', 'mineflayer-pathfinder', 'mineflayer-collectblock', 'minecraft-data'];

function checkRealDriverDeps() {
    const missing = REQUIRED_PACKAGES.filter((pkg) => {
        try {
            return !fs.existsSync(path.join(repoRoot, 'node_modules', pkg, 'package.json'));
        } catch {
            return true;
        }
    });
    if (missing.length) {
        console.error(`[live] cannot run the real driver: missing dependencies ${missing.join(', ')}.`);
        console.error('[live] run `npm install` in the project root first (a live run needs the real mineflayer stack).');
        process.exit(EXIT.FAILED);
    }
    if (!fs.existsSync(path.join(repoRoot, 'node_modules', '.bin'))) {
        console.warn('[live] warning: node_modules/.bin missing — patch-package may not have run; the mineflayer/pathfinder patches are required for Paper servers.');
    }
}

function loadLeakedHashes(value) {
    if (!value) return parseLeakedHashes(process.env.LIVE_TEST_LEAKED_KEY_HASHES || '');
    if (value.startsWith('@')) {
        try {
            return parseLeakedHashes(fs.readFileSync(path.resolve(value.slice(1)), 'utf8'));
        } catch (err) {
            throw new Error(`cannot read leaked key hash file ${value}: ${err.message}`);
        }
    }
    return parseLeakedHashes(value);
}

async function main() {
    const opts = parseArgs(process.argv.slice(2));
    if (opts.help) {
        console.log(HELP);
        process.exit(opts.badOption ? EXIT.FAILED : EXIT.OK);
    }

    const log = opts.quiet || opts.json
        ? { log: () => { }, error: () => { } }
        : console;

    let settings = {};
    if (opts.fromSettings || opts.host == null || opts.port == null || opts.auth == null) {
        try {
            settings = (await import('../../settings.js')).default;
        } catch (err) {
            if (opts.driver === 'mineflayer') throw new Error(`cannot read settings.js: ${err.message}`);
        }
    }
    const host = opts.host ?? settings.host ?? '127.0.0.1';
    const port = opts.port ?? settings.port ?? 55916;
    const auth = opts.auth ?? settings.auth ?? 'offline';
    const version = opts.version ?? settings.minecraft_version ?? 'auto';
    const username = opts.username ?? settings.profiles?.[0]?.replace(/\.json$/, '') ?? null;

    const plan = resolvePlan({
        features: opts.features,
        task: opts.task,
        timeoutScale: opts.timeoutScale,
        deadlineMs: opts.deadline,
        only: opts.only,
    });

    const needsLlm = plan.features.includes(FEATURES.PIPELINE);
    const leakedHashes = loadLeakedHashes(opts.leakedKeyHashes);
    const gate = evaluateNetworkGate({
        host,
        port,
        username,
        auth,
        allowRemote: opts.allowRemote,
        tosAck: opts.tosAck,
        authorizationPath: opts.authorization,
        forceLocal: opts.localOnly,
    });
    const credentialGate = evaluateCredentialGate({
        repoRoot,
        providersPath: opts.providers ?? settings.llm_providers,
        env: process.env,
        needsLlm,
        provider: opts.provider ?? null,
        leakedHashes,
    });
    if (needsLlm && !opts.rotationAck) {
        credentialGate.problems.push('LLM features are enabled: pass --rotation-ack to confirm the previously exposed key was rotated at the provider and only the replacement exists locally');
        credentialGate.ok = false;
    }

    if (opts.printPlan || opts.preflight) {
        printPreflight({ gate, credentialGate, plan, opts, host, port, auth, username, version, needsLlm, leakedHashes: leakedHashes.length });
    }
    if (opts.preflight) {
        const ok = gate.permitted && credentialGate.ok && !plan.problems.length;
        process.exit(ok ? EXIT.OK : EXIT.GATE);
    }
    if (plan.problems.length) {
        for (const p of plan.problems) console.error(`plan: ${p}`);
        process.exit(EXIT.FAILED);
    }

    if (opts.driver === 'mineflayer') checkRealDriverDeps();
    const driver = await buildDriver(opts, { host, port, auth, username, version, log });
    const report = await runControlledTest({ driver, plan, gate, credentialGate, log, reportDir: opts.reportDir });

    if (opts.json) {
        console.log(JSON.stringify(redactSecrets(report), null, 2));
    } else if (!opts.quiet) {
        printSummary(report, gate, credentialGate);
        if (report.status === 'aborted_by_gate') {
            const src = report.abortedBy === 'credential_gate' ? credentialGate : gate;
            console.error(`refused by the ${report.abortedBy} before opening a socket:`);
            for (const p of src?.problems || []) console.error(`  - ${p}`);
            if (report.abortedBy === 'network_gate') {
                console.error(`  See LIVE_TEST_PLAN.md: local server first; public servers only after the staff\n  permission record exists and matches host/port/account.`);
            }
        }
    }

    if (report.status === 'aborted_by_gate') process.exit(EXIT.GATE);
    process.exit(report.status === 'passed' ? EXIT.OK : EXIT.FAILED);
}

async function buildDriver(opts, cfg) {
    if (opts.driver === 'selftest') {
        const { SelfTestDriver } = await import('../../src/agent/live/drivers/selftest_driver.js');
        return new SelfTestDriver({ inventory: {} });
    }
    if (opts.driver === 'mineflayer') {
        if (!cfg.username) throw new Error('--username is required for a live run');
        const { MineflayerDriver } = await import('../../src/agent/live/drivers/mineflayer_driver.js');
        return new MineflayerDriver({
            host: cfg.host,
            port: cfg.port,
            auth: cfg.auth,
            username: cfg.username,
            version: cfg.version,
            log: { log: (...a) => (opts.quiet ? null : console.log(...a)), error: (...a) => console.error(...a) },
        });
    }
    throw new Error(`unknown driver "${opts.driver}" (selftest | mineflayer)`);
}

function printPreflight({ gate, credentialGate, plan, opts, host, port, auth, username, version, needsLlm, leakedHashes }) {
    console.log('=== live integration preflight ===');
    console.log(`target:      ${username || '(no username)'}@${host}:${port} auth=${auth} version=${version}`);
    console.log(`host class:  ${gate.hostKind} (${gate.mode})`);
    console.log(`driver:      ${opts.driver}`);
    console.log(`features:    ${plan.features.join(', ') || '(none)'}`);
    console.log(`llm:         ${needsLlm ? 'ENABLED (pipeline)' : 'disabled — this run makes zero API calls'}`);
    console.log(`leaked-key digests loaded: ${leakedHashes}`);
    console.log('');
    console.log(`network gate:      ${gate.permitted ? 'PERMITTED' : 'REFUSED'}`);
    for (const p of gate.problems) console.log(`   - ${p}`);
    for (const w of gate.warnings) console.log(`   ~ ${w}`);
    console.log(`credential gate:   ${credentialGate.ok ? 'OK' : 'REFUSED'}`);
    for (const p of credentialGate.problems) console.log(`   - ${p}`);
    for (const w of credentialGate.warnings) console.log(`   ~ ${w}`);
    console.log('');
    console.log('plan:');
    for (const p of plan.phases) {
        console.log(`   ${p.id.padEnd(10)} ${(p.timeoutMs / 1000).toFixed(1)}s  ${p.title}`);
        console.log(`   ${''.padEnd(10)}        proves: ${p.blindspot}`);
    }
    console.log(`budget: ${(plan.budgetMs / 1000).toFixed(1)}s total${plan.deadlineMs ? `, deadline ${plan.deadlineMs}ms` : ''}`);
    for (const w of plan.warnings) console.log(`   ~ ${w}`);
    for (const p of plan.problems) console.log(`   - ${p}`);
}

function printSummary(report, gate, credentialGate) {
    console.log('');
    console.log(`=== live run ${report.id}: ${report.status.toUpperCase()} ===`);
    for (const r of report.phases) {
        const mark = r.result === 'passed' ? 'ok  ' : r.result === 'skipped' ? 'skip' : 'FAIL';
        console.log(`[${mark}] ${r.phase.padEnd(10)} ${r.result.padEnd(9)} ${r.durationMs != null ? `${String(Math.round(r.durationMs)).padStart(6)}ms` : '       -'}  ${r.title}`);
        if (r.error) for (const line of String(r.error).split('\n')) console.log(`        ${line}`);
    }
    if (report.summary) console.log(`phases: ${report.summary.passed}/${report.summary.total} verified, ${report.summary.failed} failed`);
    if (gate?.warnings?.length) for (const w of gate.warnings) console.log(`note: ${w}`);
    if (!credentialGate.ok) console.log('note: credential gate problems above');
    console.log('');
}

main().catch((err) => {
    console.error(`[live] fatal: ${err?.stack || err}`);
    process.exit(EXIT.FAILED);
});
