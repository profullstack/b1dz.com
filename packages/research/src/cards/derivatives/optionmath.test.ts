import { describe, expect, it } from 'vitest';
import {
  black76Price,
  breakevens,
  bsPrice,
  gammaExposure,
  greeks,
  impliedVol,
  maxPain,
  netCost,
  normCdf,
  payoffAtExpiry,
  payoffCurve,
  quantile,
  realizedVol,
  rollingRealizedVol,
  volCone,
  type Leg,
  type PricingInput,
} from './optionmath.js';

const atm: PricingInput = { type: 'C', S: 100, K: 100, T: 1, r: 0.05, sigma: 0.2 };

describe('normCdf', () => {
  it('matches table values', () => {
    expect(normCdf(0)).toBeCloseTo(0.5, 7);
    expect(normCdf(1)).toBeCloseTo(0.8413447, 6);
    expect(normCdf(-1.96)).toBeCloseTo(0.0249979, 6);
    expect(normCdf(3)).toBeCloseTo(0.9986501, 6);
    expect(normCdf(-Infinity)).toBe(0);
  });
});

describe('Black-Scholes', () => {
  it('prices the textbook at-the-money case', () => {
    expect(bsPrice(atm)).toBeCloseTo(10.4506, 3);
    expect(bsPrice({ ...atm, type: 'P' })).toBeCloseTo(5.5735, 3);
  });

  it('satisfies put-call parity with a dividend yield', () => {
    const p = { ...atm, K: 110, q: 0.02, T: 0.5 };
    const c = bsPrice(p);
    const put = bsPrice({ ...p, type: 'P' });
    expect(c - put).toBeCloseTo(p.S * Math.exp(-p.q * p.T) - p.K * Math.exp(-p.r * p.T), 6);
  });

  it('falls back to intrinsic value at expiry and to the discounted floor at zero vol', () => {
    expect(bsPrice({ ...atm, K: 90, T: 0 })).toBe(10);
    expect(bsPrice({ ...atm, type: 'P', K: 90, T: 0 })).toBe(0);
    expect(bsPrice({ ...atm, K: 90, sigma: 0 })).toBeCloseTo(100 - 90 * Math.exp(-0.05), 9);
  });

  it('returns the textbook greeks', () => {
    const g = greeks(atm)!;
    expect(g.delta).toBeCloseTo(0.6368, 3);
    expect(g.gamma).toBeCloseTo(0.018762, 5);
    expect(g.vega).toBeCloseTo(0.37524, 4);
    expect(g.theta).toBeCloseTo(-6.414 / 365, 4);
    const p = greeks({ ...atm, type: 'P' })!;
    expect(p.delta).toBeCloseTo(0.6368 - 1, 3);
    expect(p.gamma).toBeCloseTo(g.gamma, 12);
    expect(p.theta).toBeCloseTo(-1.658 / 365, 4);
  });

  it('greeks agree with finite differences', () => {
    const p: PricingInput = { type: 'P', S: 250, K: 240, T: 0.3, r: 0.04, sigma: 0.35, q: 0.01 };
    const g = greeks(p)!;
    const h = 0.01;
    const up = bsPrice({ ...p, S: p.S + h });
    const dn = bsPrice({ ...p, S: p.S - h });
    expect(g.delta).toBeCloseTo((up - dn) / (2 * h), 4);
    expect(g.gamma).toBeCloseTo((up - 2 * bsPrice(p) + dn) / (h * h), 3);
    expect(g.vega).toBeCloseTo(bsPrice({ ...p, sigma: p.sigma + 0.005 }) - bsPrice({ ...p, sigma: p.sigma - 0.005 }), 4);
    const day = 1 / 365;
    expect(g.theta).toBeCloseTo((bsPrice({ ...p, T: p.T - day / 2 }) - bsPrice({ ...p, T: p.T + day / 2 })), 4);
  });

  it('returns null greeks for degenerate inputs', () => {
    expect(greeks({ ...atm, T: 0 })).toBeNull();
    expect(greeks({ ...atm, sigma: 0 })).toBeNull();
  });
});

