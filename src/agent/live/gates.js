/**
 * gates.js — pre-flight policy gates for LIVE Minecraft integration testing.
 *
 * The FakeBot benchmark (`src/agent/benchmark/`) proves planner/recovery logic.
 * A live run touches things the benchmark cannot: a real server, authentication,
 * chat/anti-cheat behaviour, and other players. So nothing in `src/agent/live/`
 * is allowed to open a socket before these gates pass.
 *
 * Two hard gates:
 *
 *  1. `evaluateNetworkGate` — who owns the server we are about to join?
 *       - loopback  -> always allowed (your own machine, stage 2 of the ramp)
 *       - private   -> allowed with a warning (LAN world you own)
 *       - public    -> allowed ONLY with an explicit `--tos-ack` phrase AND a
 *                    valid authorization record naming the staff member who
 *                    permitted automation, plus host/username/port match.
 *     There is no override that skips the record. We do not join servers whose
 *     staff have not said yes, and we never conceal that the client is a bot.
 *
 *  2. `evaluateCredentialGate` — which LLM key would this run spend?
 *     A leaked key must never be used again. Keys may only come from an
 *     untracked file or the environment; a key whose SHA-256 matches a known
 *     leaked digest fails the run; and `--mode direct` deliberately loads no
 *     LLM key at all (the first live runs should not cost API calls).
 *
 * Deliberately dependency-free (no mineflayer / no settings import) so the
 * gate logic itself is unit-testable and runnable anywhere: `npm run test`.
 */

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';

/** Exit codes used by the live CLI. */
export const EXIT = {
    OK: 0,
    FAILED: 1,
    GATE: 2,
};

/** Magic phrase required to acknowledge staff authorization for public hosts. */
export const TOS_ACK_PHRASE = 'authorized-by-server-staff';

export const HOST_KIND = {
    LOOPBACK: 'loopback',
    PRIVATE: 'private',
    PUBLIC: 'public',
};

const SECRET_PATTERNS = [
    /\bsk-or-[A-Za-z0-9_-]{8,}/g,
    /\bsk-[A-Za-z0-9_-]{16,}/g,
    /\bAIza[0-9A-Za-z_\-]{20,}/g,
    /\bgh[pousr]_[A-Za-z0-9]{20,}/g,
    /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
    /\bxox[baprs]-[A-Za-z0-9-]{10,}/g,
    /\bBearer\s+[A-Za-z0-9._\-]{12,}/gi,
];

/* ------------------------------------------------------------------ hosts */

export function classifyHost(host) {
    const h = String(host || '').trim().toLowerCase().replace(/^\[(.*)\]$/, '$1');
    if (!h) return HOST_KIND.PUBLIC;
    if (h === 'localhost' || h === '::1' || h.startsWith('127.')) return HOST_KIND.LOOPBACK;
    // 0.0.0.0 is a bind address, not a connect target — treated as local so a
    // misconfigured test fails loudly on connect rather than silently dialling out.
    if (h === '0.0.0.0') return HOST_KIND.LOOPBACK;
    if (/^10\./.test(h) || /^192\.168\./.test(h) || /^172\.(1[6-9]|2\d|3[01])\./.test(h)) return HOST_KIND.PRIVATE;
    if (/^169\.254\./.test(h)) return HOST_KIND.PRIVATE; // link-local
    if (/^fd[0-9a-f]{2}:/.test(h)) return HOST_KIND.PRIVATE; // unique local
    if (/^\d+\.\d+\.\d+\.\d+$/.test(h)) return HOST_KIND.PUBLIC;
    return HOST_KIND.PUBLIC; // any hostname is public by default
}

export function isLocalHost(host) {
    return classifyHost(host) !== HOST_KIND.PUBLIC;
}

/* ------------------------------------------------------- authorization record */

/**
 * The authorization record is the auditable answer to "did the server staff say
 * bots are OK?". It lives outside the repo (e.g. `~/bagelsmp-auth.json` or
 * `.live/authorization.json`, both gitignored) and records who granted it.
 *
 * @param {string} filePath
 * @returns {{record: object|null, problems: string[]}}
 */
