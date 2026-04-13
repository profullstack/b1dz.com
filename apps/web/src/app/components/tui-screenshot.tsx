export function TuiScreenshot(): JSX.Element {
  return (
    <div className="bg-black rounded-xl border border-zinc-700 p-1 font-mono text-[11px] leading-tight overflow-hidden shadow-2xl">
      {/* Title bar */}
      <div className="flex items-center gap-2 px-3 py-1.5 border-b border-zinc-800">
        <div className="flex gap-1.5">
          <div className="w-3 h-3 rounded-full bg-red-500" />
          <div className="w-3 h-3 rounded-full bg-yellow-500" />
          <div className="w-3 h-3 rounded-full bg-green-500" />
        </div>
        <span className="text-zinc-400 text-xs ml-2">b1dz tui — crypto trading terminal</span>
      </div>
      {/* Status bar */}
      <div className="bg-blue-700 text-white px-2 py-0.5">
        b1dz crypto <span className="text-green-400">●</span> FARTCOIN-USD  realized:<span className="text-green-400">+$0.45</span>  fees:$1.04  [t]rade [q]uit
      </div>
      {/* Positions */}
      <div className="border border-zinc-700 m-1 p-1">
        <div className="text-zinc-500 text-[10px]">─ Positions ─</div>
        <div>FARTCOINUSD    <span className="text-white">495.0372 @ $0.20</span>  <span className="text-green-400">+2.50% ($2.48)</span></div>
      </div>
      {/* Prices */}
      <div className="border border-cyan-800 m-1 p-1">
        <div className="text-cyan-400 text-[10px]">─ Prices ─</div>
        <div className="text-zinc-400">
          <div className="flex justify-between"><span>Pair</span><span>Kraken</span><span>Coinbase</span><span>Binance</span></div>
          <div className="flex justify-between text-white"><span>BTC-USD</span><span>$73,462</span><span>$73,466</span><span>$73,447</span></div>
          <div className="flex justify-between text-white"><span>ETH-USD</span><span>$2,305</span><span>$2,306</span><span>$2,304</span></div>
          <div className="flex justify-between text-white"><span>SOL-USD</span><span>$85.52</span><span>$85.55</span><span>$85.48</span></div>
        </div>
      </div>
      {/* Bottom row */}
      <div className="flex gap-1 m-1">
        <div className="border border-yellow-800 p-1 flex-1">
          <div className="text-yellow-400 text-[10px]">─ Arb Spreads ─</div>
          <div><span className="text-white">ETH-USD</span> <span className="text-zinc-400">0.16%</span> <span className="text-zinc-500">binance→kraken</span></div>
          <div><span className="text-white">BTC-USD</span> <span className="text-zinc-400">0.03%</span> <span className="text-zinc-500">below fees</span></div>
        </div>
        <div className="border border-green-800 p-1 flex-1">
          <div className="text-green-400 text-[10px]">─ Balances ─</div>
          <div><span className="text-cyan-400">Kraken</span>  <span className="text-white">$99.34 USD</span></div>
          <div><span className="text-yellow-400">Binance</span> <span className="text-white">$96.30 USDC</span></div>
          <div><span className="text-purple-400">Coinbase</span> <span className="text-white">0.043 ETH ($97)</span></div>
          <div className="text-zinc-500 mt-1">Total: <span className="text-white font-bold">$292.64</span></div>
        </div>
      </div>
      {/* Activity log */}
      <div className="border border-zinc-700 m-1 p-1">
        <div className="text-zinc-500 text-[10px]">─ Activity Log ─</div>
        <div><span className="text-zinc-500">01:39:27</span> <span className="text-yellow-400">⚡ SIGNAL: BUY SOL-USD @ 82.44 — 3 rising ticks confidence=0.70</span></div>
        <div><span className="text-zinc-500">01:39:27</span> <span className="text-green-400">✓ EXECUTED: bought 1.20693838 on kraken @ 82.44</span></div>
        <div><span className="text-zinc-500">01:39:30</span> <span className="text-blue-400">[arb] 6 ws prices | best: ETH-USD 0.16% need 0.20% more</span></div>
        <div><span className="text-zinc-500">01:39:35</span> <span className="text-white">[trade] SOL-USD $82.50 pos:+0.07% stop:-0.40%</span></div>
      </div>
    </div>
  );
}