describe('Black-76', () => {
  it('prices an at-the-money option on a forward', () => {
    const expected = Math.exp(-0.05) * 100 * (2 * normCdf(0.1) - 1);
    expect(black76Price(atm)).toBeCloseTo(expected, 9);
    expect(black76Price(atm)).toBeCloseTo(7.5771, 3);
    expect(black76Price({ ...atm, type: 'P' })).toBeCloseTo(7.5771, 3);
  });

  it('has a discounted forward delta', () => {
    const g = greeks(atm, 'black76')!;
    expect(g.delta).toBeCloseTo(Math.exp(-0.05) * normCdf(0.1), 9);
  });
});

describe('impliedVol', () => {
  it('recovers the volatility that produced a price', () => {
    for (const sigma of [0.05, 0.2, 0.65, 2.5]) {
      for (const type of ['C', 'P'] as const) {
        const p = { ...atm, type, K: 120, T: 0.4, sigma };
        expect(impliedVol(bsPrice(p), p)).toBeCloseTo(sigma, 5);
        expect(impliedVol(black76Price(p), p, 'black76')).toBeCloseTo(sigma, 5);
      }
    }
  });

  it('returns null when no volatility fits', () => {
    const itm = { ...atm, K: 80 };
    const floor = 100 - 80 * Math.exp(-0.05);
    expect(impliedVol(floor - 0.5, itm)).toBeNull(); // below intrinsic
    expect(impliedVol(150, itm)).toBeNull(); // above the spot ceiling
    expect(impliedVol(0, itm)).toBeNull();
    expect(impliedVol(NaN, itm)).toBeNull();
    expect(impliedVol(5, { ...itm, T: 0 })).toBeNull();
  });
});

describe('realised volatility', () => {
  // Alternating +1% / -1% log returns: mean 0, sample stdev = 0.01 * sqrt(n / (n - 1)).
  const closes = [100];
  for (let i = 0; i < 300; i++) closes.push(closes[closes.length - 1] * Math.exp(i % 2 ? -0.01 : 0.01));

  it('annualises the sample standard deviation of log returns', () => {
    expect(realizedVol(closes, 10)).toBeCloseTo(0.01 * Math.sqrt(10 / 9) * Math.sqrt(252), 10);
    expect(realizedVol(closes, 10, 365)).toBeCloseTo(0.01 * Math.sqrt(10 / 9) * Math.sqrt(365), 10);
  });

  it('is null without enough history and zero for a flat series', () => {
    expect(realizedVol([1, 2, 3], 10)).toBeNull();
    expect(realizedVol(Array(30).fill(50), 10)).toBe(0);
  });

  it('rolls one value per full window', () => {
    expect(rollingRealizedVol(closes, 21)).toHaveLength(300 - 21 + 1);
    expect(rollingRealizedVol(closes.slice(0, 5), 21)).toHaveLength(0);
  });

  it('builds a cone and skips windows with no sample', () => {
    const cone = volCone(closes);
    expect(cone.map((c) => c.window)).toEqual([10, 21, 42, 63, 126]);
    for (const c of cone) {
      expect(c.min).toBeLessThanOrEqual(c.p10);
      expect(c.p10).toBeLessThanOrEqual(c.median);
      expect(c.median).toBeLessThanOrEqual(c.p90);
      expect(c.p90).toBeLessThanOrEqual(c.max);
      expect(c.samples).toBe(300 - c.window + 1);
    }
    expect(volCone(closes.slice(0, 30)).map((c) => c.window)).toEqual([10, 21]);
  });

  it('interpolates quantiles', () => {
    expect(quantile([4, 1, 3, 2], 0.5)).toBe(2.5);
    expect(quantile([1, 2, 3, 4, 5], 0.1)).toBeCloseTo(1.4, 12);
    expect(quantile([7], 0.9)).toBe(7);
    expect(quantile([], 0.5)).toBeNull();
  });
});

