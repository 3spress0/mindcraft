/**
 * llm_planner.js — real-LLM planner adapter for the deterministic benchmark framework.
 *
 * The deterministic benchmark pipeline is:
 *
 *   Scenario → Planner → Executor → Observer → WorldModel → Critic → Recovery/Replan → Metrics
 *
 * This module provides the smallest adapter that lets the exact same pipeline run with a
 * real planner model: it only replaces the planner's model-decision function
 * (`sendRequest(messages, system) -> response text`). It never touches FakeBot internals,
 * the executor, observer, world model, critic, or recovery/verification logic.
 *
 * Model configuration reuses the repository's existing profile format:
 *
 *   plannerModel: { provider: "openai", model: "gpt-5.4-mini", params: {...} }
 *
 * which is resolved through `src/models/_model_map.js` (selectAPI/createModel) and the
 * existing `settings_llm_providers.json` / environment key mechanism. No API keys are
 * read or stored here; key lookup stays inside `src/utils/keys.js`.
 *
 * Safety: every adapter enforces configurable call, retry, timeout, and optional cost
 * limits so a runaway benchmark cannot make unlimited API calls.
 */

export const BENCHMARK_VERSION = '1.1.0';
export const BENCHMARK_SCHEMA_VERSION = 2;
export const DETERMINISTIC_SCHEMA_VERSION = 1;

export const DEFAULT_LLM_LIMITS = {
    maxModelCalls: 50, // per-scenario cap on top-level planner model calls
    maxRetries: 2, // per-call retries after failure/timeout
    timeoutMs: 60000, // per-attempt timeout
    maxEstimatedCost: null, // optional USD cap (suite or scenario, enforced by caller)
};

export class BenchmarkLlmError extends Error {
    constructor(message, code = 'MODEL_CALL_FAILED', details = {}) {
        super(message);
        this.name = 'BenchmarkLlmError';
        this.code = code;
        this.details = details;
    }
}

/**
 * True when the planner model selects the deterministic stub path.
 * Backwards compatible: every string planner model (e.g. 'deterministic',
 * 'deterministic-ci', 'deterministic-baseline') stays deterministic.
 * Only an object config selects a real LLM.
 */
export function isDeterministicPlannerModel(plannerModel) {
    return typeof plannerModel === 'string' || plannerModel == null;
}

/**
 * Normalize a plannerModel (string or object) into a stable descriptor.
 * @returns {{ mode: 'deterministic'|'llm', label: string, provider: string|null,
 *   model: string|null, configId: string|null, rawConfig: object|null }}
 */
export function normalizePlannerModelConfig(plannerModel) {
    if (plannerModel == null || typeof plannerModel === 'string') {
        const label = plannerModel == null ? 'deterministic' : String(plannerModel);
        return {
            mode: 'deterministic',
            label,
            provider: 'deterministic',
            model: label,
            configId: label,
            rawConfig: null,
        };
    }
    if (typeof plannerModel === 'object') {
        const provider = plannerModel.provider || plannerModel.api || 'unknown';
        const model = plannerModel.model || plannerModel.defaultModel || plannerModel.default_model || 'default';
        const configId = `${provider}/${model}`;
        return {
            mode: 'llm',
            label: plannerModel.label || configId,
            provider: String(provider),
            model: String(model),
            configId,
            rawConfig: { ...plannerModel },
        };
    }
    return {
        mode: 'deterministic',
        label: 'deterministic',
        provider: 'deterministic',
        model: 'deterministic',
        configId: 'deterministic',
        rawConfig: null,
    };
}

/**
 * Default factory: build a real model instance via the repo's existing
 * provider registry (settings_llm_providers.json + env keys).
 */
export async function defaultBenchmarkModelFactory(modelConfig) {
    const { selectAPI, createModel } = await import('../../models/_model_map.js');
    const resolved = selectAPI(JSON.parse(JSON.stringify(modelConfig || {})));
    return createModel(resolved);
}

/**
 * Estimate USD cost from token counts and explicit pricing only.
 * Pricing shape: { input_per_1k, output_per_1k } and/or { input_per_1m, output_per_1m }.
 * Returns null when pricing or both token counts are unknown — never fabricates values.
 */
