import Link from 'next/link';
import Image from 'next/image';
import {
  KrakenLogo, CoinbaseLogo, BinanceLogo, GeminiLogo,
  UniswapLogo, ZeroExLogo, OneInchLogo, JupiterLogo, PumpFunLogo,
} from './_components/brand-logos';

const platformMentions = [
  {
    name: 'Reddit',
    href: 'https://www.reddit.com/search/?q=b1dz',
    color: '#FF4500',
    path: 'M12 0A12 12 0 000 12a12 12 0 0012 12 12 12 0 0012-12A12 12 0 0012 0zm5.01 4.744c.688 0 1.25.561 1.25 1.249a1.25 1.25 0 01-2.498.056l-2.597-.547-.8 3.747c1.824.07 3.48.632 4.674 1.488.308-.309.73-.491 1.207-.491.983 0 1.78.797 1.78 1.78 0 .724-.435 1.343-1.053 1.614a3.111 3.111 0 01.067.628c0 3.187-3.712 5.769-8.287 5.769-4.575 0-8.287-2.582-8.287-5.77 0-.214.02-.422.056-.626-.625-.27-1.064-.893-1.064-1.621 0-.983.797-1.78 1.78-1.78.478 0 .911.188 1.229.494 1.206-.859 2.877-1.422 4.744-1.485l.92-4.319c.02-.093.071-.175.148-.23s.172-.079.263-.068l3.249.68a1.25 1.25 0 011.11-.676zM9.25 12C8.561 12 8 12.562 8 13.25c0 .687.561 1.248 1.25 1.248.687 0 1.248-.561 1.248-1.249 0-.688-.561-1.249-1.249-1.249zm5.5 0c-.687 0-1.248.561-1.248 1.25 0 .687.561 1.248 1.249 1.248.688 0 1.249-.561 1.249-1.249 0-.687-.562-1.249-1.25-1.249zm-5.466 3.99a.327.327 0 00-.231.094.33.33 0 000 .463c.842.842 2.484.913 2.961.913.477 0 2.105-.056 2.961-.913a.361.361 0 00.029-.463.33.33 0 00-.464 0c-.547.533-1.684.73-2.512.73-.828 0-1.979-.196-2.512-.73a.326.326 0 00-.232-.095z',
  },
  {
    name: 'X',
    href: 'https://x.com/search?q=b1dz',
    color: '#FFFFFF',
    path: 'M18.901 1.153h3.68l-8.04 9.19L24 22.846h-7.406l-5.8-7.584-6.638 7.584H.474l8.6-9.83L0 1.154h7.594l5.243 6.932ZM17.61 20.644h2.039L6.486 3.24H4.298Z',
  },
  {
    name: 'Bluesky',
    href: 'https://bsky.app/search?q=b1dz',
    color: '#0085FF',
    path: 'M12 10.8c-1.087-2.114-4.046-6.053-6.798-7.995C2.566.944 1.561 1.266.902 1.565.139 1.908 0 3.08 0 3.768c0 .69.378 5.65.624 6.479.815 2.736 3.713 3.66 6.383 3.364.136-.02.275-.039.415-.056-.138.022-.276.04-.415.056-3.912.58-7.387 2.005-2.83 7.078 5.013 5.19 6.87-1.113 7.823-4.308.953 3.195 2.05 9.271 7.733 4.308 4.267-4.308 1.172-6.498-2.74-7.078a8.741 8.741 0 0 1-.415-.056c.14.017.279.036.415.056 2.67.297 5.568-.628 6.383-3.364.246-.828.624-5.79.624-6.478 0-.69-.139-1.861-.902-2.206-.659-.298-1.664-.62-4.3 1.24C16.046 4.748 13.087 8.687 12 10.8Z',
  },
  {
    name: 'Stacker News',
    href: 'https://stacker.news/search?q=b1dz',
    color: '#FADA5E',
    path: 'M3 3h6l3 6 3-6h6L15 21h-3l3-9-3 3h-2l-3-3 3 9H9L3 3z',
  },
  {
    name: 'Hacker News',
    href: 'https://hn.algolia.com/?q=b1dz',
    color: '#FF6600',
    path: 'M0 24V0h24v24H0zM6.951 5.896l4.112 7.708v5.064h1.583v-4.972l4.148-7.799h-1.749l-2.457 4.875c-.372.745-.688 1.434-.688 1.434s-.297-.708-.651-1.434L8.831 5.896h-1.88z',
  },
  {
    name: 'dev.to',
    href: 'https://dev.to/search?q=b1dz',
    color: '#FFFFFF',
    path: 'M7.42 10.05c-.18-.16-.46-.23-.84-.23H6l.02 2.44.04 2.45.56-.02c.41 0 .63-.07.83-.26.24-.24.26-.36.26-2.2 0-1.93-.02-1.96-.29-2.18zM0 4.94v14.12h24V4.94H0zM8.56 15.3c-.44.58-1.06.77-2.53.77H4.71V8.53h1.4c1.67 0 2.16.18 2.6.9.27.43.29.6.32 2.57.05 2.23-.02 2.73-.47 3.3zm5.09-5.47h-2.47v1.77h1.52v1.28l-.72.04-.75.03v1.77l1.22.03 1.2.04v1.28h-1.6c-1.53 0-1.6-.01-1.87-.3l-.3-.28v-3.16c0-3.02.01-3.18.25-3.48.23-.31.25-.31 1.88-.31h1.64v1.3zm4.68 5.45c-.17.43-.64.79-1 .79-.18 0-.45-.15-.67-.39-.32-.32-.45-.63-.82-2.08l-.9-3.39-.45-1.67h.76c.4 0 .75.02.75.05 0 .06 1.16 4.54 1.26 4.83.04.15.32-.7.73-2.3l.66-2.52.74-.04c.4-.02.73 0 .73.04 0 .14-1.67 6.38-1.8 6.68z',
  },
];