describe('gammaExposure', () => {
  it('sums gamma x OI x multiplier x spot^2 x 1% with calls positive and puts negative', () => {
    const rows = gammaExposure(
      [
        { strike: 100, type: 'C', gamma: 0.02, oi: 1000 },
        { strike: 100, type: 'P', gamma: 0.02, oi: 400 },
        { strike: 110, type: 'P', gamma: 0.01, oi: 500 },
        { strike: 120, type: 'C', gamma: null, oi: 900 },
      ],
      100,
    );
    expect(rows).toEqual([
      { strike: 100, call: 200000, put: -80000, net: 120000 },
      { strike: 110, call: 0, put: -50000, net: -50000 },
    ]);
  });
});

describe('maxPain', () => {
  it('finds the strike with the smallest total holder payoff', () => {
    const chain = [
      { strike: 90, type: 'P' as const, oi: 100 },
      { strike: 100, type: 'C' as const, oi: 500 },
      { strike: 100, type: 'P' as const, oi: 500 },
      { strike: 110, type: 'C' as const, oi: 100 },
    ];
    expect(maxPain(chain)).toBe(100);
    // Heavy call interest at a low strike pulls the level down.
    expect(maxPain([...chain, { strike: 90, type: 'C', oi: 5000 }])).toBe(90);
    expect(maxPain([{ strike: 100, type: 'C', oi: 0 }])).toBeNull();
  });
});

describe('strategy payoff', () => {
  const straddle: Leg[] = [
    { type: 'C', strike: 100, qty: 1, premium: 4 },
    { type: 'P', strike: 100, qty: 1, premium: 3 },
  ];
  const callSpread: Leg[] = [
    { type: 'C', strike: 100, qty: 1, premium: 5 },
    { type: 'C', strike: 110, qty: -1, premium: 2 },
  ];

  it('computes cost and payoff for a long straddle', () => {
    expect(netCost(straddle)).toBe(7);
    expect(payoffAtExpiry(straddle, 100)).toBe(-7);
    expect(payoffAtExpiry(straddle, 120)).toBe(13);
    expect(payoffAtExpiry(straddle, 85)).toBe(8);
    expect(breakevens(straddle)).toEqual([93, 107]);
  });

  it('caps a vertical spread', () => {
    expect(netCost(callSpread)).toBe(3);
    expect(payoffAtExpiry(callSpread, 90)).toBe(-3);
    expect(payoffAtExpiry(callSpread, 150)).toBe(7);
    expect(breakevens(callSpread)).toEqual([103]);
  });

  it('handles a short strangle and a covered call', () => {
    const strangle: Leg[] = [
      { type: 'P', strike: 90, qty: -1, premium: 2 },
      { type: 'C', strike: 110, qty: -1, premium: 2 },
    ];
    expect(netCost(strangle)).toBe(-4);
    expect(payoffAtExpiry(strangle, 100)).toBe(4);
    expect(breakevens(strangle)).toEqual([86, 114]);
    const covered: Leg[] = [
      { type: 'U', strike: 100, qty: 1, premium: 0 },
      { type: 'C', strike: 105, qty: -1, premium: 2 },
    ];
    expect(payoffAtExpiry(covered, 120)).toBe(7);
    expect(breakevens(covered)).toEqual([98]);
  });

  it('finds a breakeven beyond the highest strike', () => {
    const call: Leg[] = [{ type: 'C', strike: 100, qty: 1, premium: 250 }];
    expect(breakevens(call)).toEqual([350]);
  });

  it('samples a curve that includes every strike', () => {
    const curve = payoffCurve(callSpread, 80, 130, 10);
    expect(curve[0]).toEqual([80, -3]);
    expect(curve.some(([x]) => x === 110)).toBe(true);
    expect(curve[curve.length - 1]).toEqual([130, 7]);
  });
});
