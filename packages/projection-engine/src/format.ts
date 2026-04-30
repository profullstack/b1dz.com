export function fmtUsd(value: number, decimals = 2): string {
  if (!Number.isFinite(value)) return '—';
  const abs = Math.abs(value);
  // Compact large numbers to keep them readable
  if (abs >= 1_000_000_000) return `$${(value / 1_000_000_000).toFixed(2)}B`;
  if (abs >= 1_000_000) return `$${(value / 1_000_000).toFixed(2)}M`;
  if (abs >= 1_000) return `$${value.toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals })}`;
  return `$${value.toFixed(decimals)}`;
}

export function fmtPct(value: number, decimals = 3): string {
  if (!Number.isFinite(value)) return '—';
  return `${(value * 100).toFixed(decimals)}%`;
}

export function fmtMultiple(startingBankroll: number, finalBankroll: number): string {
  if (startingBankroll <= 0) return '—';
  const m = finalBankroll / startingBankroll;
  if (m >= 1_000_000) return `${(m / 1_000_000).toFixed(1)}M×`;
  if (m >= 1_000) return `${(m / 1_000).toFixed(1)}K×`;
  return `${m.toFixed(1)}×`;
}

export function exportToCsv(checkpoints: {
  day: number;
  linearBankroll: number;
  naiveCompoundedBankroll: number;
  conservativeBankroll: number;
  riskAdjustedBankroll: number;
  hourlyProfitAtSize: number;
}[]): string {
  const header = 'Day,Linear,Naive Compounded,Conservative,Risk-Adjusted,Hourly Profit at Size';
  const rows = checkpoints.map((c) =>
    [
      c.day,
      c.linearBankroll.toFixed(2),
      c.naiveCompoundedBankroll.toFixed(2),
      c.conservativeBankroll.toFixed(2),
      c.riskAdjustedBankroll.toFixed(2),
      c.hourlyProfitAtSize.toFixed(4),
    ].join(','),
  );
  return [header, ...rows].join('\n');
}

export function exportToMarkdown(result: {
  inputs: {
    startingBankroll: number;
    hourlyProfit: number;
    days: number;
    feeRate: number;
    slippageRate: number;
    failureRate: number;
    drawdownHaircut: number;
    scalingFactor: number;
    liquidityCap: number;
  };
  derived: {
    hourlyReturnRate: number;
    dailyFlatProfit: number;
    weeklyFlatProfit: number;
    monthlyFlatProfit: number;
    dailyCompoundedReturn: number;
  };
  checkpoints: {
    day: number;
    linearBankroll: number;
    naiveCompoundedBankroll: number;
    conservativeBankroll: number;
    riskAdjustedBankroll: number;
  }[];
  warnings: { severity: string; message: string }[];
}): string {
  const { inputs, derived, checkpoints, warnings } = result;
  const lines: string[] = [
    '# b1dz Growth Projection',
    '',
    `Generated: ${new Date().toISOString()}`,
    '',
    '## Inputs',
    '',
    `- Starting bankroll: ${fmtUsd(inputs.startingBankroll)}`,
    `- Hourly profit: ${fmtUsd(inputs.hourlyProfit)}`,
    `- Projection period: ${inputs.days} days`,
    `- Fee rate: ${fmtPct(inputs.feeRate)}`,
    `- Slippage rate: ${fmtPct(inputs.slippageRate)}`,
    `- Failure rate: ${fmtPct(inputs.failureRate)}`,
    `- Drawdown haircut: ${fmtPct(inputs.drawdownHaircut)}`,
    `- Scaling factor: ${inputs.scalingFactor}`,
    `- Liquidity cap: ${Number.isFinite(inputs.liquidityCap) ? fmtUsd(inputs.liquidityCap) : 'none'}`,
    '',
    '## Derived Rates',
    '',
    `- Hourly return rate: ${fmtPct(derived.hourlyReturnRate, 4)}`,
    `- Daily compounded return: ${fmtPct(derived.dailyCompoundedReturn, 3)}`,
    `- Flat daily profit: ${fmtUsd(derived.dailyFlatProfit)}`,
    `- Flat weekly profit: ${fmtUsd(derived.weeklyFlatProfit)}`,
    `- Flat monthly profit: ${fmtUsd(derived.monthlyFlatProfit)}`,
    '',
    '## Projection Checkpoints',
    '',
    '| Day | Linear | Naive Compound | Conservative | Risk-Adjusted |',
    '|-----|--------|----------------|--------------|---------------|',
    ...checkpoints.map((c) =>
      `| ${c.day} | ${fmtUsd(c.linearBankroll)} | ${fmtUsd(c.naiveCompoundedBankroll)} | ${fmtUsd(c.conservativeBankroll)} | ${fmtUsd(c.riskAdjustedBankroll)} |`,
    ),
    '',
  ];

  if (warnings.length > 0) {
    lines.push('## Warnings', '');
    for (const w of warnings) {
      lines.push(`**[${w.severity.toUpperCase()}]** ${w.message}`, '');
    }
  }

  lines.push('---', '*This is a projection tool, not financial advice or a guarantee of future returns.*');
  return lines.join('\n');
}
