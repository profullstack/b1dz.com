export interface ProjectionInputs {
  startingBankroll: number;
  hourlyProfit: number;
  days: number;
  reinvestmentRate: number;
  scalingFactor: number;
  feeRate: number;
  slippageRate: number;
  failureRate: number;
  drawdownHaircut: number;
  maxHourlyProfit: number;
  liquidityCap: number;
}

export interface ProjectionDefaults {
  startingBankroll: 300;
  hourlyProfit: 0.5;
  days: 365;
  reinvestmentRate: 1;
  scalingFactor: 1;
  feeRate: 0;
  slippageRate: 0;
  failureRate: 0;
  drawdownHaircut: 0;
  maxHourlyProfit: typeof Infinity;
  liquidityCap: typeof Infinity;
}

export interface DerivedMetrics {
  hourlyReturnRate: number;
  dailyFlatProfit: number;
  weeklyFlatProfit: number;
  monthlyFlatProfit: number;
  dailyCompoundedReturn: number;
  annualFlatProfit: number;
  annualNaiveReturn: number;
}

export interface DayPoint {
  day: number;
  bankroll: number;
}

export interface ProjectionCheckpoint {
  day: number;
  linearBankroll: number;
  naiveCompoundedBankroll: number;
  conservativeBankroll: number;
  riskAdjustedBankroll: number;
  conservativeHourlyProfit: number;
}

export interface ProjectionSeries {
  linear: DayPoint[];
  naiveCompounded: DayPoint[];
  conservative: DayPoint[];
  riskAdjusted: DayPoint[];
}

export type WarningSeverity = 'info' | 'warn' | 'critical';

export interface ProjectionWarning {
  severity: WarningSeverity;
  message: string;
}

export interface ProjectionResult {
  inputs: ProjectionInputs;
  derived: DerivedMetrics;
  series: ProjectionSeries;
  checkpoints: ProjectionCheckpoint[];
  warnings: ProjectionWarning[];
}

// ─── Target Projection ──────────────────────────────────────────

export type CompoundingInterval = 'hourly' | 'daily';

export interface TargetProjectionInputs {
  startingBankroll: number;
  targetHourlyProfit: number;
  days: number;
  reinvestmentRate: number;
  compoundingInterval: CompoundingInterval;
}

export interface TargetProjectionDerived {
  /** Total profit needed over the period */
  targetProfit: number;
  /** Starting bankroll + target profit (the goal) */
  endingBankroll: number;
  /** endingBankroll / startingBankroll */
  requiredMultiple: number;
  /** requiredMultiple - 1 (e.g. 14.6 = 1460%) */
  requiredAnnualReturn: number;
  /** Required daily compounded rate to hit the target */
  requiredDailyRate: number;
  /** Required hourly compounded rate to hit the target */
  requiredHourlyRate: number;
  /** startingBankroll × requiredDailyRate  */
  requiredDayOneDailyProfit: number;
  /** startingBankroll × requiredHourlyRate */
  requiredDayOneHourlyProfit: number;
}

export interface TargetDayPoint {
  day: number;
  /** Bankroll following the required compounded path */
  requiredBankroll: number;
  /** Bankroll following a flat linear profit path */
  linearBankroll: number;
  /** Required daily profit at current bankroll size */
  requiredDailyProfitAtSize: number;
  /** Required hourly profit at current bankroll size */
  requiredHourlyProfitAtSize: number;
}

export interface TargetProjectionResult {
  inputs: TargetProjectionInputs;
  derived: TargetProjectionDerived;
  series: TargetDayPoint[];
  checkpoints: TargetDayPoint[];
  warnings: ProjectionWarning[];
}

// ─── Edge Retention Projection ──────────────────────────────────

export interface EdgeRetentionInputs {
  startingBankroll: number;
  observedHourlyProfit: number;
  targetHourlyProfit: number;
  days: number;
  retentionScenarios: number[];
  feeHaircut: number;
  slippageHaircut: number;
  failureHaircut: number;
  drawdownHaircut: number;
  reinvestmentRate: number;
}

export interface EdgeRetentionDerived {
  observedHourlyReturn: number;
  observedDailyCompoundedReturn: number;
  targetProfit: number;
  endingBankrollTarget: number;
  requiredMultiple: number;
  requiredAnnualReturn: number;
  requiredHourlyReturn: number;
  requiredDailyReturn: number;
  /** observedHourlyReturn × retention that exactly hits the target */
  requiredEdgeRetention: number;
  /** observedHourlyReturn / requiredHourlyReturn */
  safetyMargin: number;
}

export interface EdgeScenarioDayPoint {
  day: number;
  bankroll: number;
  hourlyProfitAtSize: number;
}

export interface EdgeScenario {
  label: string;
  edgeRetention: number;
  effectiveHourlyReturn: number;
  effectiveDailyReturn: number;
  endingBankroll: number;
  annualReturn: number;
  series: EdgeScenarioDayPoint[];
}

export interface EdgeRetentionCheckpoint {
  day: number;
  linearBankroll: number;
  scenarios: Record<string, number>;
}

export interface EdgeRetentionResult {
  inputs: EdgeRetentionInputs;
  derived: EdgeRetentionDerived;
  scenarios: EdgeScenario[];
  linearSeries: { day: number; bankroll: number }[];
  checkpoints: EdgeRetentionCheckpoint[];
  warnings: ProjectionWarning[];
}
