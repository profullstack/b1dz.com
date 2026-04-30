export { calculateProjection } from './engine.js';
export { calculateTargetProjection } from './target.js';
export { calculateEdgeRetentionProjection } from './edge-retention.js';
export { fmtUsd, fmtPct, fmtMultiple, exportToCsv, exportToMarkdown } from './format.js';
export type {
  ProjectionInputs,
  ProjectionDefaults,
  DerivedMetrics,
  DayPoint,
  ProjectionCheckpoint,
  ProjectionSeries,
  ProjectionWarning,
  WarningSeverity,
  ProjectionResult,
  CompoundingInterval,
  TargetProjectionInputs,
  TargetProjectionDerived,
  TargetDayPoint,
  TargetProjectionResult,
  EdgeRetentionInputs,
  EdgeRetentionDerived,
  EdgeScenarioDayPoint,
  EdgeScenario,
  EdgeRetentionCheckpoint,
  EdgeRetentionResult,
} from './types.js';
