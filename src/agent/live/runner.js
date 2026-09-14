/**
 * runner.js — controlled live-sequence runner.
 *
 * Drives a `driver` (real mineflayer bot, or the dependency-free self-test
 * driver) through the 8-phase sequence from `phases.js`, verifies every phase
 * against observed world state, and writes a redacted evidence report.
 *
 * Contract with drivers (see drivers/mineflayer_driver.js):
 *   driver.name                        string
 *   driver.connect(ctx) -> info         phase 1 (must throw on failure)
 *   driver.observe(ctx) -> info         phase 2
 *   driver.report(ctx) -> info          phase 3
 *   driver.gather(ctx) -> info          phase 4
 *   driver.craft(ctx) -> info           phase 5
 *   driver.build(ctx) -> info           phase 6
 *   driver.interrupt(ctx) -> info       phase 7
 *   driver.verifyWorldState(ctx) -> info phase 8
 *   driver.snapshot() -> snapshot       observation used for verification
 *   driver.teardown()                   always runs, even on failure
 *
 * Invariants enforced here:
 *   - the network/credential gates run BEFORE any driver method (no socket is
 *     opened unless both gates permit);
 *   - a mutating phase that fails stops later mutating phases (so we never pile
 *     side effects onto a half-broken world), but verification + teardown still
 *     run so the report explains what happened;
 *   - every phase is bounded by its own timeout and by the global deadline;
 *   - reports are redacted before they touch disk.
 */

import fs from 'fs';
import path from 'path';

import { redactSecrets } from './gates.js';
import { bindVerifySpec, FEATURES } from './phases.js';
import { verifySpec } from './verify.js';

export const PHASE_RESULT = {
    PASSED: 'passed',
    FAILED: 'failed',
    TIMED_OUT: 'timed_out',
    ERRORED: 'errored',
    SKIPPED: 'skipped',
    NOT_RUN: 'not_run',
};

