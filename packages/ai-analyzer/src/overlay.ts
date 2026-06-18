/**
 * AI overlay — pure, deterministic mapping from an AI market view onto the
 * deterministic engine's order sizing. The AI never trades on its own; it can
 * only scale a buy that the deterministic strategy already wants, and only
 * within bounds. The spend budget is still the hard cap downstream.
 */

export type Regime = 'trending' | 'ranging' | 'volatile' | 'unknown';
export type Bias = 'long' | 'short' | 'neutral';

export interface AiAnalysis {
  regime: Regime;
  /** 0..1 — how confident the model is in `bias`. */
  confidence: number;
  bias: Bias;
  rationale: string;
  /** epoch ms the analysis was produced. */
  ts: number;
  provider: 'anthropic' | 'openai';
  model: string;
}

/** Bounds on how much the AI may move sizing. Never exceeds the budget cap. */
export const AI_SIZE_MIN = 0.25; // never below 25% of base on a confident short
export const AI_SIZE_MAX = 1.5; // never above 150% of base on a confident long

/**
 * Map an AI view onto a multiplier applied to the deterministic base buy size.
 *
 *  - bias `long`  + high confidence → up to AI_SIZE_MAX
 *  - bias `short` + high confidence → down to AI_SIZE_MIN (de-risk; don't flip)
 *  - bias `neutral` or low confidence → ~1.0 (no opinion)
 *  - stale analysis (older than `maxAgeMs`) → 1.0 (ignore)
 *  - `volatile` regime damps the magnitude (less conviction in chop)
 */
export function aiSizeMultiplier(
  analysis: AiAnalysis | null,
  now: number,
  maxAgeMs = 5 * 60_000,
): number {
  if (!analysis) return 1;
  if (!Number.isFinite(analysis.ts) || now - analysis.ts > maxAgeMs) return 1;
  const conf = clamp(analysis.confidence, 0, 1);
  if (analysis.bias === 'neutral' || conf <= 0) return 1;

  const damp = analysis.regime === 'volatile' ? 0.5 : analysis.regime === 'ranging' ? 0.75 : 1;
  if (analysis.bias === 'long') {
    return clamp(1 + (AI_SIZE_MAX - 1) * conf * damp, AI_SIZE_MIN, AI_SIZE_MAX);
  }
  // short → shrink the long entry, never go negative/flip
  return clamp(1 - (1 - AI_SIZE_MIN) * conf * damp, AI_SIZE_MIN, 1);
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

/** Coerce arbitrary model JSON into a valid AiAnalysis (defensive parsing). */
export function coerceAnalysis(
  raw: unknown,
  meta: { provider: 'anthropic' | 'openai'; model: string; ts: number },
): AiAnalysis {
  const o = (raw ?? {}) as Record<string, unknown>;
  const regime: Regime = ['trending', 'ranging', 'volatile'].includes(String(o.regime))
    ? (o.regime as Regime)
    : 'unknown';
  const bias: Bias = ['long', 'short', 'neutral'].includes(String(o.bias)) ? (o.bias as Bias) : 'neutral';
  const confNum = Number(o.confidence);
  const confidence = Number.isFinite(confNum) ? clamp(confNum, 0, 1) : 0;
  const rationale = typeof o.rationale === 'string' ? o.rationale.slice(0, 500) : '';
  return { regime, confidence, bias, rationale, ts: meta.ts, provider: meta.provider, model: meta.model };
}

/** Simple token-bucket rate limiter to bound a user's inference spend. */
export class RateLimiter {
  private hits: number[] = [];
  constructor(private maxPerMin: number) {}
  /** Returns true if a call is allowed now (and records it). */
  allow(now = Date.now()): boolean {
    const cutoff = now - 60_000;
    this.hits = this.hits.filter((t) => t > cutoff);
    if (this.maxPerMin > 0 && this.hits.length >= this.maxPerMin) return false;
    this.hits.push(now);
    return true;
  }
}
