import { getRuntimeSourceState } from '/home/ubuntu/src/b1dz.com/packages/core/src/runtime-cache.ts';
const state = await getRuntimeSourceState<any>('a64d17db-6812-48ca-a7e3-59a5a913c34d', 'crypto-trade');
const trades = state?.tradeState?.closedTrades ?? [];
console.log('total closedTrades:', trades.length);
if (trades.length > 0) {
  const sorted = [...trades].sort((a: any, b: any) => b.exitTime - a.exitTime);
  console.log('most recent:', new Date(sorted[0].exitTime).toISOString(), sorted[0].pair, sorted[0].exchange, 'net:', sorted[0].netPnl);
  console.log('oldest:', new Date(sorted[sorted.length-1].exitTime).toISOString());
  const total = trades.reduce((s: number, t: any) => s + t.netPnl, 0);
  console.log('total net PnL:', total.toFixed(4));
} else {
  console.log('raw state keys:', state ? Object.keys(state) : 'null');
}
