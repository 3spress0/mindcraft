/**
 * thresholds.js — regression thresholds for CI.
 *
 * Defines baseline expectations per scenario and checks if current runs
 * regress beyond allowed tolerance. Fails CI if autonomy gets worse.
 */

import fs from 'fs';
import path from 'path';

export const DEFAULT_THRESHOLDS = {
    // Global thresholds
    global: {
        minAvgScore: 50,
        minCompletionRate: 0.7,
        maxAvgReplans: 5,
        maxAvgRetries: 8,
        maxAvgDeaths: 2,
        maxRegressionPct: 15, // allow 15% drop from baseline before failing
    },
    // Per-scenario thresholds (override global)
    scenarios: {
        wheat_farm_benchmark: {
            minScore: 60,
            minCompletion: 1, // must complete
            maxReplans: 3,
            maxRetries: 5,
        },
        iron_mine_benchmark: {
            minScore: 55,
            minCompletion: 0.8,
            maxReplans: 4,
            maxDeaths: 1,
        },
        shelter_build_benchmark: {
            minScore: 60,
            minCompletion: 1,
            maxReplans: 3,
        },
        tree_farm_benchmark: {
            minScore: 50,
            minCompletion: 0.8,
            maxReplans: 4,
        },
        village_outpost_benchmark: {
            minScore: 55,
            minCompletion: 0.7,
            maxReplans: 5,
        },
        nether_expedition_benchmark: {
            minScore: 45,
            minCompletion: 0.6,
            maxDeaths: 2,
        },
        adversarial_depleted_alternatives_benchmark: {
            minScore: 50,
            minCompletion: 0.8,
            maxReplans: 4,
            maxRetries: 6,
        },
        adversarial_trap_target_benchmark: {
            minScore: 50,
            minCompletion: 0.8,
            maxReplans: 4,
            maxDeaths: 1,
        },
    },
};

export class ThresholdChecker {
    constructor({ thresholds = DEFAULT_THRESHOLDS, baselinePath = null, baseline = null } = {}) {
        this.thresholds = thresholds;
        this.baseline = baseline;
        if (baselinePath && fs.existsSync(baselinePath)) {
            try {
                this.baseline = JSON.parse(fs.readFileSync(baselinePath, 'utf8'));
            } catch {}
        }
    }

    /**
     * Check single run against thresholds.
     * @returns {Array} violations
     */
    checkRun(metrics) {
        const violations = [];
        const scenario = metrics.scenario || metrics.scenarioName;
        const scenarioThresholds = this.thresholds.scenarios[scenario] || {};
        const score = metrics.score?.total || 0;

        if (scenarioThresholds.minScore != null && score < scenarioThresholds.minScore) {
            violations.push({
                type: 'score_below_min',
                scenario,
                actual: score,
                expected: scenarioThresholds.minScore,
                message: `Score ${score} below minimum ${scenarioThresholds.minScore} for ${scenario}`,
            });
        }

        if (scenarioThresholds.minCompletion != null) {
            const completion = metrics.completion ? 1 : (metrics.completionPct || 0) / 100;
            if (completion < scenarioThresholds.minCompletion) {
                violations.push({
                    type: 'completion_below_min',
                    scenario,
                    actual: completion,
                    expected: scenarioThresholds.minCompletion,
                    message: `Completion ${completion} below minimum ${scenarioThresholds.minCompletion} for ${scenario}`,
                });
            }
        }

        if (scenarioThresholds.maxReplans != null && (metrics.replans || 0) > scenarioThresholds.maxReplans) {
            violations.push({
                type: 'replans_above_max',
                scenario,
                actual: metrics.replans,
                expected: scenarioThresholds.maxReplans,
                message: `Replans ${metrics.replans} above maximum ${scenarioThresholds.maxReplans} for ${scenario}`,
            });
        }

        if (scenarioThresholds.maxRetries != null && (metrics.retries || 0) > scenarioThresholds.maxRetries) {
            violations.push({
                type: 'retries_above_max',
                scenario,
                actual: metrics.retries,
                expected: scenarioThresholds.maxRetries,
                message: `Retries ${metrics.retries} above maximum ${scenarioThresholds.maxRetries} for ${scenario}`,
            });
        }

        if (scenarioThresholds.maxDeaths != null && (metrics.deaths || 0) > scenarioThresholds.maxDeaths) {
            violations.push({
                type: 'deaths_above_max',
                scenario,
                actual: metrics.deaths,
                expected: scenarioThresholds.maxDeaths,
                message: `Deaths ${metrics.deaths} above maximum ${scenarioThresholds.maxDeaths} for ${scenario}`,
            });
        }

        return violations;
    }

