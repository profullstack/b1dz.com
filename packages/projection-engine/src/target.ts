import type {
  CompoundingInterval,
  ProjectionWarning,
  TargetDayPoint,
  TargetProjectionInputs,
  TargetProjectionResult,
} from './types.js';

const HOURS_PER_DAY = 24;
const CHECKPOINT_DAYS = [0, 7, 14, 30, 60, 90, 180, 365];

export function calculateTargetProjection(opts: Partial<TargetProjectionInputs> = {}): TargetProjectionResult {
  const inputs: TargetProjectionInputs = {
    startingBankroll: opts.startingBankroll ?? 300,
    targetHourlyProfit: opts.targetHourlyProfit ?? 0.5,
    days: opts.days ?? 365,
    reinvestmentRate: opts.reinvestmentRate ?? 1,
    compoundingInterval: (opts.compoundingInterval ?? 'hourly') as CompoundingInterval,
  };

  const { startingBankroll, targetHourlyProfit, days, reinvestmentRate } = inputs;

  const hours = days * HOURS_PER_DAY;

  // Total profit the bot must earn to hit the target
  const targetProfit = targetHourlyProfit * hours * reinvestmentRate;
  const endingBankroll = startingBankroll + targetProfit;

  // Required growth multiple
  const requiredMultiple = startingBankroll > 0 ? endingBankroll / startingBankroll : 1;
  const requiredAnnualReturn = requiredMultiple - 1;

  // Required compounded rates: how fast must the bankroll grow each period?
  const requiredDailyRate = days > 0 ? Math.pow(requiredMultiple, 1 / days) - 1 : 0;
  const requiredHourlyRate = hours > 0 ? Math.pow(requiredMultiple, 1 / hours) - 1 : 0;

  // Day-1 profit requirements at starting bankroll size
  const requiredDayOneDailyProfit = startingBankroll * requiredDailyRate;
  const requiredDayOneHourlyProfit = startingBankroll * requiredHourlyRate;

  // Build day-by-day series
  const series: TargetDayPoint[] = [];
  for (let day = 0; day <= days; day++) {
    const requiredBankroll = startingBankroll * Math.pow(1 + requiredDailyRate, day);
    const linearBankroll = startingBankroll + targetHourlyProfit * HOURS_PER_DAY * day;
    series.push({
      day,
      requiredBankroll,
      linearBankroll,
      requiredDailyProfitAtSize: requiredBankroll * requiredDailyRate,
      requiredHourlyProfitAtSize: requiredBankroll * requiredHourlyRate,
    });
  }

  const checkpoints = CHECKPOINT_DAYS
    .filter((d) => d <= days && series[d] !== undefined)
    .map((d) => series[d]!);

  const warnings: ProjectionWarning[] = [
    {
      severity: 'info',
      message:
        'This projection shows the growth rate required to hit a target. ' +
        'It is not a guarantee of future bot performance.',
    },
  ];

  if (requiredAnnualReturn > 5) {
    warnings.push({
      severity: 'warn',
      message:
        'This required return is extremely aggressive. Validate with real fills, fees, slippage, ' +
        'exchange limits, and drawdown data before assuming it is repeatable.',
    });
  }

  return {
    inputs,
    derived: {
      targetProfit,
      endingBankroll,
      requiredMultiple,
      requiredAnnualReturn,
      requiredDailyRate,
      requiredHourlyRate,
      requiredDayOneDailyProfit,
      requiredDayOneHourlyProfit,
    },
    series,
    checkpoints,
    warnings,
  };
}
