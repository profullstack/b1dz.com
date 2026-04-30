import type { NextRequest } from 'next/server';

interface Bar {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

const KRAKEN_BASE: Record<string, string> = { BTC: 'XBT' };

function normalizePair(pair: string, exchange: string): string {
  const [base, quote] = pair.split('-');
  const b = (base ?? '').toUpperCase();
  const q = (quote ?? '').toUpperCase();
  if (!b || !q) return pair;
  switch (exchange) {
    case 'gemini': return `${b}${q}`.toLowerCase();
    case 'kraken': return `${KRAKEN_BASE[b] ?? b}${q}`;
    case 'binance-us': return `${b}${q}`;
    case 'coinbase': return `${b}-${q}`;
    default: return `${b}${q}`;
  }
}

const TIMEFRAME_SECONDS: Record<string, number> = {
  '1m': 60,
  '5m': 300,
  '15m': 900,
  '1h': 3600,
  '4h': 14400,
  '1d': 86400,
};

const KRAKEN_INTERVAL: Record<string, number> = {
  '1m': 1, '5m': 5, '15m': 15, '1h': 60, '4h': 240, '1d': 1440,
};

const BINANCE_INTERVAL: Record<string, string> = {
  '1m': '1m', '5m': '5m', '15m': '15m', '1h': '1h', '4h': '4h', '1d': '1d',
};

const GEMINI_INTERVAL: Record<string, string> = {
  '1m': '1m', '5m': '5m', '15m': '15m', '1h': '1hr', '6h': '6hr', '1d': '1day',
};

async function fetchJson(url: string): Promise<unknown> {
  const res = await fetch(url, { cache: 'no-store', signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`${url} → ${res.status}`);
  return res.json();
}

async function fromCoinbase(pair: string, timeframe: string, limit: number): Promise<Bar[]> {
  const granularity = TIMEFRAME_SECONDS[timeframe] ?? 60;
  const end = Math.floor(Date.now() / 1000);
  const start = end - Math.max(1, limit) * granularity;
  const data = await fetchJson(
    `https://api.exchange.coinbase.com/products/${pair}/candles?granularity=${granularity}&start=${start}&end=${end}`,
  );
  if (!Array.isArray(data)) return [];
  return data
    .map((row) => ({
      time: Number((row as number[])[0]) * 1000,
      low: Number((row as number[])[1]),
      high: Number((row as number[])[2]),
      open: Number((row as number[])[3]),
      close: Number((row as number[])[4]),
      volume: Number((row as number[])[5] ?? 0),
    }))
    .filter((b) => Number.isFinite(b.close))
    .sort((a, b) => a.time - b.time)
    .slice(-limit);
}

async function fromKraken(pair: string, timeframe: string, limit: number): Promise<Bar[]> {
  const interval = KRAKEN_INTERVAL[timeframe] ?? 1;
  const symbol = normalizePair(pair, 'kraken');
  const data = (await fetchJson(
    `https://api.kraken.com/0/public/OHLC?pair=${encodeURIComponent(symbol)}&interval=${interval}`,
  )) as { result?: Record<string, unknown> };
  const result = data?.result ?? {};
  const seriesKey = symbol in result ? symbol : Object.keys(result).find((k) => k !== 'last') ?? '';
  const series = (result[seriesKey] as unknown[]) ?? [];
  if (!Array.isArray(series)) return [];
  return series
    .map((row) => ({
      time: Number((row as unknown[])[0]) * 1000,
      open: Number((row as unknown[])[1]),
      high: Number((row as unknown[])[2]),
      low: Number((row as unknown[])[3]),
      close: Number((row as unknown[])[4]),
      volume: Number((row as unknown[])[6] ?? 0),
    }))
    .filter((b) => Number.isFinite(b.close))
    .slice(-limit);
}

async function fromBinanceUs(pair: string, timeframe: string, limit: number): Promise<Bar[]> {
  const interval = BINANCE_INTERVAL[timeframe] ?? '1m';
  const symbol = normalizePair(pair, 'binance-us');
  const data = await fetchJson(
    `https://api.binance.us/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${Math.min(limit, 500)}`,
  );
  if (!Array.isArray(data)) return [];
  return data
    .map((row) => ({
      time: Number((row as unknown[])[0]),
      open: Number((row as unknown[])[1]),
      high: Number((row as unknown[])[2]),
      low: Number((row as unknown[])[3]),
      close: Number((row as unknown[])[4]),
      volume: Number((row as unknown[])[5]),
    }))
    .filter((b) => Number.isFinite(b.close));
}

async function fromGemini(pair: string, timeframe: string, limit: number): Promise<Bar[]> {
  const interval = GEMINI_INTERVAL[timeframe] ?? '1m';
  const symbol = normalizePair(pair, 'gemini');
  const data = await fetchJson(`https://api.gemini.com/v2/candles/${symbol}/${interval}`);
  if (!Array.isArray(data)) return [];
  return data
    .map((row) => ({
      time: Number((row as unknown[])[0]),
      open: Number((row as unknown[])[1]),
      high: Number((row as unknown[])[2]),
      low: Number((row as unknown[])[3]),
      close: Number((row as unknown[])[4]),
      volume: Number((row as unknown[])[5] ?? 0),
    }))
    .filter((b) => Number.isFinite(b.close))
    .sort((a, b) => a.time - b.time)
    .slice(-limit);
}

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const pair = (searchParams.get('pair') ?? '').toUpperCase();
  const exchange = (searchParams.get('exchange') ?? '').toLowerCase();
  const timeframe = searchParams.get('timeframe') ?? '1m';
  const limit = Math.min(500, Math.max(20, Number(searchParams.get('limit') ?? '120') || 120));

  if (!pair || !exchange) {
    return Response.json({ error: 'pair + exchange required' }, { status: 400 });
  }

  let candles: Bar[] = [];
  try {
    switch (exchange) {
      case 'coinbase': candles = await fromCoinbase(pair, timeframe, limit); break;
      case 'kraken': candles = await fromKraken(pair, timeframe, limit); break;
      case 'binance-us':
      case 'binanceus': candles = await fromBinanceUs(pair, timeframe, limit); break;
      case 'gemini': candles = await fromGemini(pair, timeframe, limit); break;
      default: return Response.json({ error: `unsupported exchange: ${exchange}` }, { status: 400 });
    }
  } catch (e) {
    return Response.json({ error: (e as Error).message, candles: [] }, { status: 502 });
  }

  return Response.json(
    { pair, exchange, timeframe, candles },
    { headers: { 'cache-control': 'public, max-age=5, s-maxage=5' } },
  );
}
