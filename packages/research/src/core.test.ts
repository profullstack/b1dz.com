import { describe, expect, it, vi } from 'vitest';
import { formatValue, isoDate, pctChange } from './format.js';
import { Http, csvObjects, firstOf, num, parseCsv } from './http.js';
import { parseFredCsv, parseFredJson, fredSeries } from './lib/fred.js';
import { Registry, createContext } from './registry.js';
import { cardToCsv, paint, renderCard, renderChart, renderStats, renderTable, wrap } from './render.js';
import { combine, drawdown, indexed, sma, transformChart, yoy } from './transform.js';
import { MissingKeyError, SourceError, type AreaModule, type CardDef } from './types.js';

function fakeFetch(handler: (url: string, init?: RequestInit) => { status?: number; body: string }) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    const { status = 200, body } = handler(url, init);
    return new Response(body, { status });
  }) as typeof fetch;
  return { impl, calls };
}

describe('Http', () => {
  it('caches by URL for the TTL and de-duplicates in-flight requests', async () => {
    const { impl, calls } = fakeFetch(() => ({ body: '{"a":1}' }));
    const http = new Http({ fetch: impl, hostGapMs: 0 });
    const [a, b] = await Promise.all([http.json('https://x.test/a', { source: 'X' }), http.json('https://x.test/a', { source: 'X' })]);
    expect(a).toEqual({ a: 1 });
    expect(b).toEqual({ a: 1 });
    await http.json('https://x.test/a', { source: 'X' });
    expect(calls).toHaveLength(1);
    http.clearCache();
    await http.json('https://x.test/a', { source: 'X' });
    expect(calls).toHaveLength(2);
  });

  it('does not cache when ttl is 0', async () => {
    const { impl, calls } = fakeFetch(() => ({ body: 'x' }));
    const http = new Http({ fetch: impl, hostGapMs: 0 });
    await http.text('https://x.test/a', { source: 'X', ttl: 0 });
    await http.text('https://x.test/a', { source: 'X', ttl: 0 });
    expect(calls).toHaveLength(2);
  });

  it('turns an HTTP error into a SourceError and records it in health', async () => {
    const { impl } = fakeFetch((url) => (url.includes('bad') ? { status: 429, body: 'slow down' } : { body: 'ok' }));
    const http = new Http({ fetch: impl, hostGapMs: 0 });
    await expect(http.text('https://x.test/bad', { source: 'Blocked' })).rejects.toMatchObject({ name: 'SourceError', source: 'Blocked', status: 429 });
    await http.text('https://x.test/good', { source: 'Fine' });
    const health = Object.fromEntries(http.health().map((h) => [h.source, h]));
    expect(health.Blocked).toMatchObject({ ok: 0, failed: 1, lastError: 'rate limited (HTTP 429)' });
    expect(health.Fine).toMatchObject({ ok: 1, failed: 0 });
  });

  it('rejects a non-JSON body with the source named', async () => {
    const { impl } = fakeFetch(() => ({ body: '<html>challenge</html>' }));
    const http = new Http({ fetch: impl, hostGapMs: 0 });
    await expect(http.json('https://x.test/a', { source: 'Stooq' })).rejects.toThrow(/Stooq: expected JSON/);
  });

  it('identifies itself to official hosts and looks like a browser elsewhere', async () => {
    const { impl, calls } = fakeFetch(() => ({ body: '{}' }));
    const http = new Http({ fetch: impl, hostGapMs: 0, agent: 'b1dz-research/test' });
    await http.json('https://data.sec.gov/x', { source: 'SEC' });
    await http.json('https://api.nasdaq.com/x', { source: 'Nasdaq' });
    const ua = (i: number) => (calls[i].init?.headers as Record<string, string>)['user-agent'];
    expect(ua(0)).toBe('b1dz-research/test');
    expect(ua(1)).toMatch(/Mozilla/);
  });

  it('sends a JSON body as POST', async () => {
    const { impl, calls } = fakeFetch(() => ({ body: '{}' }));
    const http = new Http({ fetch: impl, hostGapMs: 0 });
    await http.json('https://x.test/p', { source: 'X', body: { a: 1 } });
    expect(calls[0].init?.method).toBe('POST');
    expect(calls[0].init?.body).toBe('{"a":1}');
  });
});

describe('firstOf', () => {
  it('returns the first provider that answers and names the ones it skipped', async () => {
    const r = await firstOf([
      { name: 'Cboe', run: async () => { throw new SourceError('Cboe', 'HTTP 403', 403); } },
      { name: 'Nasdaq', run: async () => 42 },
      { name: 'Yahoo', run: async () => 7 },
    ]);
    expect(r).toEqual({ value: 42, source: 'Nasdaq', skipped: ['Cboe unavailable (HTTP 403)'] });
  });

  it('throws the last error when nothing answers', async () => {
    await expect(firstOf([{ name: 'A', run: async () => { throw new Error('a down'); } }, { name: 'B', run: async () => { throw new Error('b down'); } }])).rejects.toThrow('b down');
  });
});