    /**
     * Check aggregate results against global thresholds and baseline regression.
     * @param {Array} metricsList - list of metrics
     * @returns {object} { violations, passed, summary }
     */
    checkAggregate(metricsList) {
        const violations = [];
        if (!metricsList.length) {
            return { violations: [{ type: 'no_runs', message: 'No runs to check' }], passed: false, summary: {} };
        }

        // Per-run checks
        for (const m of metricsList) {
            violations.push(...this.checkRun(m.summary ? m.summary() : m));
        }

        // Global checks
        const avgScore = metricsList.reduce((s, m) => s + (m.score?.total || m.score || 0), 0) / metricsList.length;
        const completionRate = metricsList.filter(m => m.completion).length / metricsList.length;
        const avgReplans = metricsList.reduce((s, m) => s + (m.replans || 0), 0) / metricsList.length;
        const avgRetries = metricsList.reduce((s, m) => s + (m.retries || 0), 0) / metricsList.length;
        const avgDeaths = metricsList.reduce((s, m) => s + (m.deaths || 0), 0) / metricsList.length;

        const global = this.thresholds.global;

        if (global.minAvgScore != null && avgScore < global.minAvgScore) {
            violations.push({
                type: 'global_score_low',
                actual: avgScore,
                expected: global.minAvgScore,
                message: `Global avg score ${avgScore.toFixed(1)} below minimum ${global.minAvgScore}`,
            });
        }

        if (global.minCompletionRate != null && completionRate < global.minCompletionRate) {
            violations.push({
                type: 'global_completion_low',
                actual: completionRate,
                expected: global.minCompletionRate,
                message: `Global completion rate ${completionRate.toFixed(2)} below minimum ${global.minCompletionRate}`,
            });
        }

        if (global.maxAvgReplans != null && avgReplans > global.maxAvgReplans) {
            violations.push({
                type: 'global_replans_high',
                actual: avgReplans,
                expected: global.maxAvgReplans,
                message: `Global avg replans ${avgReplans.toFixed(1)} above maximum ${global.maxAvgReplans}`,
            });
        }

        // Baseline regression check
        if (this.baseline) {
            const baselineAvg = this.baseline.avgScore || 0;
            if (baselineAvg > 0) {
                const regressionPct = ((baselineAvg - avgScore) / baselineAvg) * 100;
                const maxReg = global.maxRegressionPct ?? 15;
                if (regressionPct > maxReg) {
                    violations.push({
                        type: 'regression_from_baseline',
                        actual: avgScore,
                        expected: baselineAvg,
                        regressionPct,
                        message: `Regression ${regressionPct.toFixed(1)}% from baseline (baseline ${baselineAvg.toFixed(1)}, current ${avgScore.toFixed(1)}) exceeds ${maxReg}% threshold`,
                    });
                }
            }

            // Per-scenario regression
            if (this.baseline.runs) {
                const baselineByScenario = {};
                for (const r of this.baseline.runs) {
                    const sc = r.scenario || r.scenarioName;
                    if (!baselineByScenario[sc]) baselineByScenario[sc] = [];
                    baselineByScenario[sc].push(r.score?.total || r.score || 0);
                }
                const currentByScenario = {};
                for (const m of metricsList) {
                    const sc = m.scenario || m.scenarioName;
                    if (!currentByScenario[sc]) currentByScenario[sc] = [];
                    currentByScenario[sc].push(m.score?.total || m.score || 0);
                }
                for (const [scenario, baselineScores] of Object.entries(baselineByScenario)) {
                    const baselineAvgSc = baselineScores.reduce((a, b) => a + b, 0) / baselineScores.length;
                    const currentScores = currentByScenario[scenario] || [];
                    if (!currentScores.length) continue;
                    const currentAvgSc = currentScores.reduce((a, b) => a + b, 0) / currentScores.length;
                    const regPct = ((baselineAvgSc - currentAvgSc) / Math.max(1, baselineAvgSc)) * 100;
                    const maxReg = global.maxRegressionPct ?? 15;
                    if (regPct > maxReg) {
                        violations.push({
                            type: 'scenario_regression',
                            scenario,
                            actual: currentAvgSc,
                            expected: baselineAvgSc,
                            regressionPct: regPct,
                            message: `Scenario ${scenario} regressed ${regPct.toFixed(1)}% (baseline ${baselineAvgSc.toFixed(1)} → ${currentAvgSc.toFixed(1)})`,
                        });
                    }
                }
            }
        }

        return {
            violations,
            passed: violations.length === 0,
            summary: {
                avgScore: Math.round(avgScore),
                completionRate,
                avgReplans: Math.round(avgReplans * 10) / 10,
                avgRetries: Math.round(avgRetries * 10) / 10,
                avgDeaths: Math.round(avgDeaths * 10) / 10,
                totalRuns: metricsList.length,
                baseline: this.baseline ? { avgScore: this.baseline.avgScore, runs: this.baseline.runs?.length } : null,
            },
        };
    }

    /**
     * Generate CI report.
     */
    generateReport(checkResult) {
        const lines = [];
        lines.push('# Benchmark Threshold Check');
        lines.push('');
        lines.push(`**Status:** ${checkResult.passed ? '✅ PASSED' : '❌ FAILED'}`);
        lines.push('');
        lines.push('## Summary');
        lines.push(`- Avg Score: ${checkResult.summary.avgScore}`);
        lines.push(`- Completion Rate: ${(checkResult.summary.completionRate * 100).toFixed(1)}%`);
        lines.push(`- Avg Replans: ${checkResult.summary.avgReplans}`);
        lines.push(`- Avg Retries: ${checkResult.summary.avgRetries}`);
        lines.push(`- Avg Deaths: ${checkResult.summary.avgDeaths}`);
        lines.push(`- Total Runs: ${checkResult.summary.totalRuns}`);
        if (checkResult.summary.baseline) {
            lines.push(`- Baseline Avg: ${checkResult.summary.baseline.avgScore}`);
        }
        lines.push('');
        if (checkResult.violations.length) {
            lines.push('## Violations');
            for (const v of checkResult.violations) {
                lines.push(`- ❌ [${v.type}] ${v.message}`);
            }
        } else {
            lines.push('## Violations');
            lines.push('None — all thresholds passed.');
        }
        return lines.join('\n');
    }

    static loadBaselineFromDir(baseDir, name = 'baseline') {
        const fp = path.join(baseDir, `baseline_${name}.json`);
        if (!fs.existsSync(fp)) return null;
        try {
            return JSON.parse(fs.readFileSync(fp, 'utf8'));
        } catch {
            return null;
        }
    }
}

export function checkThresholds(metricsList, opts = {}) {
    const checker = new ThresholdChecker(opts);
    return checker.checkAggregate(metricsList);
}
