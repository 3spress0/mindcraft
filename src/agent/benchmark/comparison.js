/**
 * comparison.js — planner/model comparison support.
 *
 * Provides:
 * - Cross-model comparison across scenarios
 * - Statistical analysis
 * - Report generation for model selection
 */

import { aggregateScores, generateLeaderboard, computeStandardScore } from './scoring.js';

export class ModelComparator {
    constructor({ store = null } = {}) {
        this.store = store;
        this.runs = [];
    }

    addRun(metrics) {
        this.runs.push(metrics.summary ? metrics.summary() : metrics);
    }

    addRuns(metricsList) {
        for (const m of metricsList) this.addRun(m);
    }

    /**
     * Compare models across all scenarios.
     * @returns {object} comparison report
     */
    compare() {
        if (!this.runs.length) return null;

        const byModel = {};
        const byScenario = {};
        const byModelScenario = {};

        for (const run of this.runs) {
            const model = run.plannerModel || run.model || 'unknown';
            const scenario = run.scenario || run.scenarioName || 'unknown';

            if (!byModel[model]) byModel[model] = [];
            byModel[model].push(run);

            if (!byScenario[scenario]) byScenario[scenario] = [];
            byScenario[scenario].push(run);

            const key = `${model}::${scenario}`;
            if (!byModelScenario[key]) byModelScenario[key] = [];
            byModelScenario[key].push(run);
        }

        // Per-model aggregates
        const modelAggregates = {};
        for (const [model, runs] of Object.entries(byModel)) {
            modelAggregates[model] = aggregateScores(runs);
            modelAggregates[model].model = model;
        }

        // Per-scenario aggregates
        const scenarioAggregates = {};
        for (const [scenario, runs] of Object.entries(byScenario)) {
            scenarioAggregates[scenario] = aggregateScores(runs);
            scenarioAggregates[scenario].scenario = scenario;
        }

        // Detailed per model per scenario
        const detailed = {};
        for (const [key, runs] of Object.entries(byModelScenario)) {
            const [model, scenario] = key.split('::');
            const scores = runs.map(r => r.score?.total || 0);
            const avg = scores.reduce((a, b) => a + b, 0) / scores.length;
            const completions = runs.filter(r => r.completion).length / runs.length;
            detailed[key] = {
                model,
                scenario,
                runs: runs.length,
                avgScore: Math.round(avg),
                minScore: Math.min(...scores),
                maxScore: Math.max(...scores),
                completionRate: completions,
                avgReplans: runs.reduce((s, r) => s + (r.replans || 0), 0) / runs.length,
                avgRetries: runs.reduce((s, r) => s + (r.retries || 0), 0) / runs.length,
            };
        }

        // Leaderboard
        const leaderboard = Object.values(modelAggregates)
            .map(agg => ({
                model: agg.model,
                avgScore: agg.overallAvg,
                weightedScore: agg.overallWeighted,
                completionRate: agg.overallCompletion,
                totalRuns: agg.totalRuns,
                scenarios: agg.scenarios,
            }))
            .sort((a, b) => b.avgScore - a.avgScore)
            .map((e, i) => ({ rank: i + 1, ...e }));

        // Statistical significance (simple)
        const bestModel = leaderboard[0];
        const comparisons = [];
        if (bestModel) {
            for (const entry of leaderboard.slice(1)) {
                const diff = bestModel.avgScore - entry.avgScore;
                const pctDiff = (diff / Math.max(1, bestModel.avgScore)) * 100;
                comparisons.push({
                    vs: `${bestModel.model} vs ${entry.model}`,
                    best: bestModel.model,
                    other: entry.model,
                    scoreDiff: diff,
                    pctDiff: Math.round(pctDiff),
                    significant: pctDiff > 10,
                });
            }
        }

        return {
            totalRuns: this.runs.length,
            models: Object.keys(byModel),
            scenarios: Object.keys(byScenario),
            modelAggregates,
            scenarioAggregates,
            detailed,
            leaderboard,
            comparisons,
            generatedAt: Date.now(),
        };
    }

