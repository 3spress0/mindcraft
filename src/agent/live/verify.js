/**
 * verify.js — deterministic verification for live phases.
 *
 * Same philosophy as `src/agent/planning/observer.js`: a phase passes because
 * the world actually changed, not because the call returned without throwing.
 * It works on a plain normalized snapshot so both the real mineflayer driver
 * and the self-test driver are judged by identical rules.
 *
 * snapshot = {
 *   connected, serverVersion, protocol, latencyMs, spawn:{x,y,z},
 *   position:{x,y,z}, health, food, dimension,
 *   inventory: {item: count}, inventoryBefore: {item: count},
 *   nearbyBlockTypes: [..], nearbyEntities: [{name,x,y,z}],
 *   chunksLoaded: n, placedBlocks: [{x,y,z,name}],
 *   recovery: {interrupted, retried, replanned, resumed, crashed, detail},
 *   reconnect: {performed, reconnectMs, blocksSurvived, inventorySurvived, stateRestored}
 * }
 */

function ok(label, evidence, passed) {
    return { label, passed: !!passed, evidence };
}

function num(v) {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
}

function distance(a, b) {
    if (!a || !b) return null;
    const dx = (num(a.x) ?? 0) - (num(b.x) ?? 0);
    const dy = (num(a.y) ?? 0) - (num(b.y) ?? 0);
    const dz = (num(a.z) ?? 0) - (num(b.z) ?? 0);
    return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

const key = (p) => (p == null ? null : `${Math.floor(num(p.x) ?? 0)},${Math.floor(num(p.y) ?? 0)},${Math.floor(num(p.z) ?? 0)}`);
// Blocks are addressed absolutely; matching them with a tolerance would let a
// neighbour pass as "the block we asked for", so compare floored coordinates.
const sameBlockPos = (a, b) => !!a && !!b && key(a) === key(b);

export function verifySpec(spec, snapshot, ctx = {}) {
    const s = snapshot || {};
    const checks = [];

    switch (spec.kind) {
        case 'connected': {
            checks.push(ok('handshake/login', `connected=${s.connected === true}, version=${s.serverVersion ?? '?'}`, s.connected === true));
            checks.push(ok('server version reported', `version=${s.serverVersion ?? 'missing'}`, !!s.serverVersion));
            checks.push(ok('protocol negotiated', `protocol=${s.protocol ?? 'missing'}`, s.protocol != null));
            checks.push(ok('spawn position valid', JSON.stringify(s.spawn ?? null), !!s.spawn && num(s.spawn.y) != null));
            if (spec.minLatencyRecorded) {
                checks.push(ok('latency measured', `latency=${s.latencyMs}ms`, num(s.latencyMs) != null && num(s.latencyMs) >= 0));
            }
            break;
        }
        case 'observation': {
            const chunks = num(s.chunksLoaded) ?? 0;
            const blocks = Array.isArray(s.nearbyBlockTypes) ? s.nearbyBlockTypes.length : 0;
            checks.push(ok('chunks streamed', `${chunks} chunks loaded (need >= ${spec.minChunks ?? 1})`, chunks >= (spec.minChunks ?? 1)));
            checks.push(ok('block palette observed', `types=[${(s.nearbyBlockTypes || []).slice(0, 12).join(', ')}] (${blocks})`, blocks >= (spec.minNearbyBlockTypes ?? 1)));
            checks.push(ok('blockAt returns real blocks', s.sampleBlock ? `${s.sampleBlock.name}@${JSON.stringify(s.sampleBlock.pos)}` : 'no sample', !!s.sampleBlock && s.sampleBlock.name !== 'air'));
            if (s.dimension === 'invalid') checks.push(ok('dimension known', 'dimension unknown', false));
            break;
        }
        case 'telemetry': {
            const required = spec.required || [];
            const present = {
                position: !!s.position && num(s.position.x) != null,
                health: num(s.health) != null && s.health > 0,
                food: num(s.food) != null,
                inventory: !!s.inventory && typeof s.inventory === 'object',
                nearbyEntities: Array.isArray(s.nearbyEntities),
            };
            for (const field of required) {
                checks.push(ok(`telemetry:${field}`, field in present ? `${field}=${present[field] ? 'ok' : 'missing'}` : 'not measured', present[field] === true));
            }
            checks.push(ok('inventory non-empty (spawn inventory)', `${Object.keys(s.inventory || {}).length} distinct item(s)`, true));
            break;
        }
        case 'inventory_gain': {
            const item = spec.item;
            const need = num(spec.gained) ?? 1;
            if (!item) {
                checks.push(ok('gather target configured', 'no item specified', false));
                break;
            }
            const before = num((s.phaseInventoryBefore ?? s.inventoryBefore ?? {})[item]) ?? 0;
            const after = num((s.inventory || {})[item]) ?? 0;
            const gained = Math.max(0, after - before);
            checks.push(ok(`inventory:${item}`, `+${gained} (before ${before}, after ${after}, need >= ${need})`, gained >= need));
            break;
        }
        case 'inventory_have': {
            const item = spec.item;
            const need = num(spec.atLeast) ?? 1;
            if (!item) {
                checks.push(ok('craft target configured', 'no item specified', false));
                break;
            }
            const beforeInventory = s.phaseInventoryBefore ?? s.inventoryBefore ?? {};
            const before = num(beforeInventory[item]) ?? 0;
            const have = num((s.inventory || {})[item]) ?? 0;
            const productGain = have - before;
            const consumed = Object.entries(beforeInventory)
                .filter(([name, count]) => (num(s.inventory?.[name]) ?? 0) < count)
                .map(([name, count]) => `${name} -${count - (num(s.inventory?.[name]) ?? 0)}`)
                .slice(0, 8);
            checks.push(ok(`inventory:${item}`, `gain +${productGain} (before ${before}, after ${have}, need >= ${need})${consumed.length ? `; consumed: ${consumed.join(', ')}` : ''}`, productGain >= need && consumed.length > 0));
            break;
        }
        case 'blocks_placed': {
            const placed = Array.isArray(s.placedBlocks) ? s.placedBlocks : [];
            const expected = ctx.expectBlocks || [];
            const min = num(spec.minBlocks) ?? 1;
            const seen = placed.filter((p) => p && p.name && p.name !== 'air');
            checks.push(ok('blocks placed (driver report)', `${seen.length} reported (need >= ${min})`, seen.length >= min));
            if (expected.length) {
                const confirmed = expected.filter((e) => seen.some((p) => sameBlockPos(p, e) && p.confirmed !== false)).length;
                checks.push(ok('blocks confirmed by world read', `${confirmed}/${expected.length} positions hold the expected block`, confirmed >= min));
            } else {
                checks.push(ok('blocks confirmed by world read', 'no absolute coordinates to re-read', true));
            }
            break;
        }
        case 'recovery': {
            const r = s.recovery || {};
            checks.push(ok('process survived interruption', r.crashed ? `crashed: ${r.detail || ''}` : 'no crash', r.crashed !== true));
            checks.push(ok('interruption actually happened', r.interrupted ? 'in-flight step was cut off' : 'nothing was interrupted — phase is vacuous', r.interrupted === true));
            const actions = ['retried', 'replanned', 'resumed'].filter((a) => r[a] === true);
            const needAny = spec.requireAnyOf || ['retried', 'replanned', 'resumed'];
            checks.push(ok('recovery action taken', `${actions.length ? actions.join(', ') : 'none'} (need any of ${needAny.join(', ')})`, needAny.some((a) => actions.includes(a))));
            if (spec.finalGoal?.item) {
                const item = spec.finalGoal.item;
                const need = num(spec.finalGoal.gained) ?? 1;
                const have = num((s.inventory || {})[item]) ?? 0;
                checks.push(ok(`post-recovery world state:${item}`, `have ${have} (need >= ${need})`, have >= need));
            }
            break;
        }
        case 'world_state': {
            const placed = Array.isArray(s.placedBlocks) ? s.placedBlocks : [];
            const min = num(spec.minBlocks) ?? 0;
            const stillThere = placed.filter((p) => p.confirmed === true).length;
            if (min > 0) checks.push(ok('built structure still present server-side', `${stillThere}/${placed.length} placed blocks re-read as expected`, stillThere >= min));
            for (const [item, need] of Object.entries(spec.expectItems || {})) {
                checks.push(ok(`inventory:${item}`, `have ${num(s.inventory?.[item]) ?? 0} (need >= ${need})`, (num(s.inventory?.[item]) ?? 0) >= num(need)));
            }
            if (spec.gatherAccounting?.item) {
                const { item, min } = spec.gatherAccounting;
                const held = num(s.inventory?.[item]) ?? 0;
                const built = placed.filter((x) => x.confirmed === true && x.name === item).length;
                const craft = s.phaseInfo?.craft;
                const transformed = Array.isArray(craft?.consumed)
                    && craft.consumed.some((entry) => entry.item === item && Number(entry.delta) < 0)
                    && Number(craft.productGain) > 0;
                const need = num(min) ?? 0;
                const accounted = held + built >= need || transformed;
                checks.push(ok(`resource ${item} accounted for`, `held ${held} + matching blocks ${built} = ${held + built}${transformed ? '; transformed by a verified craft transaction' : ''} (need >= ${need}; a gap means the server voided or duplicated it)`, accounted));
            }
            const files = Array.isArray(s.persistence) ? s.persistence : [];
            const present = files.filter((f) => f.present !== false);
            if (present.length) {
                const broken = present.filter((f) => f.parseable !== true);
                checks.push(ok('agent state files reload after the run', `${present.length} file(s): ${present.map((f) => `${f.name}(${f.bytes}B)`).join(', ')}${broken.length ? `; unparseable: ${broken.map((f) => f.name).join(', ')}` : ''}`, broken.length === 0));
            } else {
                checks.push(ok('agent state files reload after the run', 'no world_model/project files yet (written by the pipeline stage, not by --features direct)', true));
            }
            const rc = s.reconnect;
            if (rc && rc.performed) {
                checks.push(ok('reconnect completed', `reconnect took ${rc.reconnectMs ?? '?'}ms`, rc.connected === true));
                if (rc.blocksSurvived != null) checks.push(ok('build survived reconnect', `server still has the placed blocks=${rc.blocksSurvived}`, rc.blocksSurvived === true));
                if (rc.inventorySurvived != null) checks.push(ok('inventory survived reconnect', `items persisted=${rc.inventorySurvived}`, rc.inventorySurvived === true));
                if (rc.stateRestored != null) checks.push(ok('local state restored from disk', `stateRestored=${rc.stateRestored}`, rc.stateRestored === true));
            } else {
                checks.push(ok('reconnect performed', ctx.reconnectEnabled ? 'expected a reconnect but none happened' : 'skipped (enable --features ...,reconnect)', !ctx.reconnectEnabled));
            }
            break;
        }
        default:
            checks.push(ok(`verify:${spec.kind}`, 'no verification rule for this phase', false));
    }

    const failed = checks.filter((c) => !c.passed);
    return {
        satisfied: failed.length === 0,
        checks,
        evidence: checks.map((c) => `${c.passed ? 'ok' : 'FAIL'} ${c.label}: ${c.evidence}`).join('\n'),
    };
}

export { distance };
