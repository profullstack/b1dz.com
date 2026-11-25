# b1dz — AI Arbitrage Terminal

b1dz is an AI-powered crypto arbitrage terminal. It runs realtime auto-trading
across multiple centralized exchanges (Kraken, Coinbase, Binance.US, Gemini) and
decentralized exchanges (Uniswap V3, 0x, Jupiter, Pump.fun, with more coming
soon). A deterministic analysis engine scores setups before execution and
signal-only plugins keep your exchange keys private.

## What it can do

- Stream realtime prices, balances, and spreads over persistent WebSocket feeds.
- Score setups with EMA, RSI, MACD, ATR, VWAP, volume, and market-regime classification.
- Execute spread arbitrage (cross-exchange) and inventory arbitrage (inventory-aware).
- Run directional strategies: trend continuation, mean reversion, breakout/breakdown.
- Backtest strategies against historical data and review OHLC charts with trade context.
- Apply risk controls: trailing stops and one position per exchange.
- Extend the platform through the Plugin Store (DEX connectors and strategies).

## Market research

`b1dz` opens the terminal (the same app as b1dz.com/terminal): 37 dashboards and 282 cards over
equities, options, yield curves, credit, FX, futures, energy, shipping, macro,
SEC filings and news, each naming its public source. Agents use the same cards:

- Web: https://b1dz.com/terminal (public to browse, sign in for live data).
- MCP at `https://b1dz.com/api/agent/mcp`: `research_catalog` (list cards),
  `research_search` (ticker, company, dataset), `research_card` (run one, e.g.
  `{"id":"rates.curve","params":{"country":"JP"}}`). All read-only.
- HTTP: `GET /api/research` (public catalog), `GET /api/research/card/{id}`.
- CLI: `b1dz research card <id> [name=value ...] --json`.

Quotes can be delayed. Research only, not investment advice.

## Install the CLI

```sh
curl -fsSL https://b1dz.com/install.sh | sh   # or: npm install -g @profullstack/b1dz
b1dz login && b1dz setup && b1dz tui
```

The installer only installs the `b1dz` command; it never asks for or stores keys.

## Key links

- Home: https://b1dz.com/
- Plugin Store: https://b1dz.com/store
- Sign up: https://b1dz.com/signup
- Source / org: https://github.com/profullstack/b1dz.com

## Disclaimer

Trading cryptocurrency involves substantial risk of loss. b1dz automates trade
execution and analysis; it does not guarantee any profit.
