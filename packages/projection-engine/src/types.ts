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
  hourlyProfitAtSize: number;
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