export function estimateCost({ inputTokens = null, outputTokens = null } = {}, pricing = null) {
    if (!pricing || typeof pricing !== 'object') return null;
    const inPer1k = Number(pricing.input_per_1k);
    const outPer1k = Number(pricing.output_per_1k);
    const inPer1m = Number(pricing.input_per_1m);
    const outPer1m = Number(pricing.output_per_1m);
    const hasIn = Number.isFinite(inPer1k) || Number.isFinite(inPer1m);
    const hasOut = Number.isFinite(outPer1k) || Number.isFinite(outPer1m);
    if (!hasIn && !hasOut) return null;
    if (inputTokens == null && outputTokens == null) return null;
    let cost = 0;
    let known = false;
    if (inputTokens != null && Number.isFinite(Number(inputTokens))) {
        if (Number.isFinite(inPer1k)) {
            cost += (Number(inputTokens) / 1000) * inPer1k;
            known = true;
        } else if (Number.isFinite(inPer1m)) {
            cost += (Number(inputTokens) / 1000000) * inPer1m;
            known = true;
        }
    }
    if (outputTokens != null && Number.isFinite(Number(outputTokens))) {
        if (Number.isFinite(outPer1k)) {
            cost += (Number(outputTokens) / 1000) * outPer1k;
            known = true;
        } else if (Number.isFinite(outPer1m)) {
            cost += (Number(outputTokens) / 1000000) * outPer1m;
            known = true;
        }
    }
    return known ? cost : null;
}

function resolvePricing(modelConfig, limits, explicitPricing) {
    return explicitPricing
        || limits?.pricing
        || modelConfig?.pricing
        || modelConfig?.params?.pricing
        || null;
}

function readTokenUsage(model) {
    const usage = model?.lastTokenUsage;
    if (!usage || typeof usage !== 'object') return { inputTokens: null, outputTokens: null, totalTokens: null };
    const inputTokens = usage.input_total ?? usage.input_uncached ?? null;
    const outputTokens = usage.output ?? null;
    const totalTokens = usage.total ?? ((inputTokens != null || outputTokens != null)
        ? (Number(inputTokens) || 0) + (Number(outputTokens) || 0)
        : null);
    return {
        inputTokens: inputTokens == null ? null : Number(inputTokens),
        outputTokens: outputTokens == null ? null : Number(outputTokens),
        totalTokens: totalTokens == null ? null : Number(totalTokens),
    };
}

function withTimeout(promise, ms, onTimeout) {
    if (ms == null || !(ms > 0)) return promise;
    let timer = null;
    const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => {
            const err = new BenchmarkLlmError(`Model call timed out after ${ms}ms`, 'TIMEOUT', { timeoutMs: ms });
            if (onTimeout) {
                try { onTimeout(err); } catch { /* ignore */ }
            }
            reject(err);
        }, ms);
        if (timer.unref) timer.unref();
    });
    return Promise.race([promise, timeout]).finally(() => {
        if (timer) clearTimeout(timer);
    });
}

/**
 * Adapter wrapping a real provider model as a benchmark planner `sendRequest`.
 * Tracks calls, retries, tokens, cost, and latency; enforces limits.
 */
export class LlmPlannerAdapter {
    constructor({ modelConfig, metrics = null, limits = {}, modelFactory = null, pricing = null } = {}) {
        if (!modelConfig || typeof modelConfig !== 'object') {
            throw new BenchmarkLlmError('LlmPlannerAdapter requires a model config object', 'MODEL_INIT_FAILED');
        }
        this.modelConfig = { ...modelConfig };
        this.normalized = normalizePlannerModelConfig(modelConfig);
        this.metrics = metrics || null;
        this.limits = { ...DEFAULT_LLM_LIMITS, ...(limits || {}) };
        this.modelFactory = modelFactory || defaultBenchmarkModelFactory;
        this.pricing = resolvePricing(this.modelConfig, this.limits, pricing);

        this.model = null;
        this.calls = 0;
        this.successfulCalls = 0;
        this.failedCalls = 0;
        this.retries = 0;
        this.inputTokens = 0;
        this.outputTokens = 0;
        this.totalTokens = 0;
        this.hasTokenData = false;
        this.estimatedCost = 0;
        this.hasCostData = false;
        this.latencyMs = [];
        this.plannerFailures = 0;
        this.plannerOutputs = [];
        this.initError = null;
    }

