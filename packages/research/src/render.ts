/**
 * Text rendering of card blocks for terminals: aligned tables, braille line
 * charts, horizontal bars, key/value grids. Output is an array of lines in
 * one of three colour dialects: blessed tags (TUI), ANSI (CLI) or none.
 */
import { compact, formatValue, isNumeric, isSigned, isoDate, signOf } from './format.js';
import type { Block, CardResult, ChartBlock, Format, StatsBlock, TableBlock, TextBlock } from './types.js';

export type ColorMode = 'blessed' | 'ansi' | 'none';
export type Tone = 'green' | 'red' | 'yellow' | 'cyan' | 'magenta' | 'blue' | 'white' | 'dim' | 'bold';

export interface RenderOptions {
  width: number;
  /** Rows for a chart's plot area. Default 12. */
  chartHeight?: number;
  /** Cap on table rows; the rest is summarised as "… N more". */
  maxRows?: number;
  color?: ColorMode;
}

const ANSI: Record<Tone, string> = {
  green: '32', red: '31', yellow: '33', cyan: '36', magenta: '35', blue: '34', white: '37', dim: '2', bold: '1',
};
const BLESSED: Record<Tone, string> = {
  green: 'green-fg', red: 'red-fg', yellow: 'yellow-fg', cyan: 'cyan-fg', magenta: 'magenta-fg',
  blue: 'blue-fg', white: 'white-fg', dim: 'gray-fg', bold: 'bold',
};

/** Colour `text`. In blessed mode braces in the data are escaped so they cannot be read as tags. */
export function paint(text: string, tone: Tone | undefined, mode: ColorMode = 'none'): string {
  const safe = mode === 'blessed' ? text.replace(/[{}]/g, (c) => (c === '{' ? '{open}' : '{close}')) : text;
  if (!tone || mode === 'none' || text === '') return safe;
  if (mode === 'ansi') return `\x1b[${ANSI[tone]}m${safe}\x1b[0m`;
  return `{${BLESSED[tone]}}${safe}{/${BLESSED[tone]}}`;
}

function clip(s: string, width: number): string {
  if (width <= 0) return '';
  return s.length <= width ? s : width === 1 ? '…' : `${s.slice(0, width - 1)}…`;
}

function pad(s: string, width: number, right: boolean): string {
  const c = clip(s, width);
  return right ? c.padStart(width) : c.padEnd(width);
}

export function renderTable(block: TableBlock, opts: RenderOptions): string[] {
  const mode = opts.color ?? 'none';
  const out: string[] = [];
  if (block.title) out.push(paint(clip(block.title, opts.width), 'bold', mode));
  let cols = block.columns.slice();
  if (!cols.length) return out;
  const shown = opts.maxRows !== undefined ? block.rows.slice(0, opts.maxRows) : block.rows;
  const cells = shown.map((r) => cols.map((c) => formatValue(r[c.key], c.format, c.digits)));
  let widths = cols.map((c, i) =>
    Math.min(c.maxWidth ?? 44, Math.max(c.label.length, ...cells.map((r) => r[i].length), 1)),
  );
  const total = () => widths.reduce((a, b) => a + b, 0) + 2 * (widths.length - 1);
  // Too wide: narrow the widest text column first, then drop columns from the right.
  while (total() > opts.width && widths.length > 1) {
    let widest = -1;
    for (let i = 0; i < widths.length; i++) {
      if (!isNumeric(cols[i].format) && widths[i] > 10 && (widest < 0 || widths[i] > widths[widest])) widest = i;
    }
    if (widest >= 0) widths[widest] -= 1;
    else {
      cols = cols.slice(0, -1);
      widths = widths.slice(0, -1);
    }
  }
  if (total() > opts.width) widths[0] = Math.max(1, opts.width);
  const rightOf = (i: number) => (cols[i].align ? cols[i].align === 'right' : isNumeric(cols[i].format));

  out.push(paint(cols.map((c, i) => pad(c.label, widths[i], rightOf(i))).join('  '), 'cyan', mode));
  shown.forEach((row, r) => {
    out.push(
      cols
        .map((c, i) => {
          const text = pad(cells[r][i], widths[i], rightOf(i));
          const s = isSigned(c.format) ? signOf(row[c.key]) : 0;
          return paint(text, s > 0 ? 'green' : s < 0 ? 'red' : undefined, mode);
        })
        .join('  '),
    );
  });
  if (!block.rows.length) out.push(paint('(no rows)', 'dim', mode));
  if (shown.length < block.rows.length) out.push(paint(`… ${block.rows.length - shown.length} more rows`, 'dim', mode));
  if (block.footnote) for (const l of wrap(block.footnote, opts.width)) out.push(paint(l, 'dim', mode));
  return out;
}