describe('parsing helpers', () => {
  it('parses CSV with quotes, embedded commas, CRLF and a BOM', () => {
    expect(parseCsv('﻿a,b\r\n"x, y","he said ""hi"""\r\n1,2\n')).toEqual([['a', 'b'], ['x, y', 'he said "hi"'], ['1', '2']]);
    expect(csvObjects('Date,Close\n2026-01-02, 10.5 \n')).toEqual([{ Date: '2026-01-02', Close: '10.5' }]);
  });

  it('reads provider numbers', () => {
    expect(num('$1,234.50')).toBe(1234.5);
    expect(num('12.3%')).toBe(12.3);
    expect(num('(4.2)')).toBe(-4.2);
    expect(num('1.5B')).toBe(1.5e9);
    expect(num('58,588,700')).toBe(58588700);
    expect(num('N/A')).toBeNull();
    expect(num('--')).toBeNull();
    expect(num('')).toBeNull();
    expect(num('abc')).toBeNull();
    expect(num(3)).toBe(3);
    expect(num(Number.NaN)).toBeNull();
  });
});

describe('format', () => {
  it('formats each kind', () => {
    expect(formatValue(1234.567, 'num')).toBe('1,234.57');
    expect(formatValue(1234.4, 'int')).toBe('1,234');
    expect(formatValue(2.5e9, 'compact')).toBe('2.50B');
    expect(formatValue(-1234.5, 'usd')).toBe('-$1,234.50');
    expect(formatValue(4.25, 'pct')).toBe('4.25%');
    expect(formatValue(1.5, 'signedPct')).toBe('+1.50%');
    expect(formatValue(-12, 'bp')).toBe('-12 bp');
    expect(formatValue(Date.UTC(2026, 0, 2), 'date')).toBe('2026-01-02');
    expect(formatValue('2026-11-24T10:00:00Z', 'date')).toBe('2026-11-24');
    expect(formatValue(null, 'num')).toBe('');
    expect(formatValue('n/a', 'num')).toBe('n/a');
    expect(formatValue(0.00012345, 'num')).toBe('0.000123');
  });

  it('computes percent change safely', () => {
    expect(pctChange(110, 100)).toBeCloseTo(10);
    expect(pctChange(-5, -10)).toBeCloseTo(50);
    expect(pctChange(1, 0)).toBeNull();
    expect(pctChange(null, 1)).toBeNull();
    expect(isoDate('not a date')).toBe('not a date');
  });
});