    get label() {
        return this.normalized.label;
    }

    get provider() {
        return this.normalized.provider;
    }

    get modelName() {
        return this.normalized.model;
    }

    get configId() {
        return this.normalized.configId;
    }

    async ensureModel() {
        if (this.model) return this.model;
        if (this.initError) throw this.initError;
        try {
            this.model = await this.modelFactory({ ...this.modelConfig });
        } catch (err) {
            this.initError = err instanceof BenchmarkLlmError
                ? err
                : new BenchmarkLlmError(`Failed to initialize benchmark model: ${err.message}`, 'MODEL_INIT_FAILED', { cause: String(err.message) });
            throw this.initError;
        }
        if (!this.model || typeof this.model.sendRequest !== 'function') {
            this.initError = new BenchmarkLlmError('Benchmark model factory did not return a usable model (missing sendRequest)', 'MODEL_INIT_FAILED');
            throw this.initError;
        }
        return this.model;
    }

    /**
     * Planner-compatible sendRequest(messages, system) with limits + metrics.
     */
    async sendRequest(messages, system) {
        const maxCalls = this.limits.maxModelCalls;
        if (maxCalls != null && this.calls >= maxCalls) {
            throw new BenchmarkLlmError(
                `Benchmark model call limit exceeded (${this.calls}/${maxCalls} for ${this.label})`,
                'LIMIT_EXCEEDED',
                { calls: this.calls, maxModelCalls: maxCalls }
            );
        }
        const maxCost = this.limits.maxEstimatedCost;
        if (maxCost != null && this.hasCostData && this.estimatedCost >= maxCost) {
            throw new BenchmarkLlmError(
                `Benchmark estimated-cost limit exceeded ($${this.estimatedCost.toFixed(4)} >= $${Number(maxCost).toFixed(4)})`,
                'COST_EXCEEDED',
                { estimatedCost: this.estimatedCost, maxEstimatedCost: maxCost }
            );
        }

        const model = await this.ensureModel();
        const maxRetries = Math.max(0, this.limits.maxRetries ?? 0);
        const timeoutMs = this.limits.timeoutMs;

        let attempt = 0;
        let lastError = null;
        // attempts = 1 initial + maxRetries retries
        while (attempt <= maxRetries) {
            if (attempt > 0) {
                this.retries += 1;
                if (this.metrics && typeof this.metrics.recordModelRetry === 'function') {
                    this.metrics.recordModelRetry();
                }
            }
            const started = Date.now();
            try {
                const response = await withTimeout(
                    Promise.resolve().then(() => model.sendRequest(messages, system)),
                    timeoutMs
                );
                const latency = Date.now() - started;
                const { inputTokens, outputTokens, totalTokens } = readTokenUsage(model);
                const cost = estimateCost({ inputTokens, outputTokens }, this.pricing);
                this._recordSuccess({ latency, inputTokens, outputTokens, totalTokens, cost });
                this._recordPlannerOutput({ messages, system, response, inputTokens, outputTokens, totalTokens, cost, latencyMs: latency, attempt, error: null });
                this._checkCostLimit();
                return response;
            } catch (err) {
                const latency = Date.now() - started;
                lastError = err;
                this.latencyMs.push(latency);
                if (err instanceof BenchmarkLlmError && (err.code === 'LIMIT_EXCEEDED' || err.code === 'COST_EXCEEDED')) {
                    throw err;
                }
                const isTimeout = err instanceof BenchmarkLlmError && err.code === 'TIMEOUT';
                this._recordPlannerOutput({
                    messages, system, response: null,
                    inputTokens: null, outputTokens: null, totalTokens: null, cost: null,
                    latencyMs: latency, attempt,
                    error: { message: String(err.message || err), code: err.code || (isTimeout ? 'TIMEOUT' : 'MODEL_CALL_FAILED') },
                });
                attempt += 1;
                if (attempt > maxRetries) break;
            }
        }

        this._recordFailure();
        if (lastError instanceof BenchmarkLlmError) throw lastError;
        throw new BenchmarkLlmError(
            `Benchmark model call failed after ${maxRetries + 1} attempt(s): ${lastError?.message || lastError}`,
            lastError?.code === 'TIMEOUT' ? 'TIMEOUT' : 'MODEL_CALL_FAILED',
            { attempts: maxRetries + 1, cause: String(lastError?.message || lastError) }
        );
    }

