'use client';

import { useMemo, useState } from 'react';
import {
  buildDefinition,
  builderStateFromDefinition,
  defaultBuilderState,
  slugify,
  TEMPLATE_PARAM_DEFAULTS,
  type BuilderState,
  type AssetClass,
  type ComparisonRow,
  type IndicatorFn,
  type RuleRow,
  type TemplateName,
} from '@/lib/tsp-builder';
import { fmtReturnPct, fmtWinRate } from '@/lib/strategy-backtest-display';
import type { BacktestResponse } from '@/lib/strategy-backtest-runner';

const INDICATOR_FNS: IndicatorFn[] = ['rsi', 'ema', 'sma', 'macdHist'];
const COMPARATORS = ['gt', 'gte', 'lt', 'lte', 'eq', 'neq'] as const;
const COMPARATOR_LABELS: Record<(typeof COMPARATORS)[number], string> = {
  gt: '>', gte: '≥', lt: '<', lte: '≤', eq: '=', neq: '≠',
};
const TEMPLATES: TemplateName[] = ['mean-reversion', 'breakout', 'trend-continuation'];

const inputCls = 'w-full rounded-md border border-zinc-700 bg-zinc-950 px-2.5 py-1.5 text-sm text-zinc-100 focus:border-orange-500/50 focus:outline-none';
const labelCls = 'block text-xs uppercase tracking-wider text-zinc-500 mb-1';
const btnGhost = 'rounded-md border border-zinc-700 px-2 py-1 text-xs text-zinc-300 hover:border-orange-500/40 hover:text-zinc-100 transition';

interface Knobs {
  risk: number;
  horizon: number;
  frequency: number;
  assetFocus: number;
}

const KNOBS: { key: keyof Knobs; label: string; low: string; high: string }[] = [
  { key: 'risk', label: 'Risk / aggressiveness', low: 'conservative', high: 'extreme' },
  { key: 'horizon', label: 'Time horizon', low: 'scalp', high: 'long-term' },
  { key: 'frequency', label: 'Trade frequency', low: 'rare', high: 'constant' },
  { key: 'assetFocus', label: 'Asset focus', low: 'equities', high: 'crypto' },
];

