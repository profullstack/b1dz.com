/**
 * Pure option and volatility maths. No I/O.
 *
 * Conventions used everywhere in this file:
 *   - volatility, rates and yields are decimals per year (0.25 = 25%)
 *   - T is time to expiry in years
 *   - vega is per one volatility point (a 1% change in vol)
 *   - theta is per calendar day
 */

export type OptionType = 'C' | 'P';

export interface PricingInput {
  type: OptionType;
  /** Spot (Black-Scholes) or forward/futures price (Black-76). */
  S: number;
  K: number;
  T: number;
  /** Risk-free rate, continuous, decimal. */
  r: number;
  sigma: number;
  /** Continuous dividend yield (Black-Scholes only). Default 0. */
  q?: number;
}

export type Model = 'bs' | 'black76';

export interface Greeks {
  delta: number;
  gamma: number;
  /** Per one vol point (1%). */
  vega: number;
  /** Per calendar day. */
  theta: number;
}

export function normPdf(x: number): number {
  return Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI);
}

/** Standard normal CDF (Abramowitz and Stegun 26.2.17, absolute error below 1e-7). */
export function normCdf(x: number): number {
  if (x === Infinity) return 1;
  if (x === -Infinity) return 0;
  const a = Math.abs(x);
  const t = 1 / (1 + 0.2316419 * a);
  const poly = t * (0.31938153 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  const upper = normPdf(a) * poly;
  return x >= 0 ? 1 - upper : upper;
}

/** Cost of carry: r - q for a spot option, 0 for an option on a future. */
function carry(p: PricingInput, model: Model): number {
  return model === 'black76' ? 0 : p.r - (p.q ?? 0);
}

function d1d2(p: PricingInput, b: number): [number, number] {
  const vt = p.sigma * Math.sqrt(p.T);
  const d1 = (Math.log(p.S / p.K) + (b + 0.5 * p.sigma * p.sigma) * p.T) / vt;
  return [d1, d1 - vt];
}

/** Discounted intrinsic value: the price as volatility goes to zero. */
function floorPrice(p: PricingInput, b: number): number {
  const fwd = p.S * Math.exp((b - p.r) * p.T);
  const strike = p.K * Math.exp(-p.r * p.T);
  return Math.max(0, p.type === 'C' ? fwd - strike : strike - fwd);
}

function price(p: PricingInput, model: Model): number {
  const b = carry(p, model);
  if (!(p.S > 0) || !(p.K > 0)) return NaN;
  if (!(p.T > 0)) return Math.max(0, p.type === 'C' ? p.S - p.K : p.K - p.S);
  if (!(p.sigma > 0)) return floorPrice(p, b);
  const [d1, d2] = d1d2(p, b);
  const cf = Math.exp((b - p.r) * p.T);
  const df = Math.exp(-p.r * p.T);
  return p.type === 'C'
    ? p.S * cf * normCdf(d1) - p.K * df * normCdf(d2)
    : p.K * df * normCdf(-d2) - p.S * cf * normCdf(-d1);
}

/** European option on a spot asset paying a continuous yield q. */
export function bsPrice(p: PricingInput): number {
  return price(p, 'bs');
}

/** European option on a forward or futures price (pass the forward as S). */
export function black76Price(p: PricingInput): number {
  return price(p, 'black76');
}

export function greeks(p: PricingInput, model: Model = 'bs'): Greeks | null {
  if (!(p.S > 0) || !(p.K > 0) || !(p.T > 0) || !(p.sigma > 0)) return null;
  const b = carry(p, model);
  const [d1, d2] = d1d2(p, b);
  const cf = Math.exp((b - p.r) * p.T);
  const df = Math.exp(-p.r * p.T);
  const sqrtT = Math.sqrt(p.T);
  const pdf = normPdf(d1);
  const delta = p.type === 'C' ? cf * normCdf(d1) : cf * (normCdf(d1) - 1);
  const gamma = (cf * pdf) / (p.S * p.sigma * sqrtT);
  const vegaPerUnit = p.S * cf * pdf * sqrtT;
  const decay = -(p.S * cf * pdf * p.sigma) / (2 * sqrtT);
  const thetaYear =
    p.type === 'C'
      ? decay - (b - p.r) * p.S * cf * normCdf(d1) - p.r * p.K * df * normCdf(d2)
      : decay + (b - p.r) * p.S * cf * normCdf(-d1) + p.r * p.K * df * normCdf(-d2);
  return { delta, gamma, vega: vegaPerUnit / 100, theta: thetaYear / 365 };
}

export const IV_MIN = 0.0005;
export const IV_MAX = 10;

/**
 * Implied volatility by bisection on [IV_MIN, IV_MAX]. Returns null when no
 * volatility in that range reproduces the price: a price at or below the
 * discounted intrinsic value, above the no-arbitrage ceiling, or bad inputs.
 */
export function impliedVol(target: number, p: Omit<PricingInput, 'sigma'>, model: Model = 'bs'): number | null {
  if (!Number.isFinite(target) || !(target > 0) || !(p.S > 0) || !(p.K > 0) || !(p.T > 0)) return null;
  const at = (sigma: number): number => price({ ...p, sigma }, model);
  let lo = IV_MIN;
  let hi = IV_MAX;
  const pLo = at(lo);
  const pHi = at(hi);
  if (!(target > pLo) || !(target < pHi)) return null;
  for (let i = 0; i < 100; i++) {
    const mid = 0.5 * (lo + hi);
    if (at(mid) < target) lo = mid;
    else hi = mid;
    if (hi - lo < 1e-7) break;
  }
  return 0.5 * (lo + hi);
}

/** Log returns of a close series (oldest first). Non-positive closes are skipped. */
export function logReturns(closes: number[]): number[] {
  const out: number[] = [];
  let prev: number | null = null;
  for (const c of closes) {
    if (!(c > 0)) continue;
    if (prev !== null) out.push(Math.log(c / prev));
    prev = c;
  }
  return out;
}

function stdev(xs: number[]): number {
  const n = xs.length;
  const mean = xs.reduce((a, b) => a + b, 0) / n;
  const ss = xs.reduce((a, b) => a + (b - mean) * (b - mean), 0);
  return Math.sqrt(ss / (n - 1));
}

/**
 * Annualised close-to-close realised volatility over the last `window`
 * daily returns (decimal). Null when there are fewer than `window` returns.
 * `periods` is trading days per year: 252 for listed markets, 365 for crypto.
 */
export function realizedVol(closes: number[], window: number, periods = 252): number | null {
  const r = logReturns(closes);
  if (window < 2 || r.length < window) return null;
  return stdev(r.slice(-window)) * Math.sqrt(periods);
}

/** Realised vol for every window ending at each close; entry i belongs to closes[i + window]. */
export function rollingRealizedVol(closes: number[], window: number, periods = 252): number[] {
  const r = logReturns(closes);
  const out: number[] = [];
  if (window < 2) return out;
  for (let end = window; end <= r.length; end++) out.push(stdev(r.slice(end - window, end)) * Math.sqrt(periods));
  return out;
}

/** Linear-interpolated quantile of an unsorted sample, q in [0, 1]. */
export function quantile(xs: number[], q: number): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const pos = (s.length - 1) * Math.min(1, Math.max(0, q));
  const i = Math.floor(pos);
  const frac = pos - i;
  return i + 1 < s.length ? s[i] + frac * (s[i + 1] - s[i]) : s[i];
}