export function loadAuthorizationRecord(filePath, ctx = {}) {
    const problems = [];
    if (!filePath) {
        return { record: null, problems: ['no authorization record supplied (--authorization <path>)'] };
    }
    let raw;
    try {
        raw = fs.readFileSync(filePath, 'utf8');
    } catch (err) {
        return { record: null, problems: [`cannot read authorization record at ${filePath}: ${err.message}`] };
    }
    let record;
    try {
        record = JSON.parse(raw);
    } catch (err) {
        return { record: null, problems: [`authorization record is not valid JSON: ${err.message}`] };
    }
    problems.push(...validateAuthorizationRecord(record, ctx));
    return { record, problems };
}

/**
 * @returns {string[]} problems (empty when the record is usable)
 */
export function validateAuthorizationRecord(record = {}, ctx = {}) {
    const problems = [];
    if (!record || typeof record !== 'object') return ['authorization record missing'];

    if (record.automation_permitted !== true) {
        problems.push('record.automation_permitted must be exactly true (an automated client is permitted on this server)');
    }
    if (record.no_evasion_confirmed !== true) {
        problems.push('record.no_evasion_confirmed must be true (bot identity/behaviour is not concealed from anti-cheat)');
    }
    for (const field of ['server', 'granted_by', 'granted_on', 'channel']) {
        const v = record[field];
        if (typeof v !== 'string' || !v.trim()) problems.push(`record.${field} is required and must be non-empty`);
    }
    if (typeof record.granted_on === 'string' && Number.isNaN(Date.parse(record.granted_on))) {
        problems.push('record.granted_on must be an ISO date');
    }
    if (typeof record.expires_on === 'string' && record.expires_on.trim()) {
        const expiry = Date.parse(record.expires_on);
        if (Number.isNaN(expiry)) problems.push('record.expires_on must be an ISO date when present');
        else if (expiry <= (ctx.now ?? Date.now())) problems.push(`record.expires_on ${record.expires_on} is in the past (renew it with staff)`);
    }

    if (ctx.host) {
        const wanted = normalizeHost(ctx.host);
        const granted = normalizeHost(record.server);
        if (granted && granted !== wanted) problems.push(`record authorizes "${record.server}", not "${ctx.host}"`);
    }
    if (ctx.username && record.allowed_username) {
        if (String(record.allowed_username).toLowerCase() !== String(ctx.username).toLowerCase()) {
            problems.push(`record authorizes account "${record.allowed_username}", not "${ctx.username}"`);
        }
    }
    if (ctx.port != null && Array.isArray(record.allowed_ports) && record.allowed_ports.length) {
        if (!record.allowed_ports.map(Number).includes(Number(ctx.port))) {
            problems.push(`record authorizes ports [${record.allowed_ports.join(', ')}], not ${ctx.port}`);
        }
    }
    return problems;
}

function normalizeHost(host) {
    return String(host || '').trim().toLowerCase().replace(/^www\./, '').replace(/:\d+$/, '');
}

/**
 * The network gate. Called by the runner before any connect().
 *
 * @param {{host:string, port?:number, username?:string, auth?:string,
 *          allowRemote?:boolean, tosAck?:string, authorizationPath?:string,
 *          now?:number, forceLocal?:boolean}} opts
 */
