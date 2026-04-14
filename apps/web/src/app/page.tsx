import Link from 'next/link';
import Image from 'next/image';

const platformMentions = ['reddit', 'X', 'Bluesky', 'Stacker News', 'Hacker News', 'dev.to'];

const supportedFeatures = [
  {
    title: 'Realtime Multi-Exchange Data',
    desc: 'Persistent WebSocket feeds, live prices, balances, spreads, activity logs, and raw daemon status across Kraken, Coinbase, and Binance.US.',
    icon: 'chart',
  },
  {
    title: 'Deterministic Analysis Engine',
    desc: 'EMA, RSI, MACD, ATR, VWAP, volume checks, and market-regime classification score setups before they ever reach execution.',
    icon: 'brain',
  },
  {
    title: 'Automated Risk Controls',
    desc: 'Trailing stops, take-profit targets, dust filtering, cooldowns, daily equity loss limits, and exchange minimum-size guards.',
    icon: 'shield',
  },
  {
    title: 'Cross-Exchange Opportunity Scanner',
    desc: 'Tracks theoretical spread arbitrage and executable inventory-backed arbitrage routes separately, so discovery and action stay clear.',
    icon: 'arrows',
  },
  {
    title: 'OHLC Charts + Trade Context',
    desc: 'Realtime terminal charts with timeframe switching, live price lines, volume overlays, entry and exit markers, and pair selection from the dashboard.',
    icon: 'candles',
  },
  {
    title: 'Backtesting + Analytics',
    desc: 'The same deterministic signal engine can run in backtests with fees, slippage, spread assumptions, and performance breakdowns by regime and symbol.',
    icon: 'search',
  },
];

const supportedStrategies = [
  {
    title: 'Trend Continuation',
    desc: 'Long and short setups aligned with higher-timeframe bias, VWAP, EMA structure, momentum, and volume confirmation.',
  },
  {
    title: 'Mean Reversion',
    desc: 'Pullback and exhaustion entries in range-bound or recovery contexts when price stretches away from local fair value.',
  },
  {
    title: 'Breakout / Breakdown',
    desc: 'Expansion setups gated by volatility, volume, and regime so compressed pairs can break cleanly instead of chopping you up.',
  },
  {
    title: 'Spread Arbitrage',
    desc: 'Cross-exchange spread discovery highlights raw price dislocations across supported venues for manual or future automated action.',
  },
  {
    title: 'Inventory Arbitrage',
    desc: 'Inventory-aware routes only fire when you already hold the asset on one exchange and quote balance on another.',
  },
  {
    title: 'Legacy Multi-Signal Fallback',
    desc: 'Composite scalp and momentum heuristics still exist as a fallback path while the deterministic analysis engine takes the lead.',
  },
];