export interface ConeRow {
  window: number;
  min: number;
  p10: number;
  median: number;
  p90: number;
  max: number;
  /** The most recent window's realised vol. */
  current: number;
  /** How many rolling windows the statistics cover. */
  samples: number;
}

export const CONE_WINDOWS = [10, 21, 42, 63, 126];

/** Distribution of rolling realised volatility by window length. Windows with no full sample are omitted. */
export function volCone(closes: number[], windows: number[] = CONE_WINDOWS, periods = 252): ConeRow[] {
  const out: ConeRow[] = [];
  for (const window of windows) {
    const roll = rollingRealizedVol(closes, window, periods);
    if (!roll.length) continue;
    out.push({
      window,
      min: Math.min(...roll),
      p10: quantile(roll, 0.1) as number,
      median: quantile(roll, 0.5) as number,
      p90: quantile(roll, 0.9) as number,
      max: Math.max(...roll),
      current: roll[roll.length - 1],
      samples: roll.length,
    });
  }
  return out;
}

export interface ExposureInput {
  strike: number;
  type: OptionType;
  gamma: number | null | undefined;
  oi: number | null | undefined;
}

export interface ExposureRow {
  strike: number;
  call: number;
  put: number;
  net: number;
}

/**
 * Dealer gamma exposure by strike, in currency per 1% move of the underlying:
 * gamma x open interest x multiplier x spot^2 x 0.01. Calls count positive
 * and puts negative: the usual convention, which assumes dealers are long
 * the calls customers sold and short the puts customers bought. It is an
 * assumption about who holds what, not an observation.
 */