export function StrategyBuilder() {
  const [state, setState] = useState<BuilderState>(defaultBuilderState);
  const [bankroll, setBankroll] = useState(1000);
  const [timeframe, setTimeframe] = useState('1 year');
  const [classes, setClasses] = useState<AssetClass[]>(['crypto', 'equity']);
  const [result, setResult] = useState<BacktestResponse & { strategy?: { name: string } } | null>(null);
  const [errors, setErrors] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);

  // AI assist
  const [niches, setNiches] = useState('');
  const [goal, setGoal] = useState('');
  const [knobs, setKnobs] = useState<Knobs>({ risk: 5, horizon: 5, frequency: 5, assetFocus: 5 });
  const [aiLoading, setAiLoading] = useState(false);
  const [aiError, setAiError] = useState('');
  const [aiNote, setAiNote] = useState('');

  const doc = useMemo(() => buildDefinition(state), [state]);

  async function generateWithAI() {
    setAiLoading(true);
    setAiError('');
    try {
      const res = await fetch('/api/strategies/generate', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ niches, goal, knobs }),
      });
      const body = await res.json();
      if (!res.ok) {
        setAiError(body.error ?? `request failed (${res.status})`);
        return;
      }
      setState(builderStateFromDefinition(body.definition));
      setAiNote(body.description ?? '');
      setResult(null);
    } catch (e) {
      setAiError((e as Error).message);
    } finally {
      setAiLoading(false);
    }
  }

  function patch(p: Partial<BuilderState>) {
    setState((s) => ({ ...s, ...p }));
  }

  async function runBacktest() {
    setLoading(true);
    setErrors([]);
    setResult(null);
    try {
      const res = await fetch('/api/strategies/backtest', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ definition: doc, classes, bankroll, timeframe }),
      });
      const body = await res.json();
      if (!res.ok) {
        setErrors(body.details ?? [body.error ?? `request failed (${res.status})`]);
        return;
      }
      setResult(body);
    } catch (e) {
      setErrors([(e as Error).message]);
    } finally {
      setLoading(false);
    }
  }

  return (
    <section className="max-w-6xl mx-auto px-6 pb-20 grid lg:grid-cols-2 gap-6">
      {/* ── left: the form ── */}
      <div className="space-y-6">
        <Card title="✨ Start with AI (optional)">
          <p className="text-xs text-zinc-400 -mt-1 mb-1">Answer a couple of questions, set the knobs, and let AI draft a strategy you can then tweak below.</p>
          <div className="grid sm:grid-cols-2 gap-3">
            <div>
              <label className={labelCls}>Niche(s) / themes</label>
              <input className={inputCls} value={niches} placeholder="AI, semiconductors, BTC" onChange={(e) => setNiches(e.target.value)} />
            </div>
            <div>
              <label className={labelCls}>Investment goal</label>
              <input className={inputCls} value={goal} placeholder="steady growth, income, momentum…" onChange={(e) => setGoal(e.target.value)} />
            </div>
          </div>
          <div className="grid sm:grid-cols-2 gap-x-5 gap-y-3 mt-1">
            {KNOBS.map((k) => (
              <Slider
                key={k.key}
                label={k.label}
                low={k.low}
                high={k.high}
                value={knobs[k.key]}
                onChange={(v) => setKnobs((s) => ({ ...s, [k.key]: v }))}
              />
            ))}
          </div>
          <div className="flex items-center gap-3 pt-1">
            <button
              onClick={generateWithAI}
              disabled={aiLoading}
              className="rounded-lg bg-gradient-to-r from-violet-500 to-fuchsia-500 hover:from-violet-400 hover:to-fuchsia-400 disabled:opacity-50 text-white font-medium px-4 py-2 text-sm transition"
            >
              {aiLoading ? 'Generating…' : '✨ Generate with AI'}
            </button>
            <span className="text-[11px] text-zinc-500">Tweak the knobs and regenerate anytime.</span>
          </div>
          {aiError && <div className="rounded-md border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-300">{aiError}</div>}
          {aiNote && <div className="rounded-md border border-violet-500/30 bg-violet-500/10 px-3 py-2 text-xs text-violet-200">{aiNote}</div>}
        </Card>

        <Card title="1 · Strategy details">
          <div className="grid sm:grid-cols-2 gap-3">
            <div>
              <label className={labelCls}>Name</label>
              <input className={inputCls} value={state.name} placeholder="My RSI Dip Buyer" onChange={(e) => patch({ name: e.target.value })} />
            </div>
            <div>
              <label className={labelCls}>ID (slug)</label>
              <input className={inputCls} value={state.id || slugify(state.name)} onChange={(e) => patch({ id: e.target.value })} />
            </div>
          </div>
          <div>
            <label className={labelCls}>Description</label>
            <input className={inputCls} value={state.description} placeholder="Buy deep dips, sell the bounce." onChange={(e) => patch({ description: e.target.value })} />
          </div>
          <div>
            <label className={labelCls}>Intended asset classes</label>
            <div className="flex gap-4">
              {(['crypto', 'equity'] as AssetClass[]).map((c) => (
                <label key={c} className="flex items-center gap-2 text-sm text-zinc-300">
                  <input
                    type="checkbox"
                    checked={state.assetClasses.includes(c)}
                    onChange={(e) =>
                      patch({ assetClasses: e.target.checked ? [...state.assetClasses, c] : state.assetClasses.filter((x) => x !== c) })
                    }
                  />
                  {c === 'crypto' ? 'Crypto' : 'Equities'}
                </label>
              ))}
            </div>
          </div>
        </Card>

        <Card title="2 · Logic">
          <div className="flex gap-2 mb-4">
            {(['template', 'rules'] as const).map((m) => (
              <button
                key={m}
                onClick={() => patch({ mode: m })}
                className={`rounded-md px-3 py-1.5 text-sm transition ${state.mode === m ? 'bg-orange-500/20 text-orange-300 border border-orange-500/40' : 'border border-zinc-700 text-zinc-400 hover:text-zinc-200'}`}
              >
                {m === 'template' ? 'Template (presets)' : 'Rules (build it)'}
              </button>
            ))}
          </div>
          {state.mode === 'template' ? <TemplateEditor state={state} patch={patch} /> : <RulesEditor state={state} setState={setState} />}
        </Card>
      </div>

      {/* ── right: preview + backtest ── */}
      <div className="space-y-6">
        <Card title="TSP document">
          <pre className="max-h-72 overflow-auto rounded-md bg-zinc-950 border border-zinc-800 p-3 text-xs leading-relaxed text-zinc-300 font-mono">
            {JSON.stringify(doc, null, 2)}
          </pre>
        </Card>

        <Card title="3 · Backtest">
          <div className="flex flex-wrap items-end gap-4 mb-4">
            <div>
              <label className={labelCls}>Bankroll ($)</label>
              <input type="number" min={1} className={`${inputCls} w-28`} value={bankroll} onChange={(e) => setBankroll(Math.max(1, Number(e.target.value) || 1))} />
            </div>
            <div>
              <label className={labelCls}>Time frame</label>
              <select className={`${inputCls} w-28`} value={timeframe} onChange={(e) => setTimeframe(e.target.value)}>
                {['1 month', '3 months', '6 months', '1 year', '2 years', '5 years'].map((t) => (
                  <option key={t} value={t}>{t}</option>
                ))}
              </select>
            </div>
            <div>
              <label className={labelCls}>Test against</label>
              <div className="flex gap-3 h-[34px] items-center">
                {(['crypto', 'equity'] as AssetClass[]).map((c) => (
                  <label key={c} className="flex items-center gap-1.5 text-sm text-zinc-300">
                    <input
                      type="checkbox"
                      checked={classes.includes(c)}
                      onChange={(e) => setClasses(e.target.checked ? [...classes, c] : classes.filter((x) => x !== c))}
                    />
                    {c === 'crypto' ? 'Crypto' : 'Equities'}
                  </label>
                ))}
              </div>
            </div>
            <button
              onClick={runBacktest}
              disabled={loading || classes.length === 0}
              className="ml-auto rounded-lg bg-gradient-to-r from-orange-500 to-amber-500 hover:from-orange-400 hover:to-amber-400 disabled:opacity-50 text-black font-medium px-4 py-2 text-sm transition"
            >
              {loading ? 'Running…' : 'Run backtest'}
            </button>
          </div>

          {errors.length > 0 && (
            <div className="rounded-md border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-300">
              <div className="font-semibold mb-1">Could not run:</div>
              <ul className="list-disc list-inside space-y-0.5">{errors.map((e, i) => <li key={i}>{e}</li>)}</ul>
            </div>
          )}

          {result && <Results result={result} />}
        </Card>

        <div className="flex items-center justify-between rounded-xl border border-zinc-800 bg-zinc-900 px-5 py-4">
          <div className="text-sm text-zinc-400">Happy with it? Publishing to the store is coming soon.</div>
          <button disabled className="rounded-lg border border-zinc-700 px-4 py-2 text-sm text-zinc-500 cursor-not-allowed" title="Publishing lands in the next release">
            Publish (soon)
          </button>
        </div>
      </div>
    </section>
  );
}