export function evaluateNetworkGate(opts = {}) {
    const host = String(opts.host || '').trim();
    const kind = classifyHost(host);
    const decision = {
        permitted: false,
        host,
        port: opts.port ?? null,
        hostKind: kind,
        problems: [],
        warnings: [],
        mode: kind === HOST_KIND.PUBLIC ? 'public' : (kind === HOST_KIND.PRIVATE ? 'lan' : 'local'),
        authorization: null,
    };

    if (!host) {
        decision.problems.push('no server host configured');
        return decision;
    }
    if (opts.username) {
        const nameOk = /^[a-zA-Z0-9_]{3,16}$/.test(opts.username);
        if (!nameOk) decision.problems.push(`invalid Minecraft username "${opts.username}" (3-16 chars, [a-zA-Z0-9_])`);
    }
    if (opts.auth && !['offline', 'microsoft'].includes(opts.auth)) {
        decision.problems.push(`unknown auth mode "${opts.auth}" (expected offline or microsoft)`);
    }

    if (kind === HOST_KIND.LOOPBACK) {
        if (opts.auth === 'microsoft') decision.warnings.push('loopback server with microsoft auth: the local server must run online-mode=true');
        decision.permitted = decision.problems.length === 0;
        return decision;
    }

    if (kind === HOST_KIND.PRIVATE) {
        if (opts.auth === 'microsoft') decision.warnings.push('LAN server with microsoft auth requires online-mode=true');
        decision.warnings.push(`host ${host} is a private/LAN address — only join it if you own or administer it`);
        decision.permitted = decision.problems.length === 0;
        return decision;
    }

    // Public host: three independent requirements, no shortcut.
    if (!opts.allowRemote) {
        decision.problems.push(`refusing to connect to public host "${host}" without --allow-remote`);
    }
    if (opts.tosAck !== TOS_ACK_PHRASE) {
        decision.problems.push(`public hosts require --tos-ack ${TOS_ACK_PHRASE} (you confirmed bot policy with the owners/staff)`);
    }
    if (opts.auth === 'offline' || !opts.auth) {
        decision.problems.push('public servers must use auth=microsoft with your own account (offline auth on a public server is not supported)');
    }
    const { record, problems } = loadAuthorizationRecord(opts.authorizationPath, {
        host, port: opts.port, username: opts.username, now: opts.now,
    });
    decision.authorization = record;
    decision.problems.push(...problems);
    if (opts.forceLocal) decision.problems.push('--local-only was set, so public hosts are refused regardless of other flags');

    decision.permitted = decision.problems.length === 0;
    return decision;
}

/* ------------------------------------------------------------- credentials */

export function sha256(value) {
    return crypto.createHash('sha256').update(String(value)).digest('hex');
}

/**
 * Replace anything that looks like a credential with a redacted placeholder.
 * Applied to every report/log artifact the live harness writes.
 */
export function redactSecrets(value) {
    if (typeof value === 'string') {
        let out = value;
        for (const re of SECRET_PATTERNS) out = out.replace(re, (m) => `[redacted:${m.slice(0, 4)}…]`);
        return out;
    }
    if (Array.isArray(value)) return value.map(redactSecrets);
    if (value && typeof value === 'object') {
        const out = {};
        for (const [k, v] of Object.entries(value)) {
            if (/key|token|secret|password|authorization|cookie/i.test(k) && typeof v === 'string' && v.length > 6) {
                out[k] = `[redacted:${sha256(v).slice(0, 12)}]`;
            } else {
                out[k] = redactSecrets(v);
            }
        }
        return out;
    }
    return value;
}

/** Truncated, hashed preview of a secret — safe to print. */
export function fingerprint(secret) {
    const s = String(secret ?? '');
    if (!s) return { present: false };
    const digest = sha256(s);
    // Only the provider prefix and a hash fragment: enough to tell two keys
    // apart, useless for reconstructing one, safe to keep in a report.
    return { present: true, length: s.length, sha256: digest, sha8: digest.slice(0, 8), prefix: s.slice(0, 4) };
}