export function wrap(text: string, width: number): string[] {
  const out: string[] = [];
  const w = Math.max(8, width);
  for (const para of text.split('\n')) {
    if (para.trim() === '') {
      out.push('');
      continue;
    }
    let line = '';
    for (const word of para.split(/\s+/)) {
      if (!word) continue;
      if (line && line.length + 1 + word.length > w) {
        out.push(line);
        line = '';
      }
      let rest = word;
      while (rest.length > w) {
        out.push(rest.slice(0, w));
        rest = rest.slice(w);
      }
      line = line ? `${line} ${rest}` : rest;
    }
    if (line) out.push(line);
  }
  return out;
}

export function renderText(block: TextBlock, opts: RenderOptions): string[] {
  const mode = opts.color ?? 'none';
  const out: string[] = [];
  if (block.title) out.push(paint(clip(block.title, opts.width), 'bold', mode));
  for (const l of wrap(block.text, opts.width)) out.push(paint(l, undefined, mode));
  return out;
}

export function renderStats(block: StatsBlock, opts: RenderOptions): string[] {
  const mode = opts.color ?? 'none';
  const out: string[] = [];
  if (block.title) out.push(paint(clip(block.title, opts.width), 'bold', mode));
  const items = block.items.map((it) => ({ ...it, text: formatValue(it.value, it.format, it.digits) || '—' }));
  if (!items.length) return out;
  const labelW = Math.min(24, Math.max(...items.map((i) => i.label.length)));
  const valueW = Math.min(22, Math.max(...items.map((i) => i.text.length)));
  const cellW = labelW + 1 + valueW;
  const perRow = Math.max(1, Math.floor((opts.width + 3) / (cellW + 3)));
  for (let i = 0; i < items.length; i += perRow) {
    out.push(
      items
        .slice(i, i + perRow)
        .map((it) => {
          const s = isSigned(it.format) ? signOf(it.value) : 0;
          return `${paint(pad(it.label, labelW, false), 'dim', mode)} ${paint(pad(it.text, valueW, true), s > 0 ? 'green' : s < 0 ? 'red' : undefined, mode)}`;
        })
        .join('   '),
    );
  }
  return out;
}

const SERIES_TONES: Tone[] = ['cyan', 'yellow', 'magenta', 'green', 'red', 'blue', 'white', 'dim'];
// Braille dot bit for (column 0..1, row 0..3 from the top) inside one cell.
const DOT = [
  [0x01, 0x08],
  [0x02, 0x10],
  [0x04, 0x20],
  [0x40, 0x80],
];

function axisLabel(v: number, format: Format | undefined, digits: number | undefined): string {
  if (format && format !== 'num') return formatValue(v, format, digits);
  if (Math.abs(v) >= 100_000) return compact(v, 1);
  return formatValue(v, 'num', digits ?? (Math.abs(v) >= 1000 ? 0 : 2));
}

function xLabelOf(block: ChartBlock, x: number): string {
  if (block.xType === 'time') return isoDate(x);
  if (block.xType === 'category') return block.categories?.[Math.round(x)] ?? String(x);
  return formatValue(x, 'num', Number.isInteger(x) ? 0 : 2);
}

function renderBars(block: ChartBlock, opts: RenderOptions): string[] {
  const mode = opts.color ?? 'none';
  const pts = block.series[0]?.points ?? [];
  const shown = opts.maxRows !== undefined ? pts.slice(0, opts.maxRows) : pts;
  if (!shown.length) return [paint('(no data)', 'dim', mode)];
  const labels = shown.map(([x]) => xLabelOf(block, x));
  const values = shown.map(([, y]) => formatValue(y, block.yFormat ?? 'num', block.yDigits));
  const labelW = Math.min(18, Math.max(...labels.map((l) => l.length)));
  const valueW = Math.max(...values.map((v) => v.length));
  const barW = Math.max(6, opts.width - labelW - valueW - 4);
  const lo = Math.min(0, ...shown.map(([, y]) => y));
  const hi = Math.max(0, ...shown.map(([, y]) => y));
  const span = hi - lo || 1;
  const zero = Math.round(((0 - lo) / span) * barW);
  const out = shown.map(([, y], i) => {
    const at = Math.round(((y - lo) / span) * barW);
    const from = Math.min(zero, at);
    const len = Math.max(y === 0 ? 0 : 1, Math.abs(at - zero));
    const bar = `${' '.repeat(from)}${'█'.repeat(len)}`.padEnd(barW + 1).slice(0, barW + 1);
    return `${pad(labels[i], labelW, false)} ${paint(bar, y >= 0 ? 'green' : 'red', mode)} ${pad(values[i], valueW, true)}`;
  });
  if (shown.length < pts.length) out.push(paint(`… ${pts.length - shown.length} more`, 'dim', mode));
  return out;
}