function Slider({ label, low, high, value, onChange }: { label: string; low: string; high: string; value: number; onChange: (v: number) => void }) {
  return (
    <div>
      <div className="flex items-baseline justify-between mb-1">
        <span className="text-xs text-zinc-300">{label}</span>
        <span className="text-xs font-mono text-violet-300">{value}/10</span>
      </div>
      <input
        type="range"
        min={1}
        max={10}
        step={1}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="w-full accent-violet-500"
      />
      <div className="flex justify-between text-[10px] text-zinc-600">
        <span>{low}</span>
        <span>{high}</span>
      </div>
    </div>
  );
}

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-900 p-5 space-y-3">
      <h3 className="text-sm font-semibold text-zinc-200">{title}</h3>
      {children}
    </div>
  );
}

function TemplateEditor({ state, patch }: { state: BuilderState; patch: (p: Partial<BuilderState>) => void }) {
  const { template, params } = state.template;
  return (
    <div className="space-y-3">
      <div>
        <label className={labelCls}>Template</label>
        <select
          className={inputCls}
          value={template}
          onChange={(e) => {
            const t = e.target.value as TemplateName;
            patch({ template: { template: t, params: { ...TEMPLATE_PARAM_DEFAULTS[t] } } });
          }}
        >
          {TEMPLATES.map((t) => <option key={t} value={t}>{t}</option>)}
        </select>
      </div>
      <div className="grid grid-cols-3 gap-3">
        {Object.entries(params).map(([k, v]) => (
          <div key={k}>
            <label className={labelCls}>{k}</label>
            <input
              type="number"
              className={inputCls}
              value={v}
              onChange={(e) => patch({ template: { template, params: { ...params, [k]: Number(e.target.value) } } })}
            />
          </div>
        ))}
      </div>
    </div>
  );
}