function gitTrackedFiles(cwd, patterns) {
    try {
        const out = execFileSync('git', ['ls-files', '--', ...patterns], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
        return out.split('\n').map((l) => l.trim()).filter(Boolean);
    } catch {
        return null; // git unavailable / not a repo: caller degrades to a warning
    }
}

/**
 * Where does the LLM key for this run come from, and is it safe to spend?
 *
 * @param {{repoRoot?:string, providersPath?:string, env?:object,
 *          needsLlm?:boolean, provider?:string, leakedHashes?:string[]}} opts
 */
export function evaluateCredentialGate(opts = {}) {
    const repoRoot = opts.repoRoot || process.cwd();
    const env = opts.env || process.env;
    const needsLlm = opts.needsLlm !== false;
    const result = {
        ok: true,
        problems: [],
        warnings: [],
        llm: needsLlm ? 'enabled' : 'disabled',
        provider: opts.provider || null,
        sources: [],
        files: {},
    };

    const leaked = new Set((opts.leakedHashes || []).map((h) => String(h).trim().toLowerCase()).filter(Boolean));

    // 1) No LLM needed at all (direct mode): assert that nothing leaked either.
    if (!needsLlm) {
        result.sources.push('direct mode: no LLM provider is loaded, so no API key is used by this run');
        const trackedJson = gitTrackedFiles(repoRoot, ['settings_llm_providers.json', 'keys.json', '**/*_providers.json']) || [];
        for (const f of trackedJson) {
            try {
                const text = fs.readFileSync(path.join(repoRoot, f), 'utf8');
                if (SECRET_PATTERNS.some((re) => (re.lastIndex = 0, re.test(text)))) {
                    result.problems.push(`tracked file ${f} contains something that looks like an API key; remove it from git history`);
                }
            } catch { /* ignore unreadable */ }
        }
        result.ok = result.problems.length === 0;
        return result;
    }

    // 2) Providers file must be untracked (gitignored) if it is used at all.
    const providersRel = opts.providersPath || env.MINDCRAFT_LLM_PROVIDERS_PATH || 'settings_llm_providers.json';
    const providersAbs = path.isAbsolute(providersRel) ? providersRel : path.join(repoRoot, providersRel);
    const tracked = gitTrackedFiles(repoRoot, ['*']);
    if (tracked && tracked.includes(providersRel)) {
        result.problems.push(`${providersRel} is tracked in git — keys must live in an untracked file or the environment only`);
    }

    let config = null;
    if (fs.existsSync(providersAbs)) {
        try {
            config = JSON.parse(fs.readFileSync(providersAbs, 'utf8'));
            result.files[providersRel] = 'present';
        } catch (err) {
            result.problems.push(`${providersRel} is not valid JSON: ${err.message}`);
        }
    } else {
        result.files[providersRel] = 'absent';
        result.warnings.push(`${providersRel} not found — falling back to environment variables only`);
    }

    const keyEnvNames = opts.provider && config?.providers?.[opts.provider]?.keyName
        ? [config.providers[opts.provider].keyName]
        : Object.keys(config?.keys || {});

    const candidates = [];
    for (const name of keyEnvNames) {
        const fromEnv = env[name];
        const fromFile = config?.keys?.[name];
        const value = String(fromEnv || fromFile || '').trim();
        if (value) candidates.push({ name, value, source: fromEnv ? 'environment' : providersRel });
    }
    if (!candidates.length) {
        result.problems.push(`no API key resolvable for provider ${opts.provider || '(any)'}: set ${keyEnvNames.join(' or ') || 'the provider key'} in the environment or an untracked providers file`);
    }

    for (const cand of candidates) {
        const hash = sha256(cand.value);
        const entry = { name: cand.name, source: cand.source, ...fingerprint(cand.value) };
        result.sources.push(entry);
        if (leaked.has(hash)) {
            result.problems.push(`${cand.name} (${cand.source}) matches a known-leaked key digest — rotate it and replace it locally before any live run`);
        }
        if (tracked) {
            // A leaked key is only actually rotated if the old literal is not
            // still sitting in version control anywhere.
            const hit = tracked.slice(0, 600).find((f) => {
                if (/\.(node_modules|png|jpg|jar|zip|lock)$/i.test(f)) return false;
                try {
                    const abs = path.join(repoRoot, f);
                    const st = fs.statSync(abs);
                    if (!st.isFile() || st.size > 512 * 1024) return false;
                    return fs.readFileSync(abs, 'utf8').includes(cand.value);
                } catch {
                    return false;
                }
            });
            if (hit) result.problems.push(`the key in ${cand.name} also appears in tracked file ${hit} — that key must be treated as public`);
        }
    }

    if (!fs.existsSync(providersAbs) && !candidates.length && config === null) {
        result.warnings.push('cp settings_llm_providers.example.json settings_llm_providers.json if you need file-based keys');
    }

    result.ok = result.problems.length === 0;
    return result;
}

/**
 * Parse `A=hash,B=hash` or a comma list of raw sha256 digests of keys that were
 * exposed and must never be used again.
 */
export function parseLeakedHashes(input) {
    if (!input) return [];
    return String(input)
        .split(/[,\s]+/)
        .map((tok) => tok.trim())
        .filter(Boolean)
        .map((tok) => (tok.includes('=') ? tok.slice(tok.indexOf('=') + 1) : tok))
        .filter((h) => /^[a-f0-9]{64}$/i.test(h))
        .map((h) => h.toLowerCase());
}