    _recordSuccess({ latency, inputTokens, outputTokens, totalTokens, cost }) {
        this.calls += 1;
        this.successfulCalls += 1;
        this.latencyMs.push(latency);
        if (inputTokens != null) {
            this.inputTokens += Number(inputTokens) || 0;
            this.hasTokenData = true;
        }
        if (outputTokens != null) {
            this.outputTokens += Number(outputTokens) || 0;
            this.hasTokenData = true;
        }
        if (totalTokens != null) {
            this.totalTokens += Number(totalTokens) || 0;
            this.hasTokenData = true;
        } else if (inputTokens != null || outputTokens != null) {
            this.totalTokens += (Number(inputTokens) || 0) + (Number(outputTokens) || 0);
        }
        if (cost != null) {
            this.estimatedCost += Number(cost) || 0;
            this.hasCostData = true;
        }
        if (this.metrics && typeof this.metrics.recordModelCall === 'function') {
            this.metrics.recordModelCall({
                success: true,
                inputTokens, outputTokens, totalTokens,
                estimatedCost: cost, latencyMs: latency,
            });
        }
    }

    _recordFailure() {
        this.calls += 1;
        this.failedCalls += 1;
        this.plannerFailures += 1;
        if (this.metrics && typeof this.metrics.recordModelCall === 'function') {
            this.metrics.recordModelCall({ success: false, plannerFailed: true });
        }
    }

    _checkCostLimit() {
        const maxCost = this.limits.maxEstimatedCost;
        if (maxCost != null && this.hasCostData && this.estimatedCost >= maxCost) {
            throw new BenchmarkLlmError(
                `Benchmark estimated-cost limit exceeded ($${this.estimatedCost.toFixed(4)} >= $${Number(maxCost).toFixed(4)})`,
                'COST_EXCEEDED',
                { estimatedCost: this.estimatedCost, maxEstimatedCost: maxCost }
            );
        }
    }

    _recordPlannerOutput(entry) {
        const response = typeof entry.response === 'string'
            ? entry.response.slice(0, 8000)
            : entry.response;
        this.plannerOutputs.push({
            at: Date.now(),
            provider: this.provider,
            model: this.modelName,
            configId: this.configId,
            attempt: entry.attempt,
            latencyMs: entry.latencyMs,
            inputTokens: entry.inputTokens,
            outputTokens: entry.outputTokens,
            totalTokens: entry.totalTokens,
            estimatedCost: entry.estimatedCost,
            response,
            error: entry.error,
        });
        // Bound memory: keep the most recent 50 planner outputs.
        if (this.plannerOutputs.length > 50) {
            this.plannerOutputs.splice(0, this.plannerOutputs.length - 50);
        }
    }

    getStats() {
        const cumulative = this.latencyMs.reduce((a, b) => a + b, 0);
        return {
            provider: this.provider,
            model: this.modelName,
            configId: this.configId,
            calls: this.calls,
            successfulCalls: this.successfulCalls,
            failedCalls: this.failedCalls,
            retries: this.retries,
            inputTokens: this.hasTokenData ? this.inputTokens : null,
            outputTokens: this.hasTokenData ? this.outputTokens : null,
            totalTokens: this.hasTokenData ? this.totalTokens : null,
            estimatedCost: this.hasCostData ? this.estimatedCost : null,
            cumulativeLatencyMs: cumulative,
            avgLatencyMs: this.calls > 0 ? Math.round(cumulative / this.calls) : 0,
            plannerFailures: this.plannerFailures,
        };
    }

    getPlannerOutputs() {
        return this.plannerOutputs.map((o) => ({ ...o }));
    }
}