export function renderChart(block: ChartBlock, opts: RenderOptions): string[] {
  const mode = opts.color ?? 'none';
  const out: string[] = [];
  if (block.title) out.push(paint(clip(block.title, opts.width), 'bold', mode));
  if (block.style === 'bar') return out.concat(renderBars(block, opts));

  const series = block.series.filter((s) => s.points.some(([x, y]) => Number.isFinite(x) && Number.isFinite(y)));
  if (!series.length) return out.concat(paint('(no data)', 'dim', mode));
  const all = series.flatMap((s) => s.points).filter(([x, y]) => Number.isFinite(x) && Number.isFinite(y));
  let xMin = Math.min(...all.map((p) => p[0]));
  let xMax = Math.max(...all.map((p) => p[0]));
  let yMin = Math.min(...all.map((p) => p[1]));
  let yMax = Math.max(...all.map((p) => p[1]));
  if (xMin === xMax) {
    xMin -= 1;
    xMax += 1;
  }
  if (yMin === yMax) {
    const d = Math.abs(yMin) * 0.05 || 1;
    yMin -= d;
    yMax += d;
  }
  const yPad = (yMax - yMin) * 0.04;
  yMin -= yPad;
  yMax += yPad;

  const height = Math.max(4, opts.chartHeight ?? 12);
  const top = axisLabel(yMax, block.yFormat, block.yDigits);
  const bottom = axisLabel(yMin, block.yFormat, block.yDigits);
  const gutter = Math.max(top.length, bottom.length, axisLabel((yMin + yMax) / 2, block.yFormat, block.yDigits).length) + 1;
  const plotW = Math.max(10, opts.width - gutter - 1);
  const dotsW = plotW * 2;
  const dotsH = height * 4;
  const bits = Array.from({ length: height }, () => new Uint8Array(plotW));
  const owner = Array.from({ length: height }, () => new Int8Array(plotW).fill(-1));

  const set = (dx: number, dy: number, s: number) => {
    if (dx < 0 || dy < 0 || dx >= dotsW || dy >= dotsH) return;
    const cx = dx >> 1;
    const cy = dy >> 2;
    bits[cy][cx] |= DOT[dy & 3][dx & 1];
    owner[cy][cx] = s;
  };
  const toX = (x: number) => Math.round(((x - xMin) / (xMax - xMin)) * (dotsW - 1));
  const toY = (y: number) => Math.round((1 - (y - yMin) / (yMax - yMin)) * (dotsH - 1));

  series.forEach((s, si) => {
    const pts = s.points.filter(([x, y]) => Number.isFinite(x) && Number.isFinite(y)).sort((a, b) => a[0] - b[0]);
    let prev: [number, number] | null = null;
    for (const [x, y] of pts) {
      const cur: [number, number] = [toX(x), toY(y)];
      if (prev) {
        // Bresenham between consecutive points so the line is continuous.
        let [x0, y0] = prev;
        const [x1, y1] = cur;
        const dx = Math.abs(x1 - x0);
        const dy = -Math.abs(y1 - y0);
        const sx = x0 < x1 ? 1 : -1;
        const sy = y0 < y1 ? 1 : -1;
        let err = dx + dy;
        for (;;) {
          set(x0, y0, si);
          if (x0 === x1 && y0 === y1) break;
          const e2 = 2 * err;
          if (e2 >= dy) {
            err += dy;
            x0 += sx;
          }
          if (e2 <= dx) {
            err += dx;
            y0 += sy;
          }
        }
      } else set(cur[0], cur[1], si);
      prev = cur;
    }
  });

  for (let r = 0; r < height; r++) {
    const yHere = yMax - ((r + 0.5) / height) * (yMax - yMin);
    const label = r === 0 ? top : r === height - 1 ? bottom : r === Math.floor(height / 2) ? axisLabel(yHere, block.yFormat, block.yDigits) : '';
    let line = `${paint(label.padStart(gutter - 1), 'dim', mode)}${paint('│', 'dim', mode)}`;
    // Group runs of one owner so colour tags stay short.
    let run = '';
    let runOwner = -2;
    const flush = () => {
      if (run) line += runOwner >= 0 ? paint(run, SERIES_TONES[runOwner % SERIES_TONES.length], mode) : run;
      run = '';
    };
    for (let c = 0; c < plotW; c++) {
      const o = owner[r][c];
      if (o !== runOwner) {
        flush();
        runOwner = o;
      }
      run += bits[r][c] ? String.fromCharCode(0x2800 + bits[r][c]) : ' ';
    }
    flush();
    out.push(line);
  }

  const left = xLabelOf(block, xMin);
  const right = xLabelOf(block, xMax);
  const mid = block.xLabel ?? xLabelOf(block, (xMin + xMax) / 2);
  const gap = plotW - left.length - right.length - mid.length;
  const axis =
    gap >= 2
      ? `${left}${' '.repeat(Math.floor(gap / 2))}${mid}${' '.repeat(Math.ceil(gap / 2))}${right}`
      : `${left}${' '.repeat(Math.max(1, plotW - left.length - right.length))}${right}`;
  out.push(paint(`${' '.repeat(gutter)}${axis}`, 'dim', mode));
  if (series.length > 1 || series[0].name) {
    out.push(
      series
        .map((s, i) => {
          const last = s.points[s.points.length - 1]?.[1];
          const tail = last === undefined ? '' : ` ${axisLabel(last, block.yFormat, block.yDigits)}`;
          return paint(`━ ${s.name}${tail}`, SERIES_TONES[i % SERIES_TONES.length], mode);
        })
        .join('  '),
    );
  }
  return out;
}

