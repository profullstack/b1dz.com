import type {
  DayPoint,
  ProjectionCheckpoint,
  ProjectionInputs,
  ProjectionResult,
  ProjectionWarning,
} from './types.js';

const CHECKPOINT_DAYS = [0, 7, 14, 30, 60, 90, 180, 365];
const HOURS_PER_DAY = 24;

export function calculateProjection(opts: Partial<ProjectionInputs> = {}): ProjectionResult {
  const inputs: ProjectionInputs = {
    startingBankroll: opts.startingBankroll ?? 300,
    hourlyProfit: opts.hourlyProfit ?? 0.5,
    days: opts.days ?? 365,
    reinvestmentRate: opts.reinvestmentRate ?? 1,
    scalingFactor: opts.scalingFactor ?? 1,
    feeRate: opts.feeRate ?? 0,
    slippageRate: opts.slippageRate ?? 0,
    failureRate: opts.failureRate ?? 0,
    drawdownHaircut: opts.drawdownHaircut ?? 0,
    maxHourlyProfit: opts.maxHourlyProfit ?? Infinity,
    liquidityCap: opts.liquidityCap ?? Infinity,
  };

  const {
    startingBankroll,
    hourlyProfit,
    days,
    reinvestmentRate,
    scalingFactor,
    feeRate,
    slippageRate,
    failureRate,
    drawdownHaircut,
    maxHourlyProfit,
    liquidityCap,
  } = inputs;

  const hourlyReturnRate = startingBankroll > 0 ? hourlyProfit / startingBankroll : 0;
  const dailyFlatProfit = hourlyProfit * HOURS_PER_DAY;
  const weeklyFlatProfit = dailyFlatProfit * 7;
  const monthlyFlatProfit = dailyFlatProfit * 30;
  const annualFlatProfit = dailyFlatProfit * 365;
  const dailyCompoundedReturn = Math.pow(1 + hourlyReturnRate * reinvestmentRate, HOURS_PER_DAY) - 1;

  const linear: DayPoint[] = [];
  const naiveCompounded: DayPoint[] = [];
  const conservative: DayPoint[] = [];
  const riskAdjusted: DayPoint[] = [];

  let conservativeBankroll = startingBankroll;
  let riskBankroll = startingBankroll;

  for (let day = 0; day <= days; day++) {
    const hoursElapsed = day * HOURS_PER_DAY;

    // Linear: fixed absolute profit per hour, no reinvestment
    const linearBankroll = startingBankroll + hourlyProfit * hoursElapsed;

    // Naive compound: perfect scaling with bankroll
    const naiveBankroll =
      startingBankroll * Math.pow(1 + hourlyReturnRate * reinvestmentRate, hoursElapsed);

    // Conservative and risk-adjusted: simulate hour by hour from previous day
    if (day > 0) {
      for (let h = 0; h < HOURS_PER_DAY; h++) {
        // Conservative: partial scaling via scalingFactor
        const conservativeProfit =
          hourlyProfit +
          (conservativeBankroll - startingBankroll) * hourlyReturnRate * scalingFactor;
        conservativeBankroll += conservativeProfit * reinvestmentRate;

        // Risk-adjusted: apply fee/slippage/failure/drawdown reductions + caps
        let riskProfit = riskBankroll * hourlyReturnRate * scalingFactor;
        riskProfit *=
          (1 - feeRate) *
          (1 - slippageRate) *
          (1 - failureRate) *
          (1 - drawdownHaircut);
        riskProfit = Math.min(riskProfit, maxHourlyProfit);
        if (riskBankroll >= liquidityCap) {
          riskProfit = Math.min(riskProfit, hourlyProfit);
        }
        riskBankroll += riskProfit * reinvestmentRate;
      }
    }

    linear.push({ day, bankroll: linearBankroll });
    naiveCompounded.push({ day, bankroll: naiveBankroll });
    conservative.push({ day, bankroll: conservativeBankroll });
    riskAdjusted.push({ day, bankroll: riskBankroll });
  }

  const finalNaive = naiveCompounded.at(-1)!.bankroll;
  const annualNaiveReturn = startingBankroll > 0
    ? (finalNaive - startingBankroll) / startingBankroll
    : 0;

  const warnings: ProjectionWarning[] = [];

  if (annualNaiveReturn > 10) {
    warnings.push({
      severity: 'warn',
      message:
        'Naive compounding assumes your trading edge scales perfectly with bankroll. ' +
        'Real bots hit limits from liquidity, slippage, fees, failed fills, and exchange constraints.',
    });
  }

  if (annualNaiveReturn > 1000) {
    warnings.push({
      severity: 'critical',
      message:
        'This projection implies extreme exponential growth. ' +
        'It is a mathematical upper-bound, not an expected result. ' +
        'Liquidity, execution quality, and edge rarely remain stable at much larger trade sizes.',
    });
  }

  if (feeRate === 0 && slippageRate === 0 && failureRate === 0) {
    warnings.push({
      severity: 'info',
      message:
        'Risk-adjusted projection uses zero fees, slippage, and failure rate. ' +
        'Set realistic values to see a more grounded estimate.',
    });
  }

  const checkpoints = buildCheckpoints({
    linear, naiveCompounded, conservative, riskAdjusted, hourlyReturnRate, days,
  });

  return {
    inputs,
    derived: {
      hourlyReturnRate,
      dailyFlatProfit,
      weeklyFlatProfit,
      monthlyFlatProfit,
      annualFlatProfit,
      dailyCompoundedReturn,
      annualNaiveReturn,
    },
    series: { linear, naiveCompounded, conservative, riskAdjusted },
    checkpoints,
    warnings,
  };
}

function buildCheckpoints(args: {
  linear: DayPoint[];
  naiveCompounded: DayPoint[];
  conservative: DayPoint[];
  riskAdjusted: DayPoint[];
  hourlyReturnRate: number;
  days: number;
}): ProjectionCheckpoint[] {
  const { linear, naiveCompounded, conservative, riskAdjusted, hourlyReturnRate, days } = args;
  return CHECKPOINT_DAYS
    .filter((d) => d <= days && linear[d] !== undefined)
    .map((d) => ({
      day: d,
      linearBankroll: linear[d]!.bankroll,
      naiveCompoundedBankroll: naiveCompounded[d]!.bankroll,
      conservativeBankroll: conservative[d]!.bankroll,
      riskAdjustedBankroll: riskAdjusted[d]!.bankroll,
      conservativeHourlyProfit: conservative[d]!.bankroll * hourlyReturnRate,
    }));
}
