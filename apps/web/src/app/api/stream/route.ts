/**
 * GET /api/stream — Server-Sent Events feed for realtime state.
 *
 * Replaces the client-side setInterval(fetch, 3000) poll that every browser
 * tab and the TUI CLI were doing. SSE gives us:
 *   - One persistent connection per client instead of one new TCP connection
 *     every 3 seconds (×4 source keys = 4 fetches/3s per tab).
 *   - Server-side delta detection — we only push a named event when the
 *     underlying data actually changed. Silent ticks cost ~0 bytes.
 *   - Sub-second chart ticks — the daemon's arb worker updates Redis every
 *     ~2s; we check every 500ms and push `ticker` events immediately.
 *   - Browser auto-reconnect via the EventSource API (exponential backoff
 *     built in, no client code needed).
 *
 * Named events:
 *   state:arb      — ArbState payload (spreads, prices, balances, logs)
 *   state:trade    — TradeState payload (positions, PnL, signals)
 *   state:pipeline — ArbPipelineState payload (v2 observer)
 *   state:settings — UiSettings payload
 *   ticker         — { pair, exchange, bid, ask, ts } — current best price
 *                    for the pair(s) in the `ticker` query param, sourced
 *                    from the latest arb prices[] array.
 *   ping           — empty keepalive every 20s so proxies/load-balancers
 *                    don't tear down the connection on idle.
 *
 * Auth:
 *   Cookie session (browser) — automatic, no extra headers needed.
 *   Bearer token (TUI / SDK) — pass as Authorization header, which
 *     EventSource doesn't support natively. Use the `token` query param
 *     as a fallback: /api/stream?token=<access_token>
 *
 * Query params:
 *   ticker   comma-separated "pair:exchange" subscriptions, e.g.
 *            ticker=BTC-USD:kraken,ETH-USD:coinbase
 *            If omitted, all available pairs from the arb state are streamed.
 */

import type { NextRequest } from 'next/server';
import { getRuntimeSourceState } from '@b1dz/core';
import { createClient } from '@supabase/supabase-js';
import { createServerClient } from '@supabase/ssr';
import { cookies } from 'next/headers';

const URL_ = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const PUB = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!;

/** Check query-param token first (for EventSource which can't send headers),
 *  then Authorization header, then cookie session. */
