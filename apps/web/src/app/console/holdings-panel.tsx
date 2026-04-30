'use client';

import { formatUsdPrice, fmtAmount, parseBalances, buildPriceOf, KRAKEN_NAME_MAP, STABLECOINS } from './format';
import type { ArbState } from '@/lib/source-state-types';

interface Props {
  arb: ArbState | null;
}

const DUST = 1.0;

export function HoldingsPanel({ arb }: Props) {
  const priceOf = buildPriceOf(arb?.prices);

  const krakenHoldings = parseBalances(arb?.krakenBalance, priceOf, KRAKEN_NAME_MAP);
  const binanceHoldings = parseBalances(arb?.binanceBalance, priceOf);
  const coinbaseHoldings = parseBalances(arb?.coinbaseBalance, priceOf);
  const geminiHoldings = parseBalances(arb?.geminiBalance, priceOf);

  const binanceDetailed = (arb?.binanceDetailedBalance ?? []).map((b) => {
    const free = parseFloat(b.free);
    const locked = parseFloat(b.locked);
    const isStable = STABLECOINS.has(b.asset);
    const unit = isStable ? 1 : (priceOf[b.asset] ?? 0);
    return {
      asset: b.asset,
      free: Number.isFinite(free) ? free : 0,
      locked: Number.isFinite(locked) ? locked : 0,
      isStable,
      unit,
      usdValue: (Number.isFinite(free) ? free : 0) * unit,
      lockedUsd: (Number.isFinite(locked) ? locked : 0) * unit,
    };
  }).filter((r) => r.isStable || r.usdValue >= DUST || r.lockedUsd >= DUST)
    .sort((a, b) => b.usdValue - a.usdValue);

  const sumValue = (h: { usdValue: number }[]) => h.reduce((s, x) => s + x.usdValue, 0);

  const exchangeSummaries = [
    { key: 'kraken', label: 'Kraken', color: 'text-cyan-400', value: sumValue(krakenHoldings) },
    { key: 'binance', label: 'Binance', color: 'text-yellow-400', value: sumValue(binanceDetailed.length ? binanceDetailed : binanceHoldings) },
    { key: 'coinbase', label: 'Coinbase', color: 'text-fuchsia-400', value: sumValue(coinbaseHoldings) },
    { key: 'gemini', label: 'Gemini', color: 'text-blue-400', value: sumValue(geminiHoldings) },
  ];

  const totalValue = exchangeSummaries.reduce((s, x) => s + x.value, 0);
  const errors = arb?.exchangeErrors ?? {};

  const showByDust = (h: { isStable: boolean; usdValue: number }) => h.isStable || h.usdValue >= DUST;
  const byUsdDesc = (a: { usdValue: number }, b: { usdValue: number }) => b.usdValue - a.usdValue;

  return (
    <section className="rounded-xl border border-zinc-800 bg-zinc-900/80">
      <header className="flex items-center justify-between border-b border-zinc-800 px-4 py-2">
        <span className="text-xs font-semibold uppercase tracking-wider text-zinc-400">Holdings</span>
        <span className="font-mono text-xs text-zinc-300">total: <span className="text-zinc-100">${totalValue.toFixed(2)}</span></span>
      </header>
      <div className="grid grid-cols-2 gap-2 border-b border-zinc-800 p-3 sm:grid-cols-4">
        {exchangeSummaries.map(({ key, label, color, value }) => {
          const err = errors[key];
          return (
            <div key={key} className="rounded-lg border border-zinc-800 bg-zinc-950/60 px-3 py-2">
              <div className={`text-[10px] font-semibold uppercase tracking-wider ${color}`}>{label}</div>
              <div className="mt-1 font-mono text-sm text-zinc-100">${value.toFixed(2)}</div>
              {err && (
                <div className="mt-1 flex items-center gap-1">
                  <span className="inline-block h-1.5 w-1.5 rounded-full bg-red-500" />
                  <span className="truncate text-[10px] text-red-400" title={err}>{err}</span>
                </div>
              )}
            </div>
          );
        })}
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-left font-mono text-xs">
          <thead className="text-zinc-500">
            <tr>
              <th className="px-3 py-2">Exch</th>
              <th className="px-3 py-2">Asset</th>
              <th className="px-3 py-2 text-right">Free</th>
              <th className="px-3 py-2 text-right">USD</th>
              <th className="px-3 py-2 text-right">Locked</th>
              <th className="px-3 py-2 text-right">Locked USD</th>
            </tr>
          </thead>
          <tbody>
            {binanceDetailed.map((r) => (
              <Row
                key={`bnd-${r.asset}`}
                exchange="binance-us"
                color="text-yellow-400"
                asset={r.asset}
                free={r.free}
                freeUsd={r.usdValue}
                isStable={r.isStable}
                locked={r.locked}
                lockedUsd={r.lockedUsd}
                unitPrice={r.unit}
              />
            ))}
            {!binanceDetailed.length && binanceHoldings.filter(showByDust).sort(byUsdDesc).map((h) => (
              <Row
                key={`bn-${h.asset}`}
                exchange="binance-us"
                color="text-yellow-400"
                asset={h.asset}
                free={h.amount}
                freeUsd={h.usdValue}
                isStable={h.isStable}
                unitPrice={h.unitPrice}
              />
            ))}
            {krakenHoldings.filter(showByDust).sort(byUsdDesc).map((h) => (
              <Row
                key={`kr-${h.asset}`}
                exchange="kraken"
                color="text-cyan-400"
                asset={h.asset}
                free={h.amount}
                freeUsd={h.usdValue}
                isStable={h.isStable}
                unitPrice={h.unitPrice}
              />
            ))}
            {coinbaseHoldings.filter(showByDust).sort(byUsdDesc).map((h) => (
              <Row
                key={`cb-${h.asset}`}
                exchange="coinbase"
                color="text-fuchsia-400"
                asset={h.asset}
                free={h.amount}
                freeUsd={h.usdValue}
                isStable={h.isStable}
                unitPrice={h.unitPrice}
              />
            ))}
            {geminiHoldings.filter(showByDust).sort(byUsdDesc).map((h) => (
              <Row
                key={`gm-${h.asset}`}
                exchange="gemini"
                color="text-blue-400"
                asset={h.asset}
                free={h.amount}
                freeUsd={h.usdValue}
                isStable={h.isStable}
                unitPrice={h.unitPrice}
              />
            ))}
            {arb?.binanceOpenOrders?.map((o) => {
              const remaining = parseFloat(o.origQty) - parseFloat(o.executedQty);
              const price = parseFloat(o.price);
              const notional = (Number.isFinite(remaining) ? remaining : 0) * (Number.isFinite(price) ? price : 0);
              return (
                <tr key={`oo-${o.orderId}`} className="border-t border-zinc-800/60">
                  <td className="px-3 py-1.5 text-yellow-400">binance-us</td>
                  <td className="px-3 py-1.5 text-zinc-200">{o.symbol} {o.side} {o.type}</td>
                  <td className="px-3 py-1.5 text-right text-zinc-300">{o.origQty}</td>
                  <td className="px-3 py-1.5 text-right text-zinc-300">@ ${o.price}</td>
                  <td className="px-3 py-1.5 text-right text-zinc-400">{o.status}</td>
                  <td className="px-3 py-1.5 text-right text-zinc-400">${notional.toFixed(2)}</td>
                </tr>
              );
            })}
            {totalValue === 0 && (
              <tr>
                <td colSpan={6} className="px-3 py-3 text-zinc-500">
                  No holdings (or waiting for daemon — 60s cadence)
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function Row(props: {
  exchange: string;
  color: string;
  asset: string;
  free: number;
  freeUsd: number;
  isStable: boolean;
  unitPrice: number;
  locked?: number;
  lockedUsd?: number;
}) {
  const { exchange, color, asset, free, freeUsd, isStable, unitPrice, locked, lockedUsd } = props;
  return (
    <tr className="border-t border-zinc-800/60">
      <td className={`px-3 py-1.5 ${color}`}>{exchange}</td>
      <td className="px-3 py-1.5 text-zinc-200">
        {asset}
        {!isStable && unitPrice > 0 && (
          <span className="ml-2 text-zinc-500">@ ${formatUsdPrice(unitPrice)}</span>
        )}
      </td>
      <td className="px-3 py-1.5 text-right text-zinc-300">{fmtAmount(free)}</td>
      <td className="px-3 py-1.5 text-right text-zinc-300">{isStable ? `$${free.toFixed(2)}` : `$${freeUsd.toFixed(2)}`}</td>
      <td className="px-3 py-1.5 text-right text-zinc-400">{locked && locked > 0 ? fmtAmount(locked) : '-'}</td>
      <td className="px-3 py-1.5 text-right text-zinc-400">{lockedUsd && lockedUsd > 0 ? `$${lockedUsd.toFixed(2)}` : '-'}</td>
    </tr>
  );
}
