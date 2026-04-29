/**
 * Pure formatters used across /console panels — mirrors the helpers
 * in apps/cli/src/tui/crypto-dashboard.tsx (formatUsdPrice etc.) so
 * the web view renders the same prices as the TUI.
 */

export function formatUsdPrice(value: number): string {
  if (!Number.isFinite(value)) return '-';
  const abs = Math.abs(value);
  if (abs >= 1000) return value.toFixed(2);
  if (abs >= 100) return value.toFixed(3);
  if (abs >= 10) return value.toFixed(4);
  if (abs >= 1) return value.toFixed(4);
  if (abs >= 0.1) return value.toFixed(5);
  if (abs >= 0.01) return value.toFixed(6);
  if (abs >= 0.001) return value.toFixed(7);
  if (abs >= 0.0001) return value.toFixed(8);
  return value.toFixed(10);
}

export function fmtAmount(n: number): string {
  if (n === 0) return '0';
  if (Math.abs(n) >= 1) return n.toFixed(4);
  return n.toFixed(8).replace(/0+$/, '').replace(/\.$/, '');
}

export function timeSince(epochSec: number): string {
  const sec = Math.floor((Date.now() / 1000) - epochSec);
  if (sec < 60) return `${sec}s ago`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
  return `${Math.floor(sec / 3600)}h ago`;
}

export function formatLogTs(isoLike: string): string {
  try {
    const d = new Date(isoLike);
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    const hh = String(d.getHours()).padStart(2, '0');
    const min = String(d.getMinutes()).padStart(2, '0');
    const ss = String(d.getSeconds()).padStart(2, '0');
    return `${mm}-${dd} ${hh}:${min}:${ss}`;
  } catch {
    return '??-?? ??:??:??';
  }
}

export const STABLECOINS = new Set(['USD', 'USDC', 'USDT']);

export const KRAKEN_NAME_MAP: Record<string, string> = {
  ZUSD: 'USD', XXBT: 'BTC', XETH: 'ETH', XXDG: 'DOGE',
  XZEC: 'ZEC', XXRP: 'XRP', XXLM: 'XLM', XXMR: 'XMR',
  XLTC: 'LTC', XADA: 'ADA', XSOL: 'SOL',
};

export function parseBalances(
  bal: Record<string, string> | undefined,
  priceOf: Record<string, number>,
  nameMap?: Record<string, string>,
): { asset: string; amount: number; isStable: boolean; unitPrice: number; usdValue: number }[] {
  if (!bal) return [];
  const holdings: { asset: string; amount: number; isStable: boolean; unitPrice: number; usdValue: number }[] = [];
  for (const [k, v] of Object.entries(bal)) {
    const name = nameMap?.[k] ?? k;
    const val = parseFloat(v);
    if (!Number.isFinite(val) || val < 0.0001) continue;
    const isStable = STABLECOINS.has(name);
    const unitPrice = isStable ? 1 : (priceOf[name] ?? 0);
    const usdValue = val * unitPrice;
    holdings.push({ asset: name, amount: val, isStable, unitPrice, usdValue });
  }
  return holdings;
}

export function buildPriceOf(prices: { exchange: string; pair: string; bid: number }[] | undefined): Record<string, number> {
  const priceOf: Record<string, number> = {};
  if (!prices) return priceOf;
  for (const p of prices) {
    if (p.bid > 0) {
      const base = p.pair.split('-')[0];
      if (!priceOf[base]) priceOf[base] = p.bid;
    }
  }
  return priceOf;
}