function RulesEditor({ state, setState }: { state: BuilderState; setState: React.Dispatch<React.SetStateAction<BuilderState>> }) {
  const { indicators, rules } = state.rules;
  const setRules = (r: Partial<BuilderState['rules']>) => setState((s) => ({ ...s, rules: { ...s.rules, ...r } }));

  return (
    <div className="space-y-4">
      <div>
        <div className="flex items-center justify-between mb-2">
          <span className={labelCls}>Indicators</span>
          <button className={btnGhost} onClick={() => setRules({ indicators: [...indicators, { name: `ind${indicators.length + 1}`, fn: 'ema', period: 20 }] })}>+ indicator</button>
        </div>
        <div className="space-y-2">
          {indicators.map((ind, i) => (
            <div key={i} className="flex items-center gap-2">
              <input className={`${inputCls} flex-1`} value={ind.name} placeholder="name" onChange={(e) => setRules({ indicators: indicators.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)) })} />
              <select className={`${inputCls} w-28`} value={ind.fn} onChange={(e) => setRules({ indicators: indicators.map((x, j) => (j === i ? { ...x, fn: e.target.value as IndicatorFn } : x)) })}>
                {INDICATOR_FNS.map((f) => <option key={f} value={f}>{f}</option>)}
              </select>
              <input type="number" className={`${inputCls} w-20`} value={ind.period} disabled={ind.fn === 'macdHist'} onChange={(e) => setRules({ indicators: indicators.map((x, j) => (j === i ? { ...x, period: Number(e.target.value) } : x)) })} />
              <button className={btnGhost} onClick={() => setRules({ indicators: indicators.filter((_, j) => j !== i) })}>✕</button>
            </div>
          ))}
        </div>
        <p className="mt-1 text-[11px] text-zinc-600">Operands: a number, <code className="text-zinc-400">price</code>, or an indicator name above.</p>
      </div>

      <div>
        <div className="flex items-center justify-between mb-2">
          <span className={labelCls}>Rules (first match wins)</span>
          <button className={btnGhost} onClick={() => setRules({ rules: [...rules, { conditions: [{ left: 'price', op: 'gt', right: '0' }], side: 'buy', strength: 1, reason: '' }] })}>+ rule</button>
        </div>
        <div className="space-y-3">
          {rules.map((rule, ri) => (
            <RuleCard
              key={ri}
              rule={rule}
              onChange={(r) => setRules({ rules: rules.map((x, j) => (j === ri ? r : x)) })}
              onRemove={() => setRules({ rules: rules.filter((_, j) => j !== ri) })}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

function RuleCard({ rule, onChange, onRemove }: { rule: RuleRow; onChange: (r: RuleRow) => void; onRemove: () => void }) {
  const setCond = (i: number, c: ComparisonRow) => onChange({ ...rule, conditions: rule.conditions.map((x, j) => (j === i ? c : x)) });
  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-950/60 p-3 space-y-2">
      <div className="flex items-center justify-between">
        <span className="text-[11px] uppercase tracking-wider text-zinc-500">When (all of)</span>
        <button className={btnGhost} onClick={onRemove}>remove rule</button>
      </div>
      {rule.conditions.map((c, ci) => (
        <div key={ci} className="flex items-center gap-2">
          <input className={`${inputCls} flex-1`} value={c.left} placeholder="rsi14 / price / number" onChange={(e) => setCond(ci, { ...c, left: e.target.value })} />
          <select className={`${inputCls} w-16`} value={c.op} onChange={(e) => setCond(ci, { ...c, op: e.target.value as ComparisonRow['op'] })}>
            {COMPARATORS.map((o) => <option key={o} value={o}>{COMPARATOR_LABELS[o]}</option>)}
          </select>
          <input className={`${inputCls} flex-1`} value={c.right} placeholder="30 / ema50 / price" onChange={(e) => setCond(ci, { ...c, right: e.target.value })} />
          <button className={btnGhost} onClick={() => onChange({ ...rule, conditions: rule.conditions.filter((_, j) => j !== ci) })}>✕</button>
        </div>
      ))}
      <button className={btnGhost} onClick={() => onChange({ ...rule, conditions: [...rule.conditions, { left: 'price', op: 'gt', right: '0' }] })}>+ condition</button>
      <div className="flex items-center gap-2 pt-1">
        <span className="text-[11px] uppercase tracking-wider text-zinc-500">→ signal</span>
        <select className={`${inputCls} w-20`} value={rule.side} onChange={(e) => onChange({ ...rule, side: e.target.value as RuleRow['side'] })}>
          <option value="buy">buy</option>
          <option value="sell">sell</option>
        </select>
        <input type="number" step={0.1} min={0} max={1} className={`${inputCls} w-20`} value={rule.strength} onChange={(e) => onChange({ ...rule, strength: Math.max(0, Math.min(1, Number(e.target.value))) })} title="strength 0–1" />
        <input className={`${inputCls} flex-1`} value={rule.reason} placeholder="reason (optional)" onChange={(e) => onChange({ ...rule, reason: e.target.value })} />
      </div>
    </div>
  );
}

function money(n: number): string {
  return `${n < 0 ? '-' : ''}$${Math.abs(n).toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
}

function Results({ result }: { result: BacktestResponse & { strategy?: { name: string } } }) {
  return (
    <div className="space-y-3">
      <div className="text-[11px] text-zinc-500">
        {money(result.bankroll)} bankroll · {result.timeframe} ({result.startYmd} → {result.endYmd})
      </div>
      {result.verdict && (
        <div className="rounded-md border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-sm text-emerald-200">
          Better fit for <span className="font-semibold capitalize">{result.verdict.winner === 'equity' ? 'equities' : 'crypto'}</span>
          {' · '}
          {result.verdict.classes.map((c) => `${c.assetClass === 'equity' ? 'equities' : 'crypto'} ${fmtReturnPct(c.returnPct)}`).join('  vs  ')}
        </div>
      )}
      <div className="grid gap-3">
        {result.classes.map((cls) => {
          const noData = cls.symbols.length === 0;
          return (
            <div key={cls.assetClass} className="rounded-lg border border-zinc-800 bg-zinc-950/50 px-3 py-2.5">
              <div className="flex items-baseline justify-between mb-1.5">
                <span className="text-sm font-semibold text-zinc-200 capitalize">{cls.assetClass === 'equity' ? 'Equities' : 'Crypto'}</span>
                <span className="text-[11px] text-zinc-500">{noData ? 'no price data' : cls.symbols.join(', ')}</span>
              </div>
              {noData ? (
                <div className="text-[11px] text-zinc-600">Couldn&apos;t load price data for this basket — try again in a moment.</div>
              ) : cls.trades === 0 ? (
                <div className="text-[11px] text-zinc-600">No trades fired in this time frame.</div>
              ) : (
                <div className="grid grid-cols-4 gap-2 text-center">
                  <Stat label="Return" value={fmtReturnPct(cls.returnPct)} cls={cls.returnPct >= 0 ? 'text-emerald-400' : 'text-rose-400'} />
                  <Stat label="Final" value={money(cls.finalEquity)} cls="text-zinc-200" />
                  <Stat label="Win rate" value={fmtWinRate(cls.winRate)} cls="text-zinc-300" />
                  <Stat label="Trades" value={String(cls.trades)} cls="text-zinc-400" />
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function Stat({ label, value, cls }: { label: string; value: string; cls: string }) {
  return (
    <div>
      <div className={`text-sm font-mono ${cls}`}>{value}</div>
      <div className="text-[10px] uppercase tracking-wider text-zinc-600">{label}</div>
    </div>
  );
}
