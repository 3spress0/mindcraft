/**
 * scoring.js — standardized scoring across benchmark scenarios.
 *
 * Provides:
 * - Single-run scoring (0-100) with breakdown
 * - Multi-scenario aggregate scoring
 * - Recovery quality assessment
 * - Leaderboard generation
 */

export const SCORE_WEIGHTS = {
    completion: 40,
    efficiency: 25,
    recovery: 25,
    robustness: 10,
};

export const SCENARIO_DIFFICULTY = {
    wheat_farm_benchmark: 1.0,
    iron_mine_benchmark: 1.2,
    shelter_build_benchmark: 1.1,
    tree_farm_benchmark: 1.0,
    village_outpost_benchmark: 1.3,
    nether_expedition_benchmark: 1.5,
};

/**
 * Compute standardized score for a single run.
 * Delegates to metrics.computeScore() if available, otherwise computes directly.
 */
export function computeStandardScore(metrics, scenario = null) {
    if (metrics.computeScore) {
        return metrics.computeScore();
    }
    // Fallback if metrics is plain object
    const completion = metrics.completion ? 40 : Math.round((metrics.completionPct || 0) / 100 * 35);
    let efficiency = 25;
    efficiency -= Math.min(10, (metrics.retries || 0) * 2);
    efficiency -= Math.min(10, (metrics.replans || 0) * 3);
    efficiency -= Math.min(5, metrics.resource_waste || 0);
    efficiency = Math.max(0, efficiency);

    let recovery = 15;
    if (metrics.recovery_quality?.score) {
        recovery = Math.round(metrics.recovery_quality.score / 100 * 25);
    }

    let robustness = 10;
    robustness -= Math.min(6, (metrics.deaths || 0) * 3);
    if (metrics.interruptions > 0 && metrics.interruptions === metrics.resumes) robustness = Math.min(10, robustness + 2);

    return {
        total: completion + efficiency + recovery + robustness,
        completion,
        efficiency,
        recovery,
        robustness,
        breakdown: {},
    };
}

/**
 * Adjust score by scenario difficulty.
 */
export function applyDifficulty(score, scenarioName) {
    const diff = SCENARIO_DIFFICULTY[scenarioName] || 1.0;
    return {
        ...score,
        total: Math.round(score.total * diff),
        raw_total: score.total,
        difficulty: diff,
        scenario: scenarioName,
    };
}

/**
 * Aggregate scores across multiple scenarios for a single model.
 * @param {Array} metricsList - list of BenchmarkMetrics or summary objects
 * @returns {object} aggregate report
 */
export function aggregateScores(metricsList) {
    if (!metricsList.length) return null;

    const byScenario = {};
    for (const m of metricsList) {
        const scenario = m.scenario || m.scenarioName || 'unknown';
        if (!byScenario[scenario]) byScenario[scenario] = [];
        byScenario[scenario].push(m);
    }

    const scenarioScores = {};
    for (const [scenario, runs] of Object.entries(byScenario)) {
        const scores = runs.map(r => r.score?.total || computeStandardScore(r).total);
        const avg = scores.reduce((a, b) => a + b, 0) / scores.length;
        const best = Math.max(...scores);
        const worst = Math.min(...scores);
        const completions = runs.filter(r => r.completion).length / runs.length;
        scenarioScores[scenario] = {
            scenario,
            runs: runs.length,
            avgScore: Math.round(avg),
            bestScore: best,
            worstScore: worst,
            completionRate: completions,
            difficulty: SCENARIO_DIFFICULTY[scenario] || 1.0,
            weightedAvg: Math.round(avg * (SCENARIO_DIFFICULTY[scenario] || 1.0)),
        };
    }

    const allScores = metricsList.map(m => m.score?.total || computeStandardScore(m).total);
    const overallAvg = allScores.reduce((a, b) => a + b, 0) / allScores.length;
    const overallWeighted = Object.values(scenarioScores).reduce((s, sc) => s + sc.weightedAvg, 0) / Object.keys(scenarioScores).length;
    const overallCompletion = metricsList.filter(m => m.completion).length / metricsList.length;

    return {
        totalRuns: metricsList.length,
        scenarios: Object.keys(byScenario).length,
        overallAvg: Math.round(overallAvg),
        overallWeighted: Math.round(overallWeighted),
        overallCompletion,
        scenarioScores,
        allScores,
    };
}

