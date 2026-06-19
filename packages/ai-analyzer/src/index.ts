/**
 * @b1dz/ai-analyzer — the "Coinbase Advisor" analog. b1dz calls out to the
 * user's OWN model (Claude or ChatGPT) to score market regime/bias; the result
 * is overlaid on the deterministic engine's sizing via `aiSizeMultiplier`, and
 * the spend budget remains the hard cap. The AI never places trades by itself.
 */

import {
  callAnthropic,
  callOpenAI,
  DEFAULT_ANTHROPIC_MODEL,
  DEFAULT_OPENAI_MODEL,
  type AnalyzePromptInput,
  type FetchLike,
} from './providers.js';
import { coerceAnalysis, type AiAnalysis } from './overlay.js';

export type AiProvider = 'anthropic' | 'openai';

export interface AnalyzeOptions {
  provider: AiProvider;
  apiKey: string;
  model?: string;
  fetchImpl?: FetchLike;
}

/**
 * Run one analysis. Throws on transport/auth errors (the caller decides whether
 * to disable the analyzer); returns a normalized AiAnalysis on success.
 */
export async function analyze(input: AnalyzePromptInput, opts: AnalyzeOptions): Promise<AiAnalysis> {
  const ts = Date.now();
  if (opts.provider === 'openai') {
    const model = opts.model ?? DEFAULT_OPENAI_MODEL;
    const raw = await callOpenAI(opts.apiKey, input, { model, fetchImpl: opts.fetchImpl });
    return coerceAnalysis(raw, { provider: 'openai', model, ts });
  }
  const model = opts.model ?? DEFAULT_ANTHROPIC_MODEL;
  const raw = await callAnthropic(opts.apiKey, input, { model, fetchImpl: opts.fetchImpl });
  return coerceAnalysis(raw, { provider: 'anthropic', model, ts });
}

export {
  aiSizeMultiplier,
  coerceAnalysis,
  RateLimiter,
  AI_SIZE_MIN,
  AI_SIZE_MAX,
  type AiAnalysis,
  type Regime,
  type Bias,
} from './overlay.js';
export {
  buildUserPrompt,
  extractJson,
  DEFAULT_ANTHROPIC_MODEL,
  DEFAULT_OPENAI_MODEL,
  type AnalyzePromptInput,
  type FetchLike,
} from './providers.js';
