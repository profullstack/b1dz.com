# TODO

## Exchange integrations

- [ ] **Bitstamp** — add price feed + trading credentials
  - Public OHLC: `https://www.bitstamp.net/api/v2/ohlc/{pair}/`
  - Taker fee: 0.40% (reduces with volume)
  - US-legal, well-regulated
  - Adds a 4th executable venue alongside Kraken / Coinbase / Binance.US
- [ ] **Bitfinex** — add price feed + trading credentials
  - Public OHLC: `https://api-pub.bitfinex.com/v2/candles/trade:{tf}:{pair}/hist`
  - Taker fee: 0.20% (0.10% at higher tiers)
  - Not available to US retail — requires non-US entity. Flag legal review before enabling trading.
- [ ] **Gemini** — add trading credentials
  - Price feed already wired (observe-only today)
  - Taker fee: 0.40%
  - US-legal
  - 283 pairs listed vs Binance.US's 6 actively-traded — best candidate for meaningful arb expansion
