/**
 * error_classes.js — error categorization (GO list: reliability).
 * Maps any thrown error or message string onto a small, stable taxonomy so
 * metrics, logs, and replan decisions can branch on *what kind* of failure
 * happened instead of string-matching ad hoc. Never throws.
 */

/** Stable error categories, ordered roughly by how actionable they are. */
export const ERROR_CATEGORIES = [
    'timeout',          // action/LLM/path ran out of time
    'rate_limited',     // provider 429 / throttling
    'network',          // connectivity, DNS, fetch failures
    'llm',              // model/provider errors that are not rate limits
    'pathfinding',      // no path, path reset, goal unreachable
    'inventory',        // missing items, chest unreachable, desync
    'world',            // unloaded chunks, missing blocks, bad position
    'permission',       // server/anti-cheat rejection, protected region
    'construction',     // build damage / placement failures
    'interrupted',      // user !stop / goal cancel
    'unknown'
];

const RULES = [
    [/interrupt|cancel(led)?|!stop|goal was reset|user abort/i, 'interrupted'],
    [/timed?\s?out|deadline|exceeded .*time|took too long/i, 'timeout'],
    [/rate.?limit|429|too many requests|throttl|quota/i, 'rate_limited'],
    [/econnreset|econnrefused|enotfound|eai_again|network|fetch failed|socket hang|disconnected|etimedout/i, 'network'],
    [/no path|path reset|cannot reach|unreachable|pathfinding|goal (was )?changed|stuck( in)?/i, 'pathfinding'],
    [/no such item|not enough (of )?(items|resources)|chest (not|un)?reachable|desync|could not (take|put|craft)|missing .*item/i, 'inventory'],
    [/chunk(s)? (not |un)?load|block(at)? (is )?null|unknown dimension|invalid position|out of world bounds/i, 'world'],
    [/permission|not allowed|protected|denied|anti.?cheat|banned|kicked/i, 'permission'],
    [/model|provider|llm|completion|prompt (is )?too long|context length|invalid (api )?key|response format/i, 'llm'],
    [/build|placement|schematic|(block )?damaged|construction/i, 'construction']
];

/**
 * Categorize an error (Error object or string).
 * @param {Error|string|*} err
 * @returns {{category:string, detail:string}} category is always one of
 *          ERROR_CATEGORIES; detail is a short stable excerpt.
 */
export function classifyError(err) {
    let msg = '';
    try {
        if (err == null) msg = '';
        else if (typeof err === 'string') msg = err;
        else msg = err?.message ?? String(err);
    } catch { msg = 'unknown'; }
    msg = String(msg || 'unknown error');
    for (const [re, category] of RULES) {
        if (re.test(msg)) {
            return { category, detail: msg.slice(0, 120) };
        }
    }
    return { category: 'unknown', detail: msg.slice(0, 120) };
}

/**
 * Whether this category is worth an immediate retry (vs. needs a replan or a
 * human). Advisory heuristic used by loops/backoff logic.
 */
export function retryableCategory(category) {
    return ['timeout', 'rate_limited', 'network', 'world'].includes(category);
}
