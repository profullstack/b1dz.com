export function DashboardMock(): JSX.Element {
  return (
    <div className="bg-zinc-950 rounded-xl border border-zinc-800 overflow-hidden shadow-2xl">
      {/* Nav */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-zinc-800 bg-zinc-900/50">
        <div className="flex items-center gap-2">
          <div className="w-6 h-6 rounded bg-gradient-to-br from-orange-400 to-amber-500" />
          <span className="font-bold text-sm bg-gradient-to-r from-orange-400 to-amber-500 bg-clip-text text-transparent">b1dz</span>
        </div>
        <div className="text-xs text-zinc-500">anthony@example.com</div>
      </div>

      <div className="p-4 space-y-4">
        {/* Stats row */}
        <div className="grid grid-cols-4 gap-3">
          <StatCard label="Portfolio" value="$292.64" change="+1.2%" positive />
          <StatCard label="Today P/L" value="+$0.45" change="3 trades" positive />
          <StatCard label="Open Positions" value="1" change="FARTCOIN" />
          <StatCard label="Arb Spread" value="0.16%" change="ETH-USD" />
        </div>

        {/* Charts area */}
        <div className="grid grid-cols-3 gap-3">
          <div className="col-span-2 bg-zinc-900 rounded-lg border border-zinc-800 p-3">
            <div className="text-xs text-zinc-400 mb-2 font-medium">Portfolio Value (24h)</div>
            <div className="h-32 flex items-end gap-0.5">
              {[40, 42, 38, 45, 43, 48, 50, 47, 52, 55, 53, 58, 56, 60, 62, 58, 64, 67, 65, 70, 68, 72, 75, 73].map((h, i) => (
                <div key={i} className="flex-1 bg-gradient-to-t from-orange-500/60 to-amber-500/30 rounded-t-sm" style={{ height: `${h}%` }} />
              ))}
            </div>
          </div>
          <div className="bg-zinc-900 rounded-lg border border-zinc-800 p-3">
            <div className="text-xs text-zinc-400 mb-2 font-medium">Exchange Balances</div>
            <div className="space-y-2">
              <BalanceRow exchange="Kraken" amount="$99.34" pct={34} color="from-cyan-500 to-cyan-400" />
              <BalanceRow exchange="Binance" amount="$96.30" pct={33} color="from-yellow-500 to-yellow-400" />
              <BalanceRow exchange="Coinbase" amount="$97.00" pct={33} color="from-purple-500 to-purple-400" />
            </div>
          </div>
        </div>

        {/* Prices table */}
        <div className="bg-zinc-900 rounded-lg border border-zinc-800 p-3">
          <div className="text-xs text-zinc-400 mb-2 font-medium">Live Prices</div>
          <table className="w-full text-xs">
            <thead>
              <tr className="text-zinc-500">
                <th className="text-left pb-1">Pair</th>
                <th className="text-right pb-1">Kraken</th>
                <th className="text-right pb-1">Coinbase</th>
                <th className="text-right pb-1">Binance</th>
                <th className="text-right pb-1">Spread</th>
              </tr>
            </thead>
            <tbody className="text-zinc-200">
              <PriceRow pair="BTC-USD" kraken="73,462.10" coinbase="73,466.00" binance="73,447.00" spread="0.03%" />
              <PriceRow pair="ETH-USD" kraken="2,305.23" coinbase="2,306.13" binance="2,304.80" spread="0.06%" />
              <PriceRow pair="SOL-USD" kraken="85.52" coinbase="85.55" binance="85.48" spread="0.08%" />
              <PriceRow pair="FARTCOIN" kraken="0.2048" coinbase="0.2052" binance="-" spread="0.20%" />
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

function StatCard({ label, value, change, positive }: { label: string; value: string; change: string; positive?: boolean }): JSX.Element {
  return (
    <div className="bg-zinc-900 rounded-lg border border-zinc-800 p-3">
      <div className="text-[10px] text-zinc-500 uppercase tracking-wide">{label}</div>
      <div className="text-lg font-bold mt-0.5">{value}</div>
      <div className={`text-[10px] mt-0.5 ${positive ? 'text-green-400' : 'text-zinc-400'}`}>{change}</div>
    </div>
  );
}

function BalanceRow({ exchange, amount, pct, color }: { exchange: string; amount: string; pct: number; color: string }): JSX.Element {
  return (
    <div>
      <div className="flex justify-between text-[11px] mb-0.5">
        <span className="text-zinc-400">{exchange}</span>
        <span className="text-white">{amount}</span>
      </div>
      <div className="h-1.5 bg-zinc-800 rounded-full overflow-hidden">
        <div className={`h-full bg-gradient-to-r ${color} rounded-full`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

function PriceRow({ pair, kraken, coinbase, binance, spread }: { pair: string; kraken: string; coinbase: string; binance: string; spread: string }): JSX.Element {
  return (
    <tr className="border-t border-zinc-800/50">
      <td className="py-1 font-medium">{pair}</td>
      <td className="py-1 text-right">${kraken}</td>
      <td className="py-1 text-right">${coinbase}</td>
      <td className="py-1 text-right">{binance === '-' ? '-' : `$${binance}`}</td>
      <td className="py-1 text-right text-orange-400">{spread}</td>
    </tr>
  );
}