async function authenticateStream(req: NextRequest): Promise<string | null> {
  // 1. ?token= query param (EventSource browsers, TUI using fetch streaming)
  const qToken = new URL(req.url).searchParams.get('token');
  if (qToken) {
    const client = createClient(URL_, PUB, {
      global: { headers: { Authorization: `Bearer ${qToken}` } },
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data, error } = await client.auth.getUser(qToken);
    if (!error && data.user) return data.user.id;
  }

  // 2. Authorization: Bearer header (SDK / TUI native fetch streaming)
  const auth = req.headers.get('authorization');
  if (auth?.startsWith('Bearer ')) {
    const token = auth.slice(7);
    const client = createClient(URL_, PUB, {
      global: { headers: { Authorization: `Bearer ${token}` } },
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data, error } = await client.auth.getUser(token);
    if (!error && data.user) return data.user.id;
  }

  // 3. Cookie session (browser)
  const cookieStore = await cookies();
  const client = createServerClient(URL_, PUB, {
    cookies: { getAll: () => cookieStore.getAll(), setAll: () => {} },
  });
  const { data: { user } } = await client.auth.getUser();
  return user?.id ?? null;
}

const POLL_MS = 500;       // how often to check Redis server-side
const PING_MS = 20_000;    // keepalive so proxies don't kill idle connections

const enc = new TextEncoder();

function sseMsg(event: string, data: unknown): Uint8Array {
  const json = typeof data === 'string' ? data : JSON.stringify(data);
  return enc.encode(`event: ${event}\ndata: ${json}\n\n`);
}

function ssePing(): Uint8Array {
  return enc.encode(': ping\n\n');
}

interface PriceRow {
  pair: string;
  exchange: string;
  bid: number;
  ask: number;
}

interface ArbStateRaw {
  prices?: PriceRow[];
  [key: string]: unknown;
}

export async function GET(req: NextRequest) {
  const userId = await authenticateStream(req);
  if (!userId) {
    return new Response('unauthorized', { status: 401 });
  }

  // Parse requested ticker subscriptions from query.
  // Format: ?ticker=BTC-USD:kraken,ETH-USD:coinbase
  const tickerParam = new URL(req.url).searchParams.get('ticker') ?? '';
  const tickerSubs = tickerParam
    ? tickerParam.split(',').map((s) => {
        const [pair, exchange] = s.trim().split(':');
        return { pair: pair ?? '', exchange: exchange ?? '' };
      }).filter((t) => t.pair)
    : [];

  // Hashes of the last-pushed payload for delta detection.
  // Simple JSON-length + first-100-chars as a cheap fingerprint — good
  // enough to detect change, not a cryptographic hash.
  const fingerprint = (v: unknown): string => {
    const s = JSON.stringify(v) ?? '';
    return `${s.length}:${s.slice(0, 80)}`;
  };
  const lastFp: Record<string, string> = {};

  let timer: ReturnType<typeof setInterval> | null = null;
  let pingTimer: ReturnType<typeof setInterval> | null = null;
  let closed = false;

  const stream = new ReadableStream({
    start(controller) {
      const push = (event: string, data: unknown) => {
        if (closed) return;
        try {
          controller.enqueue(sseMsg(event, data));
        } catch {
          // Controller already closed (client disconnected).
          closed = true;
        }
      };

      const tick = async () => {
        if (closed) return;
        try {
          // Fetch all four source keys in parallel — they're all cheap Redis
          // reads from the same instance.
          const [arb, trade, pipeline, settings] = await Promise.allSettled([
            getRuntimeSourceState<unknown>(userId, 'crypto-arb'),
            getRuntimeSourceState<unknown>(userId, 'crypto-trade'),
            getRuntimeSourceState<unknown>(userId, 'arb-pipeline'),
            getRuntimeSourceState<unknown>(userId, 'crypto-ui-settings'),
          ]);

          const arbVal = arb.status === 'fulfilled' ? arb.value : null;
          const tradeVal = trade.status === 'fulfilled' ? trade.value : null;
          const pipelineVal = pipeline.status === 'fulfilled' ? pipeline.value : null;
          const settingsVal = settings.status === 'fulfilled' ? settings.value : null;

          // Delta push — only send if changed since last push.
          for (const [key, val] of [
            ['state:arb', arbVal],
            ['state:trade', tradeVal],
            ['state:pipeline', pipelineVal],
            ['state:settings', settingsVal],
          ] as [string, unknown][]) {
            if (val === null) continue;
            const fp = fingerprint(val);
            if (fp !== lastFp[key]) {
              lastFp[key] = fp;
              push(key, val);
            }
          }

          // Ticker events — sourced from the arb state's prices[] array which
          // the daemon updates every ~2s from the WS price cache.
          // Pushed on every tick regardless of delta so the chart's current
          // candle always has the latest close price.
          const prices = (arbVal as ArbStateRaw | null)?.prices;
          if (Array.isArray(prices) && prices.length > 0) {
            const toSend = tickerSubs.length > 0
              ? prices.filter((p) =>
                  tickerSubs.some(
                    (t) => t.pair === p.pair && (!t.exchange || t.exchange === p.exchange),
                  ),
                )
              : prices; // no filter — send all (console shows all pairs)

            if (toSend.length > 0) {
              push('ticker', toSend.map((p) => ({
                pair: p.pair,
                exchange: p.exchange,
                bid: p.bid,
                ask: p.ask,
                ts: Date.now(),
              })));
            }
          }
        } catch {
          // Redis/DB hiccup — don't close the stream, just skip this tick.
        }
      };

      // First push immediately so the UI doesn't blank on connect.
      void tick();
      timer = setInterval(() => { void tick(); }, POLL_MS);

      pingTimer = setInterval(() => {
        if (closed) return;
        try {
          controller.enqueue(ssePing());
        } catch {
          closed = true;
        }
      }, PING_MS);
    },

    cancel() {
      closed = true;
      if (timer) clearInterval(timer);
      if (pingTimer) clearInterval(pingTimer);
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      // Vercel / Railway: disable response buffering so events flush immediately.
      'X-Accel-Buffering': 'no',
    },
  });
}
