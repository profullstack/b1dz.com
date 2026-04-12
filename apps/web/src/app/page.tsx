import Link from 'next/link';
import Image from 'next/image';
import { TuiScreenshot } from './components/tui-screenshot';
import { DashboardMock } from './components/dashboard-mock';

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
      </section>

      {/* Terminal Screenshot */}
      <section className="max-w-5xl mx-auto px-6 pb-8">
        <h3 className="text-center text-sm text-zinc-500 uppercase tracking-wide mb-4">Terminal Interface</h3>
        <TuiScreenshot />
      </section>

      {/* Web Dashboard Mock */}
      <section className="max-w-5xl mx-auto px-6 pb-16">
        <h3 className="text-center text-sm text-zinc-500 uppercase tracking-wide mb-4">Web Dashboard</h3>
        <DashboardMock />
      </section>

      {/* Features */}
      <section id="features" className="max-w-6xl mx-auto px-6 py-16">
        <h2 className="text-3xl font-bold text-center mb-12">
          <span className="bg-gradient-to-r from-orange-400 to-amber-500 bg-clip-text text-transparent">How it works</span>
        </h2>
        <div className="grid md:grid-cols-3 gap-8">
          <FeatureCard
            title="Multi-Exchange Scanning"
            desc="Monitors prices across Kraken, Coinbase, Binance, and Gemini in real-time via WebSocket feeds."
            icon="chart"
          />
          <FeatureCard
            title="AI-Powered Strategies"
            desc="Composite strategy engine combines RSI, EMA crossover, mean reversion, and scalp signals for high-probability entries."
            icon="brain"
          />
          <FeatureCard
            title="Risk Management"
            desc="Trailing stop-loss, take-profit targets, daily loss limits, and position sizing — all automated."
            icon="shield"
          />
          <FeatureCard
            title="Cross-Exchange Arbitrage"
            desc="Detects price gaps between exchanges and executes simultaneous buy/sell for risk-free profit."
            icon="arrows"
          />
          <FeatureCard
            title="Dynamic Pair Discovery"
            desc="Automatically finds the best trading pairs by volume, market cap, and momentum — including meme coins when they pump."
            icon="search"
          />
          <FeatureCard
            title="Terminal + Web + Mobile"
            desc="Monitor from the blessed TUI, web dashboard, or PWA on your phone. Same data, any device."
            icon="devices"
          />
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
    chart: '📊', brain: '🧠', shield: '🛡️', arrows: '🔄', search: '🔍', devices: '📱',
  };
  return (
    <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-6 hover:border-orange-500/30 transition">
      <div className="text-3xl mb-3">{icons[icon] ?? '⚡'}</div>
      <h3 className="text-lg font-semibold mb-2">{title}</h3>
      <p className="text-zinc-400 text-sm leading-relaxed">{desc}</p>
    </div>
  );
}
