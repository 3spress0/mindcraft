/**
 * model_fallback.js — cross-provider LLM fallback chain.
 * (GO list: LLM failure fallback.)
 *
 * Wraps a model object so transient provider failures (network errors,
 * rate limits, 5xx) advance to the next configured model instead of failing
 * the turn. The wrapper is a Proxy: every property/method forwards to
 * whichever model is "current", so prompter code keeps using the model
 * exactly as before. Once a fallback proves itself it becomes current for
 * subsequent calls.
 *
 * Validation-type errors (bad request, auth) do NOT retry — falling over on
 * those would mask real configuration problems.
 */

/** Heuristic: is this error transient/provider-side (worth failing over)? */
export function isTransientProviderError(err) {
    const msg = String(err?.message ?? err ?? '').toLowerCase();
    if (!msg) return false;
    if (/fetch failed|network|socket|econnreset|econnrefused|enotfound|etimedout|eai_again/.test(msg)) return true;
    if (/rate.?limit|too many requests|429|quota|overloaded|server error|5\d\d|502|503|504/.test(msg)) return true;
    if (/timeout|timed out/.test(msg)) return true;
    if (/temporarily unavailable|service unavailable|try again/.test(msg)) return true;
    return false;
}

/**
 * Wrap a primary model with lazy fallbacks.
 * @param {object} primary - the model instance normally used
 * @param {Function} makeFallbacks - () => [model, model...] built on demand
 * @param {object} [opts] { shouldRetry, onFallback }
 */
export function wrapModelWithFallbacks(primary, makeFallbacks, {
    shouldRetry = isTransientProviderError,
    onFallback = null
} = {}) {
    let state = { current: primary, fallbacks: null, activeIndex: -1 };

    const ensureFallbacks = () => {
        if (state.fallbacks == null) {
            try { state.fallbacks = makeFallbacks?.() ?? []; }
            catch { state.fallbacks = []; }
        }
        return state.fallbacks;
    };

    const chain = () => [state.current, ...ensureFallbacks().filter(m => m && m !== state.current)];

    async function promptWithFallback(...args) {
        const candidates = chain();
        let lastErr = null;
        for (let i = 0; i < candidates.length; i++) {
            const model = candidates[i];
            try {
                const res = await model.prompt(...args);
                if (model !== state.current) {
                    state.current = model; // stick with what worked
                    try { onFallback?.(model, i); } catch { /* advisory */ }
                }
                return res;
            } catch (err) {
                lastErr = err;
                if (!shouldRetry(err)) throw err; // non-transient: surface it
            }
        }
        throw lastErr ?? new Error('all models in the fallback chain failed');
    }

    return new Proxy(primary, {
        get(target, prop) {
            if (prop === 'prompt') return promptWithFallback;
            if (prop === '__fallback_state') return state; // test hook
            const value = Reflect.get(state.current ?? target, prop);
            return typeof value === 'function' ? value.bind(state.current ?? target) : value;
        },
        set(target, prop, value) {
            try { (state.current ?? target)[prop] = value; } catch { /* best effort */ }
            return true;
        },
        has(target, prop) {
            return prop in (state.current ?? target);
        }
    });
}
