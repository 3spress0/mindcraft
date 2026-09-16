/**
 * gates.js — pre-flight policy gates for LIVE Minecraft integration testing.
 *
 * Nothing in `src/agent/live/` may open a socket before the network and
 * credential gates pass. A remote target is allowed when the user explicitly
 * selects it; ownership/staff authorization records are deliberately not part
 * of that network decision. Server rules, anti-cheat, and bot transparency
 * still apply outside this gate.
 *
 * The credential gate remains independent: direct protocol-only runs load no
 * LLM provider, leaked-key digests are rejected, and report evidence is
 * redacted before it is written or printed.
 *
 * This module is dependency-free apart from Node built-ins so the gates can be
 * tested without Mineflayer or a Minecraft server.
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
    // 0.0.0.0 is a bind address, not a connect target. Treating it as local
    // keeps a bad local configuration from silently becoming a remote dial.
    if (h === '0.0.0.0') return HOST_KIND.LOOPBACK;
    if (/^10\./.test(h) || /^192\.168\./.test(h) || /^172\.(1[6-9]|2\d|3[01])\./.test(h)) return HOST_KIND.PRIVATE;
    if (/^169\.254\./.test(h)) return HOST_KIND.PRIVATE; // link-local
    if (/^fd[0-9a-f]{2}:/.test(h)) return HOST_KIND.PRIVATE; // unique local
    if (/^\d+\.\d+\.\d+\.\d+$/.test(h)) return HOST_KIND.PUBLIC;
    return HOST_KIND.PUBLIC; // hostnames are public by default
}

export function isLocalHost(host) {
    return classifyHost(host) !== HOST_KIND.PUBLIC;
}

/**
 * Decide whether a target may be handed to a driver.
 *
 * `explicitTarget` is false only for the CLI's implicit default target. The
 * default is true for callers of this pure function because passing a host to
 * the function is itself an explicit target selection. The CLI supplies the
 * stricter value so a future default cannot accidentally become a remote run.
 *
 * @param {{host:string, port?:number, username?:string, auth?:string,
 *          version?:string, explicitTarget?:boolean, localOnly?:boolean,
 *          now?:number}} opts
 */
export function evaluateNetworkGate(opts = {}) {
    const host = String(opts.host || '').trim();
    const kind = classifyHost(host);
    const decision = {
        permitted: false,
        host,
        port: opts.port ?? null,
        username: opts.username ?? null,
        auth: opts.auth ?? null,
        version: opts.version ?? 'auto',
        hostKind: kind,
        problems: [],
        warnings: [],
        mode: kind === HOST_KIND.PUBLIC ? 'public' : (kind === HOST_KIND.PRIVATE ? 'lan' : 'local'),
        explicitTarget: opts.explicitTarget !== false,
    };

    if (!host) {
        decision.problems.push('no server host configured');
        return decision;
    }
    if (opts.port != null && (!Number.isInteger(Number(opts.port)) || Number(opts.port) < 1 || Number(opts.port) > 65535)) {
        decision.problems.push(`invalid Minecraft port "${opts.port}" (expected an integer from 1 to 65535)`);
    }
    if (opts.version != null && opts.version !== 'auto' && !/^\d+\.\d+(?:\.\d+)?$/.test(String(opts.version))) {
        decision.problems.push(`invalid Minecraft version "${opts.version}" (expected auto or a numeric version such as 1.21.6)`);
    }
    if (opts.username != null && !/^[a-zA-Z0-9_]{3,16}$/.test(String(opts.username))) {
        decision.problems.push(`invalid Minecraft username "${opts.username}" (3-16 chars, [a-zA-Z0-9_])`);
    }
    if (opts.auth != null && !['offline', 'microsoft'].includes(opts.auth)) {
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

    // Public/remote hosts need an explicit target and a real Microsoft login.
    // Selecting --host (or explicitly opting into --from-settings) is the
    // user's authorization to target that host; no staff-record side channel
    // is consulted and there is no blanket bypass flag.
    if (!decision.explicitTarget) {
        decision.problems.push(`refusing to connect to public host "${host}" without an explicit target (--host or --from-settings)`);
    }
    if (!opts.username) {
        decision.problems.push('a valid Minecraft username is required for a public server');
    }
    if (opts.auth !== 'microsoft') {
        decision.problems.push('public servers must use auth=microsoft with your own account (auth=offline is not supported remotely)');
    }
    if (opts.localOnly) {
        decision.problems.push('--local-only refuses public/remote hosts');
    }

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

    // Direct mode deliberately does not load or resolve a provider key. It
    // still scans tracked credential-shaped files so a committed leak fails.
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

    // Providers file must be untracked (gitignored) if it is used at all.
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
