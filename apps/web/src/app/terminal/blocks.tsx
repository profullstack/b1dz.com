'use client';

/** Renderers for research card blocks: table, chart (SVG line or bars), stats, text. */
import { useEffect, useMemo, useRef, useState } from 'react';
import { formatValue, isNumeric, isSigned, signOf } from '@b1dz/research/format';
import { transformChart, type Transform } from '@b1dz/research/transform';
import type { Block, ChartBlock, StatsBlock, TableBlock, TextBlock } from '@b1dz/research/types';
import { axisLabel, barGeometry, lineGeometry, nearestIndex, valueAt } from './logic';

const tone = (sign: number) => (sign > 0 ? 'text-emerald-400' : sign < 0 ? 'text-red-400' : '');

function Title({ children }: { children?: string }) {
  return children ? <div className="mb-1 text-xs font-semibold text-zinc-300">{children}</div> : null;
}

function Table({ block, full }: { block: TableBlock; full: boolean }) {
  const cap = full ? 500 : 14;
  const rows = block.rows.slice(0, cap);
  return (
    <div>
      <Title>{block.title}</Title>
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-xs">
          <thead>
            <tr>
              {block.columns.map((c) => (
                <th
                  key={c.key}
                  scope="col"
                  className={`whitespace-nowrap border-b border-zinc-800 px-2 py-1 font-medium text-cyan-400/90 ${(c.align ? c.align === 'right' : isNumeric(c.format)) ? 'text-right' : 'text-left'}`}
                >
                  {c.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, i) => (
              <tr key={i} className="border-b border-zinc-900 hover:bg-zinc-900/60">
                {block.columns.map((c) => {
                  const right = c.align ? c.align === 'right' : isNumeric(c.format);
                  const text = formatValue(row[c.key], c.format, c.digits);
                  return (
                    <td
                      key={c.key}
                      title={text.length > 40 ? text : undefined}
                      className={`px-2 py-[3px] ${right ? 'whitespace-nowrap text-right tabular-nums' : 'max-w-[26rem] truncate text-left'} ${isSigned(c.format) ? tone(signOf(row[c.key])) : ''}`}
                    >
                      {/^https?:\/\/\S+$/.test(text) ? (
                        <a href={text} target="_blank" rel="noopener noreferrer" className="text-cyan-400 hover:underline">
                          open ↗
                        </a>
                      ) : (
                        text
                      )}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {!block.rows.length && <div className="py-1 text-xs text-zinc-500">(no rows)</div>}
      {block.rows.length > rows.length && (
        <div className="pt-1 text-xs text-zinc-500">
          … {block.rows.length - rows.length} more rows{full ? ' (export CSV for all)' : ' (maximize to see more)'}
        </div>
      )}
      {block.footnote && <div className="pt-1 text-xs text-zinc-500">{block.footnote}</div>}
    </div>
  );
}

function Bars({ block, full }: { block: ChartBlock; full: boolean }) {
  const { bars, hidden } = useMemo(() => barGeometry(block, full ? 200 : 24), [block, full]);
  if (!bars.length) return <div className="text-xs text-zinc-500">(no data)</div>;
  return (
    <div className="space-y-[2px] text-xs">
      {bars.map((b, i) => (
        <div key={i} className="grid grid-cols-[minmax(4rem,9rem)_1fr_auto] items-center gap-2">
          <span className="truncate text-zinc-400">{b.label}</span>
          <span className="relative h-3 rounded-sm bg-zinc-900">
            <span
              className={`absolute top-0 h-3 rounded-sm ${b.value >= 0 ? 'bg-emerald-500/70' : 'bg-red-500/70'}`}
              style={{ left: `${b.left}%`, width: `${b.width}%` }}
            />
          </span>
          <span className="tabular-nums text-zinc-300">{b.text}</span>
        </div>
      ))}
      {hidden > 0 && <div className="text-zinc-500">… {hidden} more</div>}
    </div>
  );
}

function Lines({ block, full }: { block: ChartBlock; full: boolean }) {
  const wrap = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(560);
  const [hover, setHover] = useState<number | null>(null);
  const height = full ? 420 : 190;

  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const measure = () => setWidth(Math.max(240, Math.floor(el.clientWidth)));
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const g = useMemo(() => lineGeometry(block, width, height), [block, width, height]);
  if (!g) return <div ref={wrap} className="text-xs text-zinc-500">(no data)</div>;
  const at = hover !== null ? g.xs[hover] : null;

  return (
    <div ref={wrap}>
      <svg
        width={g.width}
        height={g.height}
        role="img"
        aria-label={block.title ?? block.series.map((s) => s.name).join(', ')}
        className="block touch-none select-none"
        onPointerMove={(e) => {
          const box = e.currentTarget.getBoundingClientRect();
          setHover(nearestIndex(g.xs, e.clientX - box.left));
        }}
        onPointerLeave={() => setHover(null)}
      >
        {g.yTicks.map((t, i) => (
          <g key={i}>
            <line x1={g.plot.left} x2={g.plot.right} y1={t.y} y2={t.y} stroke="#27272a" strokeWidth={1} />
            <text x={g.plot.left - 6} y={t.y + 3} textAnchor="end" fontSize={10} fill="#71717a">
              {t.label}
            </text>
          </g>
        ))}
        {g.zeroY !== null && <line x1={g.plot.left} x2={g.plot.right} y1={g.zeroY} y2={g.zeroY} stroke="#52525b" strokeDasharray="3 3" />}
        {g.lines.map((l) => (
          <path key={l.name} d={l.path} fill="none" stroke={l.color} strokeWidth={1.4} strokeLinejoin="round" />
        ))}
        {at && <line x1={at.x} x2={at.x} y1={g.plot.top} y2={g.plot.bottom} stroke="#a1a1aa" strokeWidth={1} />}
        {g.xTicks.map((t, i) => (
          <text key={i} x={t.x} y={g.height - 4} textAnchor={t.anchor} fontSize={10} fill="#71717a">
            {t.label}
          </text>
        ))}
      </svg>
      <div className="flex flex-wrap gap-x-4 gap-y-0.5 pt-1 text-xs">
        {at && <span className="text-zinc-400">{at.label}</span>}
        {block.series.map((s, i) => {
          const line = g.lines.find((l) => l.name === s.name);
          if (!line) return null;
          const v = at ? valueAt(s.points, at.value) : line.last;
          return (
            <span key={`${s.name}-${i}`} style={{ color: line.color }}>
              ━ {s.name || 'value'} <span className="tabular-nums">{v === null ? '' : axisLabel(v, block.yFormat, block.yDigits)}</span>
            </span>
          );
        })}
      </div>
    </div>
  );
}

function Chart({ block, full, transform }: { block: ChartBlock; full: boolean; transform: Transform }) {
  const shown = useMemo(() => transformChart(block, transform), [block, transform]);
  return (
    <div>
      <Title>{shown.title}</Title>
      {shown.style === 'bar' ? <Bars block={shown} full={full} /> : <Lines block={shown} full={full} />}
    </div>
  );
}

function Stats({ block }: { block: StatsBlock }) {
  return (
    <div>
      <Title>{block.title}</Title>
      <dl className="grid grid-cols-[repeat(auto-fill,minmax(13rem,1fr))] gap-x-6 gap-y-[2px] text-xs">
        {block.items.map((it, i) => (
          <div key={i} className="flex items-baseline justify-between gap-3 border-b border-zinc-900 py-[2px]">
            <dt className="truncate text-zinc-500">{it.label}</dt>
            <dd className={`whitespace-nowrap tabular-nums ${isSigned(it.format) ? tone(signOf(it.value)) : 'text-zinc-200'}`}>
              {formatValue(it.value, it.format, it.digits) || '—'}
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

function Text({ block, full }: { block: TextBlock; full: boolean }) {
  return (
    <div>
      <Title>{block.title}</Title>
      <div className={`whitespace-pre-wrap break-words text-xs leading-relaxed text-zinc-300 ${full ? '' : 'max-h-64 overflow-y-auto'}`}>{block.text}</div>
    </div>
  );
}

export function BlockView({ block, full, transform }: { block: Block; full: boolean; transform: Transform }) {
  switch (block.kind) {
    case 'table':
      return <Table block={block} full={full} />;
    case 'chart':
      return <Chart block={block} full={full} transform={transform} />;
    case 'stats':
      return <Stats block={block} />;
    case 'text':
      return <Text block={block} full={full} />;
  }
}