export function gammaExposure(chain: ExposureInput[], spot: number, multiplier = 100): ExposureRow[] {
  const by = new Map<number, ExposureRow>();
  for (const o of chain) {
    if (o.gamma == null || o.oi == null || !Number.isFinite(o.gamma) || !Number.isFinite(o.oi)) continue;
    const row = by.get(o.strike) ?? { strike: o.strike, call: 0, put: 0, net: 0 };
    const v = o.gamma * o.oi * multiplier * spot * spot * 0.01;
    if (o.type === 'C') row.call += v;
    else row.put -= v;
    row.net = row.call + row.put;
    by.set(o.strike, row);
  }
  return [...by.values()].sort((a, b) => a.strike - b.strike);
}

/**
 * Max Pain: the listed strike at which, if the underlying settled there,
 * option holders would collect the least in total (calls plus puts, weighted
 * by open interest). Null when there is no open interest.
 */
export function maxPain(chain: { strike: number; type: OptionType; oi: number | null | undefined }[]): number | null {
  const live = chain.filter((o) => o.oi != null && o.oi > 0);
  if (!live.length) return null;
  const strikes = [...new Set(live.map((o) => o.strike))].sort((a, b) => a - b);
  let best: number | null = null;
  let bestPay = Infinity;
  for (const s of strikes) {
    let pay = 0;
    for (const o of live) pay += (o.oi as number) * Math.max(0, o.type === 'C' ? s - o.strike : o.strike - s);
    if (pay < bestPay) {
      bestPay = pay;
      best = s;
    }
  }
  return best;
}

export interface Leg {
  /** 'U' is the underlying itself (strike = entry price). */
  type: OptionType | 'U';
  strike: number;
  /** Signed quantity: positive long, negative short. */
  qty: number;
  /** Price paid (long) or received (short) per unit; always positive. */
  premium: number;
}

/** Net debit (positive) or credit (negative) to open the position, per unit. */
export function netCost(legs: Leg[]): number {
  return legs.reduce((sum, l) => sum + (l.type === 'U' ? 0 : l.qty * l.premium), 0);
}

/** Profit or loss per unit at expiry with the underlying at `spot`. */
export function payoffAtExpiry(legs: Leg[], spot: number): number {
  let total = 0;
  for (const l of legs) {
    if (l.type === 'U') total += l.qty * (spot - l.strike);
    else {
      const intrinsic = Math.max(0, l.type === 'C' ? spot - l.strike : l.strike - spot);
      total += l.qty * (intrinsic - l.premium);
    }
  }
  return total;
}

/** [spot, P&L] pairs across a price range, including every strike so kinks are exact. */
export function payoffCurve(legs: Leg[], lo: number, hi: number, steps = 60): [number, number][] {
  const xs = new Set<number>();
  for (let i = 0; i <= steps; i++) xs.add(lo + ((hi - lo) * i) / steps);
  for (const l of legs) if (l.type !== 'U' && l.strike > lo && l.strike < hi) xs.add(l.strike);
  return [...xs].sort((a, b) => a - b).map((x) => [x, payoffAtExpiry(legs, x)]);
}

/**
 * Underlying prices at expiry where the position breaks even. The payoff is
 * piecewise linear, so each root is solved exactly between adjacent kinks
 * (and on the open-ended segment above the highest strike).
 */
export function breakevens(legs: Leg[]): number[] {
  const kinks = [...new Set(legs.filter((l) => l.type !== 'U').map((l) => l.strike))].sort((a, b) => a - b);
  if (!kinks.length) return [];
  const top = kinks[kinks.length - 1];
  const xs = [0, ...kinks, top * 2 + 1];
  const roots: number[] = [];
  for (let i = 0; i + 1 < xs.length; i++) {
    const a = xs[i];
    const b = xs[i + 1];
    const fa = payoffAtExpiry(legs, a);
    const fb = payoffAtExpiry(legs, b);
    const last = i + 2 === xs.length;
    if (fa === 0 && fb === 0) continue;
    if (fa === 0) {
      if (i === 0) roots.push(a);
      continue;
    }
    if (fb === 0) {
      if (!last) roots.push(b);
      continue;
    }
    if (fa * fb < 0) roots.push(a - (fa * (b - a)) / (fb - fa));
    else if (last) {
      // Same sign at both ends of the final segment: it may still cross further out.
      const slope = (fb - fa) / (b - a);
      // A flat tail never crosses; the tolerance keeps float noise from inventing a far-off root.
      if (Math.abs(slope) > 1e-9) {
        const x = a - fa / slope;
        if (x > b) roots.push(x);
      }
    }
  }
  return [...new Set(roots.map((x) => Math.round(x * 1e6) / 1e6))].filter((x) => x > 0).sort((a, b) => a - b);
}