describe('render', () => {
  const table = {
    kind: 'table' as const,
    columns: [
      { key: 'name', label: 'Name' },
      { key: 'last', label: 'Last', format: 'num' as const },
      { key: 'chg', label: 'Day', format: 'signedPct' as const },
    ],
    rows: [
      { name: 'Apple', last: 349.08, chg: 1.9 },
      { name: 'Nvidia', last: 165.05, chg: -2.5 },
    ],
  };

  it('aligns text left and numbers right', () => {
    expect(renderTable(table, { width: 80 })).toEqual(['Name      Last     Day', 'Apple   349.08  +1.90%', 'Nvidia  165.05  -2.50%']);
  });

  it('colours signed columns and escapes braces in blessed mode', () => {
    const lines = renderTable({ ...table, rows: [{ name: '{x}', last: 1, chg: 2 }, { name: 'y', last: 1, chg: -2 }] }, { width: 80, color: 'blessed' });
    expect(lines[1]).toContain('{open}x{close}');
    expect(lines[1]).toContain('{green-fg}+2.00%{/green-fg}');
    expect(lines[2]).toContain('{red-fg}-2.00%{/red-fg}');
    expect(paint('a', 'red', 'ansi')).toBe('\x1b[31ma\x1b[0m');
  });

  it('never prints a table wider than the width given', () => {
    const wide = {
      kind: 'table' as const,
      columns: Array.from({ length: 12 }, (_, i) => ({ key: `c${i}`, label: `Column ${i}`, format: i ? ('num' as const) : undefined })),
      rows: [Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`c${i}`, i ? 123456.789 : 'A very long description of the row that goes on']))],
    };
    for (const width of [40, 60, 100]) for (const l of renderTable(wide, { width })) expect(l.length).toBeLessThanOrEqual(width);
  });

  it('caps rows and says how many are hidden', () => {
    const many = { ...table, rows: Array.from({ length: 30 }, (_, i) => ({ name: `r${i}`, last: i, chg: 0 })) };
    const lines = renderTable(many, { width: 80, maxRows: 5 });
    expect(lines).toHaveLength(7);
    expect(lines[6]).toBe('… 25 more rows');
  });

  it('draws a line chart with axis labels and a legend', () => {
    const points: [number, number][] = Array.from({ length: 50 }, (_, i) => [Date.UTC(2026, 0, 1) + i * 86_400_000, 100 + i]);
    const lines = renderChart({ kind: 'chart', xType: 'time', series: [{ name: 'SPY', points }] }, { width: 60, chartHeight: 6 });
    expect(lines).toHaveLength(8);
    expect(lines[0]).toMatch(/^\s*\d[\d.,]*│/);
    expect(lines.slice(0, 6).join('')).toMatch(/[⠁-⣿]/);
    expect(lines[6]).toContain('2026-01-01');
    expect(lines[6]).toContain('2026-02-19');
    expect(lines[7]).toBe('━ SPY 149.00');
    for (const l of lines) expect(l.length).toBeLessThanOrEqual(60);
    // Rising series: the first plot row holds the right end, the last holds the left end.
    expect(lines[0].trimEnd().length).toBeGreaterThan(lines[5].trimEnd().length);
  });

  it('draws bars for categories, negative values to the left of zero', () => {
    const lines = renderChart(
      { kind: 'chart', xType: 'category', style: 'bar', categories: ['Calls', 'Puts'], series: [{ name: 'GEX', points: [[0, 10], [1, -5]] }] },
      { width: 40 },
    );
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/^Calls\s+█+\s+10\.00$/);
    expect(lines[1].indexOf('█')).toBeLessThan(lines[0].indexOf('█'));
  });

  it('says so when a chart has no data', () => {
    expect(renderChart({ kind: 'chart', xType: 'time', series: [] }, { width: 40 })).toEqual(['(no data)']);
  });

  it('lays stats out in columns and wraps text', () => {
    const lines = renderStats({ kind: 'stats', items: [{ label: 'P/E', value: 31.2, format: 'num' }, { label: 'Yield', value: 0.5, format: 'pct' }, { label: 'Sector', value: null }] }, { width: 80 });
    expect(lines.join('\n')).toContain('31.20');
    expect(lines.join('\n')).toContain('—');
    expect(wrap('one two three four', 9)).toEqual(['one two', 'three', 'four']);
  });

  it('renders a card with notes and exports CSV with the source line', () => {
    const run = { blocks: [table], source: 'Nasdaq', asOf: '2026-11-24', notes: ['Delayed quotes.'] };
    const lines = renderCard(run, { width: 80 });
    expect(lines[lines.length - 1]).toBe('• Delayed quotes.');
    const csv = cardToCsv('Watchlist', 'Nasdaq', { blocks: [{ ...table, rows: [{ name: 'A, Inc', last: 1.5, chg: 2 }] }], asOf: '2026-11-24' });
    expect(csv).toBe('Name,Last,Day\n"A, Inc",1.5,2\n\n"Watchlist. Source: Nasdaq, as of 2026-11-24"\n');
  });
});

describe('transform', () => {
  const day = 86_400_000;
  it('rebases, measures drawdown and averages', () => {
    expect(indexed([[0, 50], [1, 75]])).toEqual([[0, 100], [1, 150]]);
    expect(drawdown([[0, 100], [1, 75], [2, 120]])).toEqual([[0, 0], [1, -25], [2, 0]]);
    expect(sma([[0, 1], [1, 2], [2, 3], [3, 4]], 2)).toEqual([[1, 1.5], [2, 2.5], [3, 3.5]]);
    expect(combine([[0, 10], [1, 20]], [[1, 5], [2, 9]], (a, b) => a / b)).toEqual([[1, 4]]);
  });

  it('computes year over year against the point one year earlier', () => {
    const pts: [number, number][] = [[0, 100], [200 * day, 104], [365.25 * day, 110], [(365.25 + 200) * day, 130]];
    const out = yoy(pts);
    expect(out).toHaveLength(2);
    expect(out[0][1]).toBeCloseTo(10);
    expect(out[1][1]).toBeCloseTo(25);
  });

  it('leaves non-time charts alone', () => {
    const curve = { kind: 'chart' as const, xType: 'number' as const, series: [{ name: 'US', points: [[2, 4.1], [10, 4.5]] as [number, number][] }] };
    expect(transformChart(curve, 'yoy')).toBe(curve);
  });
});