const supportedFeatures = [
  {
    title: 'Realtime Multi-Exchange Data',
    desc: 'Persistent WebSocket feeds, live prices, balances, spreads, activity logs, and raw daemon status across Kraken, Coinbase, Binance.US, and Gemini.',
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
        <div className="rounded-2xl border border-zinc-800 bg-zinc-900/70 px-6 py-6">
          <p className="text-center text-xs uppercase tracking-[0.35em] text-zinc-500 mb-5">As mentioned on:</p>
          <div className="flex flex-wrap items-center justify-center gap-3 sm:gap-4">
            {platformMentions.map((p) => (
              <a
                key={p.name}
                href={p.href}
                target="_blank"
                rel="noopener noreferrer"
                className="group flex items-center gap-2 rounded-full border border-zinc-800 bg-zinc-950/60 px-3.5 py-2 text-sm font-medium text-zinc-300 transition hover:border-zinc-600 hover:bg-zinc-900 hover:text-white"
                aria-label={p.name}
              >
                <svg
                  role="img"
                  aria-hidden="true"
                  viewBox="0 0 24 24"
                  className="h-4 w-4 shrink-0 transition-transform group-hover:scale-110"
                  fill={p.color}
                >
                  <path d={p.path} />
                </svg>
                <span>{p.name}</span>
              </a>
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
        <div className="flex flex-wrap items-center justify-center gap-12 text-zinc-400">
          <div className="text-center flex flex-col items-center">
            <div className="mb-3"><KrakenLogo /></div>
            <div className="text-2xl font-bold text-zinc-200 mb-1">Kraken</div>
            <div className="text-sm">0.26% taker fee</div>
          </div>
          <div className="text-center flex flex-col items-center">
            <div className="mb-3"><CoinbaseLogo /></div>
            <div className="text-2xl font-bold text-zinc-200 mb-1">Coinbase</div>
            <div className="text-sm">0.60% taker fee</div>
          </div>
          <div className="text-center flex flex-col items-center">
            <div className="mb-3"><BinanceLogo /></div>
            <div className="text-2xl font-bold text-zinc-200 mb-1">Binance.US</div>
            <div className="text-sm">0.10% taker fee</div>
          </div>
          <div className="text-center flex flex-col items-center">
            <div className="mb-3"><GeminiLogo /></div>
            <div className="text-2xl font-bold text-zinc-200 mb-1">Gemini</div>
            <div className="text-sm">0.40% taker fee</div>
          </div>
        </div>

        <h3 className="text-2xl font-bold mt-16 mb-8">
          <span className="bg-gradient-to-r from-orange-400 to-amber-500 bg-clip-text text-transparent">Supported DEXes</span>
        </h3>
        <div className="flex flex-wrap items-center justify-center gap-12 text-zinc-400">
          <div className="text-center flex flex-col items-center">
            <div className="mb-3"><UniswapLogo /></div>
            <div className="text-2xl font-bold text-zinc-200 mb-1">Uniswap V3</div>
            <div className="text-sm">ETH · Base · Arbitrum · Optimism · Polygon</div>
          </div>
          <div className="text-center flex flex-col items-center">
            <div className="mb-3"><ZeroExLogo /></div>
            <div className="text-2xl font-bold text-zinc-200 mb-1">0x</div>
            <div className="text-sm">Multi-chain aggregator</div>
          </div>
          <div className="text-center flex flex-col items-center">
            <div className="mb-3"><OneInchLogo /></div>
            <div className="text-2xl font-bold text-zinc-200 mb-1">1inch</div>
            <div className="text-sm">Coming soon</div>
          </div>
          <div className="text-center flex flex-col items-center">
            <div className="mb-3"><JupiterLogo /></div>
            <div className="text-2xl font-bold text-zinc-200 mb-1">Jupiter</div>
            <div className="text-sm">Solana aggregator</div>
          </div>
          <div className="text-center flex flex-col items-center">
            <div className="mb-3"><PumpFunLogo /></div>
            <div className="text-2xl font-bold text-zinc-200 mb-1">Pump.fun</div>
            <div className="text-sm">Solana launchpad</div>
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
