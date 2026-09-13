/**
 * plan.js — compatibility facade.
 *
 * The hierarchical project domain model lives in project.js (Project, Phase,
 * PlanStep, parsing, validation, ProjectStore). This module re-exports it so
 * earlier imports and tests of './plan.js' keep working.
 */

export * from './project.js';
