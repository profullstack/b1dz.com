import type {
  EdgeRetentionCheckpoint,
  EdgeRetentionInputs,
  EdgeRetentionResult,
  EdgeScenario,
  ProjectionWarning,
} from './types.js';

const HOURS_PER_DAY = 24;
const CHECKPOINT_DAYS = [0, 7, 14, 30, 60, 90, 180, 365];

const DEFAULT_SCENARIOS = [1, 0.5, 0.25, 0.2, 0.1, 0.05, 0.01];

function retentionLabel(edgeRetention: number, requiredEdgeRetention: number): string {
  const diff = Math.abs(edgeRetention - requiredEdgeRetention);
  if (diff < 0.005) {
    return `Break-even (${(requiredEdgeRetention * 100).toFixed(1)}%)`;
  }
  const pct = edgeRetention * 100;
  return `${pct < 10 ? pct.toFixed(1) : pct.toFixed(0)}% retained`;
}

export function calculateEdgeRetentionProjection(
  opts: Partial<EdgeRetentionInputs> = {},
): EdgeRetentionResult {
  const inputs: EdgeRetentionInputs = {
    startingBankroll: opts.startingBankroll ?? 300,
    observedHourlyProfit: opts.observedHourlyProfit ?? 0.5,
    targetHourlyProfit: opts.targetHourlyProfit ?? 0.5,
    days: opts.days ?? 365,
    retentionScenarios: opts.retentionScenarios ?? DEFAULT_SCENARIOS,
    feeHaircut: opts.feeHaircut ?? 0,
    slippageHaircut: opts.slippageHaircut ?? 0,
    failureHaircut: opts.failureHaircut ?? 0,
    drawdownHaircut: opts.drawdownHaircut ?? 0,
    reinvestmentRate: opts.reinvestmentRate ?? 1,
  };

  const {
    startingBankroll,
    observedHourlyProfit,
    targetHourlyProfit,
    days,
    retentionScenarios,
    feeHaircut,
    slippageHaircut,
    failureHaircut,
    drawdownHaircut,
    reinvestmentRate,
  } = inputs;

  const hours = days * HOURS_PER_DAY;

  // Observed edge
  const observedHourlyReturn = startingBankroll > 0 ? observedHourlyProfit / startingBankroll : 0;
  const observedDailyCompoundedReturn = Math.pow(1 + observedHourlyReturn, HOURS_PER_DAY) - 1;

  // Target math
  const targetProfit = targetHourlyProfit * hours;
  const endingBankrollTarget = startingBankroll + targetProfit;
  const requiredMultiple = startingBankroll > 0 ? endingBankrollTarget / startingBankroll : 1;
  const requiredAnnualReturn = requiredMultiple - 1;
  const requiredHourlyReturn = hours > 0 ? Math.pow(requiredMultiple, 1 / hours) - 1 : 0;
  const requiredDailyReturn = days > 0 ? Math.pow(requiredMultiple, 1 / days) - 1 : 0;

  // Edge retention needed
  const requiredEdgeRetention = observedHourlyReturn > 0 ? requiredHourlyReturn / observedHourlyReturn : 0;
  const safetyMargin = requiredHourlyReturn > 0 ? observedHourlyReturn / requiredHourlyReturn : 0;

  // Per-scenario risk haircut
  const totalHaircut = (1 - feeHaircut) * (1 - slippageHaircut) * (1 - failureHaircut) * (1 - drawdownHaircut);

  // Build break-even scenario list — always include requiredEdgeRetention if not already in list
  let scenarioList = [...retentionScenarios];
  const alreadyHasBreakEven = scenarioList.some((r) => Math.abs(r - requiredEdgeRetention) < 0.005);
  if (!alreadyHasBreakEven && requiredEdgeRetention > 0 && requiredEdgeRetention <= 1) {
    scenarioList = [...scenarioList, requiredEdgeRetention].sort((a, b) => b - a);
  }

  const scenarios: EdgeScenario[] = scenarioList.map((edgeRetention) => {
    const effectiveHourlyReturn = observedHourlyReturn * edgeRetention * totalHaircut * reinvestmentRate;
    const effectiveDailyReturn = Math.pow(1 + effectiveHourlyReturn, HOURS_PER_DAY) - 1;

    const series = [];
    for (let day = 0; day <= days; day++) {
      const bankroll = startingBankroll * Math.pow(1 + effectiveHourlyReturn, day * HOURS_PER_DAY);
      series.push({ day, bankroll, hourlyProfitAtSize: bankroll * effectiveHourlyReturn });
    }

    const endingBankroll = series[series.length - 1]?.bankroll ?? startingBankroll;
    const annualReturn = startingBankroll > 0 ? endingBankroll / startingBankroll - 1 : 0;

    return {
      label: retentionLabel(edgeRetention, requiredEdgeRetention),
      edgeRetention,
      effectiveHourlyReturn,
      effectiveDailyReturn,
      endingBankroll,
      annualReturn,
      series,
    };
  });

  // Linear series (flat fixed profit, no compounding)
  const linearSeries = Array.from({ length: days + 1 }, (_, day) => ({
    day,
    bankroll: startingBankroll + observedHourlyProfit * HOURS_PER_DAY * day,
  }));

  // Checkpoints
  const checkpoints: EdgeRetentionCheckpoint[] = CHECKPOINT_DAYS
    .filter((d) => d <= days)
    .map((d) => ({
      day: d,
      linearBankroll: linearSeries[d]?.bankroll ?? startingBankroll,
      scenarios: Object.fromEntries(scenarios.map((s) => [s.label, s.series[d]?.bankroll ?? startingBankroll])),
    }));

  // Warnings
  const warnings: ProjectionWarning[] = [];
  const naiveScenario = scenarios.find((s) => Math.abs(s.edgeRetention - 1) < 0.001);
  if (naiveScenario) {
    if (naiveScenario.annualReturn > 10) {
      warnings.push({
        severity: 'warn',
        message:
          '100% edge retention assumes the current observed return scales perfectly with bankroll. ' +
          'This is almost never true at larger sizes because of liquidity, slippage, failed fills, exchange limits, and market regime changes.',
      });
    }
    if (naiveScenario.annualReturn > 1000) {
      warnings.push({
        severity: 'critical',
        message:
          'The naive projection implies extreme exponential growth. Treat it as a theoretical upper bound, not an expected result.',
      });
    }
  }
  if (requiredEdgeRetention > 1) {
    warnings.push({
      severity: 'warn',
      message:
        'The observed edge is below the required edge for this target. The bot must improve its return or the target must be lowered.',
    });
  }

  return {
    inputs,
    derived: {
      observedHourlyReturn,
      observedDailyCompoundedReturn,
      targetProfit,
      endingBankrollTarget,
      requiredMultiple,
      requiredAnnualReturn,
      requiredHourlyReturn,
      requiredDailyReturn,
      requiredEdgeRetention,
      safetyMargin,
    },
    scenarios,
    linearSeries,
    checkpoints,
    warnings,
  };
}