export async function runControlledTest({ driver, plan, gate, credentialGate, log = console, reportDir = null, runId = null, startedAt = null, now = () => Date.now() } = {}) {
    if (!driver) throw new Error('runControlledTest requires a driver');
    if (!plan || !Array.isArray(plan.phases)) throw new Error('runControlledTest requires a resolved plan (resolvePlan())');

    const started = startedAt ?? now();
    const id = runId || `live_${new Date(started).toISOString().replace(/[-:.]/g, '').slice(0, 15)}`;
    const results = [];
    const report = {
        schema: 'mindcraft-live-test/v1',
        id,
        startedAt: new Date(started).toISOString(),
        driver: driver.name || 'unknown',
        status: 'running',
        target: gate ? { host: gate.host, port: gate.port ?? null, mode: gate.mode, hostKind: gate.hostKind } : null,
        features: plan.features,
        task: plan.task,
        timeoutScale: plan.timeoutScale,
        budgetMs: plan.budgetMs,
        deadlineMs: plan.deadlineMs ?? null,
        gates: {
            network: gate ? {
                permitted: gate.permitted === true,
                mode: gate.mode ?? null,
                hostKind: gate.hostKind ?? null,
                authorization: gate.authorization ? { granted_by: gate.authorization.granted_by, server: gate.authorization.server, granted_on: gate.authorization.granted_on } : null,
                problems: gate.problems || [],
                warnings: gate.warnings || [],
            } : null,
            credentials: credentialGate ? { ok: credentialGate.ok === true, llm: credentialGate.llm, problems: credentialGate.problems || [], warnings: credentialGate.warnings || [] } : null,
        },
        phases: results,
        notes: [...(plan.warnings || [])],
    };

    // ---- gates first: no socket, no LLM, no world mutation before this passes
    if (gate && gate.permitted !== true) {
        report.status = 'aborted_by_gate';
        report.abortedBy = 'network_gate';
        report.problems = gate.problems || [];
        await writeReport(report, reportDir, log);
        return report;
    }
    if (credentialGate && credentialGate.ok !== true) {
        report.status = 'aborted_by_gate';
        report.abortedBy = 'credential_gate';
        report.problems = credentialGate.problems || [];
        await writeReport(report, reportDir, log);
        return report;
    }

    const reconnectEnabled = plan.features.includes(FEATURES.RECONNECT);
    let snapshot = {};
    let mutatingPhaseFailed = false;
    let runStopped = false;
    const deadline = plan.deadlineMs ? started + plan.deadlineMs : null;

    for (const phase of plan.phases) {
        if (runStopped) {
            results.push(record(phase, PHASE_RESULT.NOT_RUN, `run stopped after the ${runStopped} phase failed`));
            continue;
        }
        if (mutatingPhaseFailed && phase.mutating) {
            results.push(record(phase, PHASE_RESULT.NOT_RUN, 'skipped because an earlier mutating phase failed'));
            continue;
        }
        const remaining = deadline ? deadline - now() : null;
        if (remaining != null && remaining <= 0) {
            results.push(record(phase, PHASE_RESULT.TIMED_OUT, `global deadline ${plan.deadlineMs}ms exhausted before this phase`));
            continue;
        }
        const budget = Math.min(phase.timeoutMs, remaining ?? phase.timeoutMs);
        const t0 = now();
        log.log?.(`[live] ${phase.id}: ${phase.title} (budget ${Math.round(budget)}ms)`);
        let outcome = PHASE_RESULT.PASSED;
        let error = null;
        try {
            await withTimeout(callDriver(driver, phase.action, {
                plan,
                phase,
                log,
                reconnectEnabled,
                task: plan.task,
                snapshot: () => safeSnapshot(driver),
            }), budget, phase.id);
            snapshot = await safeSnapshot(driver);
            const spec = bindVerifySpec(phase.verify || {}, plan.task);
            const ctx = {
                expectBlocks: snapshot.expectedBlocks || plan.task?.build?.placed || [],
                reconnectEnabled,
            };
            const verdict = verifySpec(spec, snapshot, ctx);
            if (!verdict.satisfied) {
                outcome = PHASE_RESULT.FAILED;
                error = verdict.evidence;
            }
            results.push(record(phase, outcome, verdict.evidence, { ms: now() - t0, checks: verdict.checks, info: snapshot.phaseInfo?.[phase.id] ?? null }));
        } catch (err) {
            const msg = String(err?.message || err);
            outcome = err?.__timeout ? PHASE_RESULT.TIMED_OUT : PHASE_RESULT.ERRORED;
            error = msg;
            results.push(record(phase, outcome, msg, { ms: now() - t0 }));
            log.error?.(`[live] ${phase.id} ${outcome}: ${msg}`);
        }

        if (outcome !== PHASE_RESULT.PASSED && phase.mutating) mutatingPhaseFailed = true;
        if (outcome !== PHASE_RESULT.PASSED && phase.stopsRun) runStopped = phase.id;
    }

    try {
        await callDriver(driver, 'teardown', { log });
    } catch (err) {
        report.notes.push(`teardown error: ${err.message}`);
    }

    const failed = results.filter((r) => r.result !== PHASE_RESULT.PASSED && r.result !== PHASE_RESULT.SKIPPED);
    report.endedAt = new Date(now()).toISOString();
    report.durationMs = now() - started;
    report.summary = {
        total: results.length,
        passed: results.filter((r) => r.result === PHASE_RESULT.PASSED).length,
        failed: failed.length,
        timedOut: results.filter((r) => r.result === PHASE_RESULT.TIMED_OUT).length,
    };
    report.status = failed.length === 0 ? 'passed' : 'failed';
    report.problems = failed.map((f) => `${f.phase}: ${f.error}`);
    report.blindspotsCovered = plan.phases.map((p) => ({ phase: p.id, blindspot: p.blindspot }));

    await writeReport(report, reportDir, log);
    return report;
}