/**
 * Assess recovery quality beyond simple success/failure.
 * Returns detailed quality report.
 */
export function assessRecoveryQuality(metrics, scenario = null) {
    const expected = scenario?.expected_recoveries || [];
    const checks = metrics.recovery_quality?.checks || [];

    const total = expected.length;
    const satisfied = checks.filter(c => c.satisfied).length;

    // Analyze recovery actions
    const actions = metrics.recovery_actions || {};
    const reasons = metrics.recovery_reasons || {};

    // Did recovery lead to eventual success?
    const recoveryLedToSuccess = metrics.completion && (metrics.failed_steps > 0);

    // Waste during recovery
    const wastePenalty = metrics.resource_waste > 5 ? 'high' : metrics.resource_waste > 2 ? 'medium' : 'low';

    // Efficiency of recovery
    const avgAttempts = metrics.failed_steps > 0 ? (metrics.retries + metrics.failed_steps) / metrics.failed_steps : 1;

    let grade = 'F';
    const qualityScore = metrics.recovery_quality?.score || 0;
    if (qualityScore >= 90) grade = 'A';
    else if (qualityScore >= 75) grade = 'B';
    else if (qualityScore >= 60) grade = 'C';
    else if (qualityScore >= 40) grade = 'D';

    return {
        totalExpected: total,
        satisfied,
        correctRate: total > 0 ? satisfied / total : 1,
        recoveryLedToSuccess,
        wastePenalty,
        avgAttempts,
        actions,
        reasons,
        qualityScore,
        grade,
        details: checks,
    };
}

/**
 * Generate leaderboard from multiple models/runs.
 * @param {Object} byModel - from BenchmarkStore.compareByModel()
 */
export function generateLeaderboard(byModel) {
    const entries = Object.values(byModel).map(m => ({
        model: m.model,
        avgScore: m.avgScore,
        completionRate: m.completionRate,
        runs: m.runs,
        scenarios: m.scenarios.length,
        best: m.bestRun?.score || 0,
        worst: m.worstRun?.score || 0,
    }));

    entries.sort((a, b) => b.avgScore - a.avgScore);

    return entries.map((e, i) => ({
        rank: i + 1,
        ...e,
    }));
}

export function formatScoreReport(metrics) {
    const score = metrics.score || computeStandardScore(metrics);
    return [
        `Scenario: ${metrics.scenarioName || metrics.scenario}`,
        `Model: ${metrics.plannerModel || metrics.model || 'unknown'}`,
        `Completion: ${metrics.completion ? '✓' : '✗'} (${metrics.completionPct}%)`,
        `Score: ${score.total}/100 (C:${score.completion} E:${score.efficiency} R:${score.recovery} Rob:${score.robustness})`,
        `Steps: ${metrics.successful_steps}/${metrics.total_steps} success, ${metrics.failed_steps} failed, ${metrics.retries} retries, ${metrics.replans} replans`,
        `Recovery: ${metrics.recovery_quality?.expected_satisfied || 0}/${metrics.recovery_quality?.expected_total || 0} expected satisfied, quality ${metrics.recovery_quality?.score || 0}/100`,
        `Robustness: ${metrics.deaths} deaths, ${metrics.interruptions} interruptions → ${metrics.resumes} resumes`,
        `Efficiency: ${metrics.resource_waste} waste, ${metrics.LLM_calls} LLM calls, ${metrics.execution_time}ms`,
    ].join('\n');
}