describe('FRED', () => {
  it('parses the public CSV and skips missing values', () => {
    expect(parseFredCsv('observation_date,DGS10\n2026-11-20,4.41\n2026-11-21,.\n2026-11-24,4.38\n', 'DGS10')).toEqual([
      [Date.UTC(2026, 10, 20), 4.41],
      [Date.UTC(2026, 10, 24), 4.38],
    ]);
    expect(parseFredJson({ observations: [{ date: '2026-11-20', value: '4.41' }, { date: '2026-11-21', value: '.' }] })).toEqual([[Date.UTC(2026, 10, 20), 4.41]]);
  });

  it('uses the keyed API when a key is set and the public CSV otherwise', async () => {
    const { impl, calls } = fakeFetch((url) =>
      url.includes('api.stlouisfed.org') ? { body: '{"observations":[{"date":"2026-11-20","value":"4.41"}]}' } : { body: 'observation_date,DGS10\n2026-11-20,4.41\n' },
    );
    const keyed = createContext({ http: new Http({ fetch: impl, hostGapMs: 0 }), keys: { FRED: 'k' }, env: {} });
    expect((await fredSeries(keyed, 'DGS10')).source).toBe('FRED');
    expect(calls[0].url).toContain('api_key=k');
    const open = createContext({ http: new Http({ fetch: impl, hostGapMs: 0 }), env: {} });
    expect((await fredSeries(open, 'DGS10')).source).toBe('FRED (public CSV)');
    expect(calls[1].url).toContain('fredgraph.csv?id=DGS10');
  });
});

describe('Registry', () => {
  const run = vi.fn(async (_ctx, p: Record<string, string>) => ({ blocks: [{ kind: 'text' as const, text: `${p.symbol}/${p.range}` }] }));
  const card: CardDef = { id: 'eq.quote', title: 'Quote board', source: 'Nasdaq', params: [{ name: 'symbol', label: 'Symbol', default: 'AAPL' }, { name: 'range', label: 'Range', default: '1Y' }], run };
  const keyed: CardDef = { id: 'en.stocks', title: 'Crude stocks', source: 'EIA', needsKey: 'EIA', run: async () => ({ blocks: [] }) };
  const mod: AreaModule = {
    cards: [card, keyed],
    dashboards: [{ id: 'company', title: 'Company', group: 'Equities', tabs: [{ id: 'overview', title: 'Overview', cards: ['eq.quote', 'eq.missing'] }] }],
    search: async (_ctx, q) => (q.toLowerCase() === 'apple' ? [{ kind: 'security', label: 'AAPL Apple Inc.', dashboard: 'company', params: { symbol: 'AAPL' } }] : []),
  };
  const ctx = createContext({ http: new Http({ fetch: fakeFetch(() => ({ body: '' })).impl }), env: { EIA_API_KEY: '' } });

  it('fills defaults, drops unknown params and labels the run', async () => {
    const reg = new Registry([mod]);
    const out = await reg.run(ctx, 'eq.quote', { symbol: ' nvda ', bogus: 'x', range: '' });
    expect(out).toMatchObject({ id: 'eq.quote', title: 'Quote board', source: 'Nasdaq', params: { symbol: 'nvda', range: '1Y' } });
    expect(run).toHaveBeenLastCalledWith(ctx, { symbol: 'nvda', range: '1Y' });
  });

  it('asks for the key instead of running a keyed card without one', async () => {
    const reg = new Registry([mod]);
    await expect(reg.run(ctx, 'en.stocks')).rejects.toBeInstanceOf(MissingKeyError);
    await expect(reg.run(createContext({ http: ctx.http, keys: { EIA: 'k' }, env: {} }), 'en.stocks')).resolves.toMatchObject({ source: 'EIA' });
    await expect(reg.run(ctx, 'nope')).rejects.toThrow('unknown card: nope');
  });

  it('reports cards a dashboard references but nobody defines, and refuses duplicate ids', () => {
    const reg = new Registry([mod]);
    expect(reg.danglingCards()).toEqual(['company/overview: eq.missing']);
    expect(() => reg.add({ cards: [card], dashboards: [] })).toThrow('duplicate card id: eq.quote');
  });

  it('searches providers first, then dashboards and cards by name', async () => {
    const reg = new Registry([mod]);
    expect((await reg.search(ctx, 'apple'))[0]).toMatchObject({ kind: 'security', params: { symbol: 'AAPL' } });
    const byName = await reg.search(ctx, 'quote');
    expect(byName.map((h) => h.kind)).toEqual(['card']);
    expect(byName[0]).toMatchObject({ dashboard: 'company', tab: 'overview' });
    expect(await reg.search(ctx, '  ')).toEqual([]);
  });

  it('lists the catalog with params', () => {
    const { cards } = new Registry([mod]).catalog();
    expect(cards.find((c) => c.id === 'en.stocks')?.needsKey).toBe('EIA');
    expect(cards.find((c) => c.id === 'eq.quote')?.params.map((p) => p.name)).toEqual(['symbol', 'range']);
  });
});