export function renderBlock(block: Block, opts: RenderOptions): string[] {
  switch (block.kind) {
    case 'table':
      return renderTable(block, opts);
    case 'chart':
      return renderChart(block, opts);
    case 'stats':
      return renderStats(block, opts);
    case 'text':
      return renderText(block, opts);
  }
}

/** A whole card body: blocks separated by a blank line, then notes. */
export function renderCard(result: CardResult, opts: RenderOptions): string[] {
  const mode = opts.color ?? 'none';
  const out: string[] = [];
  result.blocks.forEach((b, i) => {
    if (i) out.push('');
    out.push(...renderBlock(b, opts));
  });
  for (const n of result.notes ?? []) for (const l of wrap(`• ${n}`, opts.width)) out.push(paint(l, 'dim', mode));
  return out;
}

function csvField(v: string): string {
  return /[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

/** Every table and chart in a card as CSV, each preceded by its title, ending with the source line. */
export function cardToCsv(title: string, source: string, result: CardResult): string {
  const lines: string[] = [];
  for (const b of result.blocks) {
    if (b.kind === 'table') {
      if (b.title) lines.push(csvField(b.title));
      lines.push(b.columns.map((c) => csvField(c.label)).join(','));
      for (const r of b.rows) {
        lines.push(
          b.columns
            .map((c) => {
              const v = r[c.key];
              if (v === null || v === undefined) return '';
              if (c.format === 'date') return isoDate(v as number | string);
              return csvField(String(v));
            })
            .join(','),
        );
      }
      lines.push('');
    } else if (b.kind === 'chart') {
      if (b.title) lines.push(csvField(b.title));
      const xs = [...new Set(b.series.flatMap((s) => s.points.map((p) => p[0])))].sort((a, z) => a - z);
      lines.push(['x', ...b.series.map((s) => csvField(s.name))].join(','));
      const maps = b.series.map((s) => new Map(s.points));
      for (const x of xs) {
        const label = b.xType === 'time' ? isoDate(x) : b.xType === 'category' ? (b.categories?.[x] ?? String(x)) : String(x);
        lines.push([csvField(label), ...maps.map((m) => (m.has(x) ? String(m.get(x)) : ''))].join(','));
      }
      lines.push('');
    } else if (b.kind === 'stats') {
      if (b.title) lines.push(csvField(b.title));
      for (const it of b.items) lines.push(`${csvField(it.label)},${it.value ?? ''}`);
      lines.push('');
    }
  }
  lines.push(csvField(`${title}. Source: ${result.source ?? source}${result.asOf ? `, as of ${result.asOf}` : ''}`));
  return `${lines.join('\n')}\n`;
}