function record(phase, result, error, extra = {}) {
    return {
        phase: phase.id,
        title: phase.title,
        result,
        objective: phase.objective,
        blindspot: phase.blindspot,
        requires: phase.requires,
        budgetMs: phase.timeoutMs,
        durationMs: extra.ms ?? null,
        checks: extra.checks ?? null,
        info: extra.info ?? null,
        error: result === PHASE_RESULT.PASSED ? null : error ?? null,
    };
}

async function callDriver(driver, action, ctx) {
    const camel = String(action).replace(/_([a-z0-9])/g, (_m, c) => c.toUpperCase());
    const fn = driver?.[action] ?? driver?.[camel];
    if (typeof fn !== 'function') throw new Error(`driver "${driver?.name}" has no "${action}" method for this phase`);
    return fn.call(driver, ctx);
}

async function safeSnapshot(driver) {
    try {
        const snap = await driver.snapshot();
        return snap || {};
    } catch (err) {
        return { snapshotError: err.message };
    }
}

async function withTimeout(promise, ms, label) {
    let timer = null;
    try {
        return await Promise.race([
            Promise.resolve().then(() => promise),
            new Promise((_res, rej) => {
                timer = setTimeout(() => {
                    const err = new Error(`phase "${label}" exceeded its ${Math.round(ms)}ms timeout`);
                    err.__timeout = true;
                    rej(err);
                }, Math.max(1, Math.floor(ms)));
            }),
        ]);
    } finally {
        if (timer) clearTimeout(timer);
    }
}

export function renderMarkdown(report) {
    const lines = [];
    lines.push(`# Live integration run \`${report.id}\``);
    lines.push('');
    lines.push(`- driver: \`${report.driver}\``);
    lines.push(`- status: **${report.status}**${report.abortedBy ? ` (aborted by ${report.abortedBy})` : ''}`);
    lines.push(`- target: ${report.target ? `${report.target.host}${report.target.port ? `:${report.target.port}` : ''} (${report.target.mode})` : 'n/a'}`);
    lines.push(`- features: ${report.features.join(', ')}`);
    lines.push(`- duration: ${((report.durationMs ?? 0) / 1000).toFixed(1)}s (budget ${((report.budgetMs ?? 0) / 1000).toFixed(1)}s, scale x${report.timeoutScale})`);
    lines.push('');
    lines.push('| phase | result | ms | evidence |');
    lines.push('|---|---|---:|---|');
    for (const r of report.phases) {
        const evidence = (r.error || (r.checks || []).map((c) => `${c.passed ? 'ok' : 'FAIL'} ${c.label}`).join('; ') || '').replace(/\|/g, '/').replace(/\n/g, ' · ');
        lines.push(`| ${r.phase} | ${r.result} | ${r.durationMs ?? '-'} | ${evidence.slice(0, 220)} |`);
    }
    if (report.notes?.length) {
        lines.push('');
        lines.push('## Notes');
        for (const n of report.notes) lines.push(`- ${n}`);
    }
    if (report.problems?.length) {
        lines.push('');
        lines.push('## Problems');
        for (const p of report.problems) lines.push(`- ${p}`);
    }
    return `${lines.join('\n')}\n`;
}

async function writeReport(report, reportDir, log) {
    const clean = redactSecrets(report);
    if (!reportDir) return clean;
    try {
        fs.mkdirSync(reportDir, { recursive: true });
        fs.writeFileSync(path.join(reportDir, `${clean.id}.json`), JSON.stringify(clean, null, 2));
        fs.writeFileSync(path.join(reportDir, `${clean.id}.md`), renderMarkdown(clean));
        log.log?.(`[live] report: ${path.join(reportDir, `${clean.id}.json`)}`);
    } catch (err) {
        log.error?.(`[live] could not write report: ${err.message}`);
    }
    return clean;
}