export default function LandingPage() {
  return (
    <main className="min-h-screen bg-zinc-950 text-zinc-100">
      {/* Nav */}
      <nav className="flex items-center justify-between max-w-6xl mx-auto px-6 py-4">
        <div className="flex items-center">
          <Image src="/logo.svg" alt="b1dz" width={256} height={80} />
        </div>
        <div className="flex items-center gap-4">
          <Link href="/login" className="text-sm text-zinc-400 hover:text-zinc-200 transition">Sign in</Link>
          <Link href="/signup" className="text-sm bg-gradient-to-r from-orange-500 to-amber-500 hover:from-orange-400 hover:to-amber-400 text-black font-medium px-4 py-2 rounded-lg transition">Get started</Link>
        </div>
      </nav>

      {/* Hero */}
      <section className="max-w-6xl mx-auto px-6 pt-20 pb-16 text-center">
        <div className="mb-8">
          <Image src="/favicon.svg" alt="b1dz" width={120} height={120} className="mx-auto" />
        </div>
        <h1 className="text-5xl md:text-6xl font-bold mb-4 leading-tight">
          <span className="bg-gradient-to-r from-orange-400 to-amber-500 bg-clip-text text-transparent">AI Arbitrage Terminal</span>
        </h1>
        <p className="text-xl md:text-2xl text-zinc-400 mb-8 max-w-2xl mx-auto">
          Realtime auto-trading across multiple exchanges. Find price gaps. Execute instantly. Profit automatically.
        </p>
        <div className="flex items-center justify-center gap-4">
          <Link href="/signup" className="bg-gradient-to-r from-orange-500 to-amber-500 hover:from-orange-400 hover:to-amber-400 text-black font-semibold px-8 py-3 rounded-lg text-lg transition">
            Start trading
          </Link>
          <Link href="#features" className="border border-zinc-700 hover:border-zinc-500 text-zinc-300 px-8 py-3 rounded-lg text-lg transition">
            Learn more
          </Link>
        </div>
        <p className="mt-8 max-w-3xl mx-auto text-sm md:text-base italic text-zinc-500">
          “If you don't find a way to make money while you sleep, you will work until you die.” -- Warren Buffet
        </p>
      </section>

      <section className="max-w-6xl mx-auto px-6 pb-12">
        <div className="rounded-2xl border border-zinc-800 bg-zinc-900/70 px-6 py-5">
          <p className="text-center text-xs uppercase tracking-[0.35em] text-zinc-500 mb-4">As seen on</p>
          <div className="flex flex-wrap items-center justify-center gap-x-6 gap-y-3 text-sm md:text-base text-zinc-300">
            {platformMentions.map((name) => (
              <span key={name} className="font-medium text-zinc-300/90">{name}</span>
            ))}
          </div>
        </div>
      </section>

      {/* Terminal Screenshot */}
      <section className="max-w-5xl mx-auto px-6 pb-8">
        <h3 className="text-center text-sm text-zinc-500 uppercase tracking-wide mb-4">Terminal Interface</h3>
        <Image
          src="/images/gallery-1.png"
          alt="Terminal Interface"
          width={1960}
          height={682}
          className="w-full h-auto rounded-xl"
          priority
        />
      </section>

      {/* Web Dashboard Mock */}
      <section className="max-w-5xl mx-auto px-6 pb-16">
        <h3 className="text-center text-sm text-zinc-500 uppercase tracking-wide mb-4">Web Dashboard</h3>
        <Image
          src="/images/gallery-2.png"
          alt="Web Dashboard"
          width={1949}
          height={1254}
          className="w-full h-auto rounded-xl"
        />
      </section>

      {/* Features */}
      <section id="features" className="max-w-6xl mx-auto px-6 py-16">
        <h2 className="text-3xl font-bold text-center mb-12">
          <span className="bg-gradient-to-r from-orange-400 to-amber-500 bg-clip-text text-transparent">Supported features</span>
        </h2>
        <div className="grid md:grid-cols-3 gap-8">
          {supportedFeatures.map((feature) => (
            <FeatureCard key={feature.title} title={feature.title} desc={feature.desc} icon={feature.icon} />
          ))}
        </div>
      </section>

      {/* Strategies */}
      <section className="max-w-6xl mx-auto px-6 py-16">
        <h2 className="text-3xl font-bold text-center mb-4">
          <span className="bg-gradient-to-r from-orange-400 to-amber-500 bg-clip-text text-transparent">Trading strategies</span>
        </h2>
        <p className="text-center text-zinc-400 max-w-3xl mx-auto mb-12">
          b1dz supports deterministic setup scoring for directional trades plus separate spread and inventory arbitrage paths.
        </p>
        <div className="grid md:grid-cols-2 xl:grid-cols-3 gap-6">
          {supportedStrategies.map((strategy) => (
            <div key={strategy.title} className="rounded-xl border border-zinc-800 bg-zinc-900 px-6 py-5">
              <h3 className="text-lg font-semibold mb-2 text-zinc-100">{strategy.title}</h3>
              <p className="text-sm leading-relaxed text-zinc-400">{strategy.desc}</p>
            </div>
          ))}
        </div>
      </section>

      {/* Exchanges */}
      <section className="max-w-6xl mx-auto px-6 py-16 text-center">
        <h2 className="text-3xl font-bold mb-8">
          <span className="bg-gradient-to-r from-orange-400 to-amber-500 bg-clip-text text-transparent">Supported exchanges</span>
        </h2>
        <div className="flex items-center justify-center gap-12 text-zinc-400">
          <div className="text-center">
            <div className="text-2xl font-bold text-zinc-200 mb-1">Kraken</div>
            <div className="text-sm">0.26% taker fee</div>
          </div>
          <div className="text-center">
            <div className="text-2xl font-bold text-zinc-200 mb-1">Coinbase</div>
            <div className="text-sm">0.60% taker fee</div>
          </div>
          <div className="text-center">
            <div className="text-2xl font-bold text-zinc-200 mb-1">Binance.US</div>
            <div className="text-sm">0.10% taker fee</div>
          </div>
          <div className="text-center">
            <div className="text-2xl font-bold text-zinc-200 mb-1">Gemini</div>
            <div className="text-sm">Coming soon</div>
          </div>
        </div>
      </section>

      {/* CTA */}
      <section className="max-w-6xl mx-auto px-6 py-20 text-center">
        <h2 className="text-4xl font-bold mb-4">Ready to trade smarter?</h2>
        <p className="text-zinc-400 text-lg mb-8">Start with $100. One position per exchange. Let the AI find the edge.</p>
        <Link href="/signup" className="bg-gradient-to-r from-orange-500 to-amber-500 hover:from-orange-400 hover:to-amber-400 text-black font-semibold px-10 py-4 rounded-lg text-lg transition">
          Create your account
        </Link>
      </section>

      {/* Footer */}
      <footer className="border-t border-zinc-800 py-8 text-center text-zinc-500 text-sm">
        <p>&copy; {new Date().getFullYear()} b1dz.com — AI Arbitrage Terminal</p>
      </footer>
    </main>
  );
}

function FeatureCard({ title, desc, icon }: { title: string; desc: string; icon: string }) {
  const icons: Record<string, string> = {
    chart: '📊', brain: '🧠', shield: '🛡️', arrows: '🔄', search: '🔍', devices: '📱', candles: '🕯️',
  };
  return (
    <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-6 hover:border-orange-500/30 transition">
      <div className="text-3xl mb-3">{icons[icon] ?? '⚡'}</div>
      <h3 className="text-lg font-semibold mb-2">{title}</h3>
      <p className="text-zinc-400 text-sm leading-relaxed">{desc}</p>
    </div>
  );
}
