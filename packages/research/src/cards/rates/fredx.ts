/**
 * FRED series for this area. With a FRED key this is `lib/fred.ts` unchanged.
 * Without one it reads the same public graph CSV, but identifies itself with a
 * descriptive client name: the FRED site holds browser-looking requests from
 * data-centre addresses open until they time out, and answers a named client
 * at once.
 */
import { fredSeries, parseFredCsv, type FredOptions, type FredSeries } from '../../lib/fred.js';
import { SourceError, type ChartBlock, type Ctx } from '../../types.js';

const CLIENT = 'b1dz-research/0.4 (+https://b1dz.com)';

export async function fred(ctx: Ctx, id: string, opts: FredOptions = {}): Promise<FredSeries> {
  if (ctx.key('FRED')) return fredSeries(ctx, id, opts);
  const start = opts.start ?? `${ctx.now().getUTCFullYear() - 10}-01-01`;
  const url = `https://fred.stlouisfed.org/graph/fredgraph.csv?id=${encodeURIComponent(id)}&cosd=${start}`;
  const text = await ctx.http.text(url, { source: 'FRED (public CSV)', ttl: opts.ttl ?? 3600, timeoutMs: 20_000, headers: { 'user-agent': CLIENT } });
  const points = parseFredCsv(text, id);
  if (!points.length) throw new SourceError('FRED (public CSV)', `no observations for ${id}`);
  return { id, points, source: 'FRED (public CSV)' };
}

/** Several FRED series as chart lines, one after another. Series that fail are named in `missing`. */
export async function fredLines(
  ctx: Ctx,
  series: { id: string; name: string }[],
  opts: FredOptions & { scale?: number } = {},
): Promise<{ lines: ChartBlock['series']; source: string; missing: string[] }> {
  const lines: ChartBlock['series'] = [];
  const missing: string[] = [];
  let source = 'FRED';
  let firstError: unknown;
  for (const s of series) {
    try {
      const got = await fred(ctx, s.id, opts);
      source = got.source;
      lines.push({ name: s.name, points: opts.scale ? got.points.map(([t, v]): [number, number] => [t, v * (opts.scale as number)]) : got.points });
    } catch (e) {
      firstError ??= e;
      missing.push(s.name);
    }
  }
  if (!lines.length) throw firstError instanceof Error ? firstError : new SourceError('FRED', 'no series available');
  return { lines, source, missing };
}