    /**
     * Generate markdown report.
     */
    generateReport() {
        const result = this.compare();
        if (!result) return 'No runs to compare';

        const lines = [];
        lines.push('# Model Comparison Report');
        lines.push('');
        lines.push(`**Total Runs:** ${result.totalRuns}`);
        lines.push(`**Models:** ${result.models.join(', ')}`);
        lines.push(`**Scenarios:** ${result.scenarios.join(', ')}`);
        lines.push('');

        lines.push('## Leaderboard');
        lines.push('| Rank | Model | Avg Score | Weighted | Completion | Runs | Scenarios |');
        lines.push('|------|-------|-----------|----------|------------|------|-----------|');
        for (const entry of result.leaderboard) {
            lines.push(`| ${entry.rank} | ${entry.model} | ${entry.avgScore} | ${entry.weightedScore} | ${(entry.completionRate * 100).toFixed(1)}% | ${entry.totalRuns} | ${entry.scenarios} |`);
        }
        lines.push('');

        lines.push('## Per-Model Details');
        for (const [model, agg] of Object.entries(result.modelAggregates)) {
            lines.push(`### ${model}`);
            lines.push(`- Overall Avg: ${agg.overallAvg} (weighted ${agg.overallWeighted})`);
            lines.push(`- Completion: ${(agg.overallCompletion * 100).toFixed(1)}%`);
            lines.push(`- Total Runs: ${agg.totalRuns}`);
            lines.push(`- Scenarios: ${agg.scenarios}`);
            lines.push('');
            lines.push('| Scenario | Runs | Avg | Best | Worst | Completion |');
            lines.push('|----------|------|-----|------|-------|------------|');
            for (const [scenario, scAgg] of Object.entries(agg.scenarioScores || {})) {
                lines.push(`| ${scenario} | ${scAgg.runs} | ${scAgg.avgScore} | ${scAgg.bestScore} | ${scAgg.worstScore} | ${(scAgg.completionRate * 100).toFixed(1)}% |`);
            }
            lines.push('');
        }

        lines.push('## Scenario Breakdown');
        lines.push('| Scenario | Models | Avg Score | Completion | Runs |');
        lines.push('|----------|--------|-----------|------------|------|');
        for (const [scenario, agg] of Object.entries(result.scenarioAggregates)) {
            lines.push(`| ${scenario} | ${Object.keys(result.modelAggregates).length} | ${agg.overallAvg} | ${(agg.overallCompletion * 100).toFixed(1)}% | ${agg.totalRuns} |`);
        }
        lines.push('');

        if (result.comparisons.length) {
            lines.push('## Comparisons vs Best');
            for (const comp of result.comparisons) {
                lines.push(`- ${comp.vs}: ${comp.scoreDiff} points (${comp.pctDiff}%) ${comp.significant ? '🔴 significant' : '🟢 minor'}`);
            }
        }

        return lines.join('\n');
    }

    /**
     * Find best model for a given scenario.
     */
    bestModelForScenario(scenarioName) {
        const result = this.compare();
        if (!result) return null;
        let best = null;
        let bestScore = -1;
        for (const [key, detail] of Object.entries(result.detailed)) {
            if (detail.scenario === scenarioName && detail.avgScore > bestScore) {
                bestScore = detail.avgScore;
                best = detail;
            }
        }
        return best;
    }

    /**
     * Recommend model based on overall performance and specific needs.
     */
    recommend({ priority = 'balanced' } = {}) {
        const result = this.compare();
        if (!result || !result.leaderboard.length) return null;

        let recommended = result.leaderboard[0];
        let reason = 'Highest average score';

        if (priority === 'completion') {
            recommended = [...result.leaderboard].sort((a, b) => b.completionRate - a.completionRate)[0];
            reason = 'Highest completion rate';
        } else if (priority === 'efficiency') {
            // Find model with best efficiency (lowest replans/retries)
            const byEfficiency = Object.entries(result.modelAggregates)
                .map(([model, agg]) => {
                    const avgReplans = Object.values(agg.scenarioScores).reduce((s, sc) => s + (sc.runs ? 0 : 0), 0);
                    return { model, agg };
                });
            // For now, use lowest replans from detailed
            const modelReplans = {};
            for (const detail of Object.values(result.detailed)) {
                if (!modelReplans[detail.model]) modelReplans[detail.model] = [];
                modelReplans[detail.model].push(detail.avgReplans);
            }
            let bestEff = null;
            let bestEffScore = Infinity;
            for (const [model, replans] of Object.entries(modelReplans)) {
                const avg = replans.reduce((a, b) => a + b, 0) / replans.length;
                if (avg < bestEffScore) {
                    bestEffScore = avg;
                    bestEff = model;
                }
            }
            if (bestEff) {
                recommended = result.leaderboard.find(e => e.model === bestEff) || recommended;
                reason = 'Lowest replans/retries (most efficient)';
            }
        }

        return {
            model: recommended.model,
            reason,
            score: recommended.avgScore,
            completionRate: recommended.completionRate,
            leaderboard: result.leaderboard,
        };
    }
}

export function compareModels(metricsList) {
    const comparator = new ModelComparator();
    comparator.addRuns(metricsList);
    return comparator.compare();
}

export function generateComparisonReport(metricsList) {
    const comparator = new ModelComparator();
    comparator.addRuns(metricsList);
    return comparator.generateReport();
}
