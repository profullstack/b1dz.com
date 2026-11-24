# b1dz research

A market research TUI: 28 dashboards, 116 tabs and 221 cards covering equities,
options, sovereign curves, credit, FX, futures, energy, shipping, macro, SEC
filings and news. Every card reads a public or official source and names it.
No b1dz account is needed, and all but one card work with no API key.

```sh
b1dz research                        # open the TUI
b1dz research company symbol=NVDA    # open on a dashboard
b1dz research help                   # every command
```

Research only. Quotes can be delayed, data can be revised, there is no order
entry, and nothing here is investment advice.

## One registry, four surfaces

Cards live in `packages/research` (`@b1dz/research`, no dependencies). A card
fetches from its source and returns neutral blocks (table, chart, stats, text)
with the source that answered and the data date. Four surfaces run the same
cards:

| Surface | Where | Notes |
|---|---|---|
| TUI | `b1dz research` | `apps/cli/src/research/tui.ts` |
| CLI | `b1dz research card <id> [name=value ...] [--json\|--csv]` | text, JSON or CSV for scripts |
| HTTP API | `GET /api/research`, `/api/research/card/<id>`, `/api/research/search` | catalog is public; cards need a session or a `b1dz_agent_` token |
| MCP | `research_catalog`, `research_search`, `research_card` on `/api/agent/mcp` | read-only tools beside the trading tools |

## Coverage

| Group | Dashboards (id: tabs) |
|---|---|
| **Overview** | **Markets Summary** (`summary`: Summary, Compare, Chart, Data status) |
| **Equities** | **Company** (`company`: Overview, Statements, Estimates, Price & Peers, Growth & Ratios, Ownership, Dividends, Filings, Shorts, Bank quality); **Screeners & Movers** (`screeners`: Movers, Screener); **Calendars & Events** (`calendars`: Earnings, Dividends, IPOs & Splits, Economic events); **Canada (TMX)** (`canada`: Market, Listing); **Nordics (Nasdaq Nordic)** (`nordics`: Indices, Shares) |
| **Indices, ETFs & Factors** | **Indices** (`indices`: World, U.S. sectors, Constituents, S&P 500 long run); **ETFs & Funds** (`etfs`: Profile, Weights, Overlap, N-PORT filings); **Factors & Styles** (`factors`: Factors, Cross-asset risk, Rotation) |
| **Rates & Credit** | **Rates & Curves** (`rates`: Global, By Country, U.S., Euro area, Money markets, Swaps & OIS, Policy Expectations); **Credit** (`credit`: Spreads, Bond Lookup, Private credit, Corporate debt & lending); **Government Finance** (`govfin`: Public debt, Treasury cash balance, Auctions, Fed balance sheet, Primary dealers) |
| **Derivatives** | **Equity Options** (`options`: Chain, Stats, Term structure, Smile & surface, Volatility, Strategies); **Futures & Positioning** (`futures`: Futures, Positioning) |
| **Currencies** | **Currencies** (`fx`: Board, Strength, Cross rates, Rates & differentials, REER & reserves, Positioning) |
| **Commodities & Energy** | **Commodities** (`commodities`: Boards, Curves, Positioning); **Energy** (`energy`: Overview, Oil, Natural gas, Power, Outlook, International); **Agriculture & Food** (`agri`: Boards and curves, Positioning, Balances, Farm data) |
| **Crypto** | **Crypto** (`crypto`: Spot, Order book, Options, Volatility, Funding) |
| **Macro & Economy** | **Money & Banking** (`banking`: Bank credit quality, Bank failures, Bank lookup, Fed and ECB liquidity); **Economy by Country** (`economy`: Country Monitor, OECD snapshot, External accounts, IMF forecasts); **U.S. Economy** (`us-economy`: Nowcasts, Prices, Labor, Housing & CRE, Business surveys); **Trade & Shipping** (`trade`: Chokepoints, Ports, Trade); **Data Explorers** (`explorers`: Search) |
| **Government & Regulation** | **U.S. Congress** (`congress`: Bills, Laws, Votes, Members, Committees); **Federal Spending** (`spending`: Agencies, Awards, Recipients) |
| **News & Research** | **SEC Filings & Enforcement** (`sec`: Search, Latest filings, Enforcement & news, Advisers); **News** (`news`: Markets, Official, Company, Regional) |

`b1dz research list` prints every card id with its params.

## Keys in the TUI

| Key | Does |
|---|---|
| `h` / `l`, arrows | dashboard list / cards |
| `[` `]`, `1`-`9` | previous / next tab, jump to tab |
| `Tab`, `Enter`, `Esc` | next card, maximize it, go back |
| `/` or `Ctrl-G` | search: ticker, company, `CIK 320193`, CUSIP, dataset (`cpi`, `sofr`), dashboard |
| `s`, `p` | set the tab's main input (symbol, country, query), or any param |
| `<` `>` | shorter / longer date range (1M to MAX) |
| `t` | chart transform: level, indexed, YoY %, drawdown |
| `w` | watchlist: `+AAPL` adds, `-TSLA` removes, a name switches list |
| `c` | compare up to eight tickers or `FRED:SERIES` on one axis |
| `+` / `-` | pin the focused card to "My dashboard" / unpin |
| `e`, `o` | export the focused card to CSV (with its source line), show its source page |
| `r`, `R` | reload the tab, clear the cache and reload |
| `?`, `q` | help, quit |

Watchlists, pinned cards, last-used params and optional keys are kept in
`~/.config/b1dz/research.json` (mode 600). Nothing in it is sent to b1dz.com.

## Sources

Nasdaq, SEC EDGAR, FINRA, Cboe, TMX Money, Nasdaq Nordic, U.S. Treasury and
Fiscal Data, Federal Reserve, New York / Atlanta / Cleveland / Philadelphia
Fed, FRED, ECB, Bank of England, Japan MoF, Bank of Canada, Riksbank, Tesouro
Direto, BIS, IMF and IMF PortWatch, OECD, CFTC, DTCC SDR, FDIC, EIA, BLS,
U.S. Census, USDA FAS, Freddie Mac, Congress.gov, U.S. Senate, USAspending,
UN Comtrade, Deribit, Coinbase, Kraken, Montreal Exchange, and publisher and
agency RSS feeds.

Where a card has more than one provider it tries them in order, shows the one
that answered in its header, and lists the ones it skipped in its notes.
**Data status** (Markets Summary) shows which sources answered or failed in
the session.

### Optional free keys

| Key | Env | Adds |
|---|---|---|
| FRED | `FRED_API_KEY` | series search; FRED series themselves plot without a key |
| EIA | `EIA_API_KEY` | in practice required for the Energy dashboard: without it cards use EIA's shared demo key, which allows about ten requests and a small daily cap per network, and a cold load of Energy needs about twelve |
| BLS | `BLS_API_KEY` | higher limits and longer history |
| CONGRESS | `CONGRESS_API_KEY` | your own limits (otherwise the shared demo key, about 10 requests an hour) |

`b1dz research keys set FRED <key>` saves one locally; the server reads the
environment variables.

## What to know about the data

- **Quotes are daily closes or delayed.** Boards show price return, not total
  return, and say so. Index levels from Cboe files are previous-close values.
  FX is the ECB daily reference rate.
- **Yahoo Finance is the only source for futures quotes and most non-U.S.
  listings**, and it refuses data-centre networks. Those cards (front-month
  futures board, Fed funds futures, WTI curve, commodity and agriculture
  boards and curves, world indices outside North America) work from a home or
  office connection and report "unavailable" through the hosted API and MCP.
  Their Yahoo parser is covered by a fixture test but has not been run live
  from the build server.
- **Four EIA cards are unconfirmed**: `energy.steo`, `energy.intl-crude-production`,
  `energy.intl-crude-exports` and `commodities.wti-nearby-curve` were written
  from the EIA documentation but the demo key ran out before they could be run
  once. Each throws a clear source error if a series id is wrong.
- **Option implied volatility is computed here.** Nasdaq chains carry no IV, so
  it is solved from bid/ask mids against the forward implied by put-call
  parity, with SOFR as the rate. Dealer gamma exposure uses the usual
  convention (calls positive, puts negative); it is not observed positioning.
- **Sovereign curves** are daily from the official source for the U.S., euro
  area, U.K. (5Y, 10Y, 20Y only), Japan, Canada, Sweden and Brazil. Every other
  country, Germany included, uses the monthly OECD 3-month and 10-year pair.
- **Not included**, because no openly reachable source exists: FINRA TRACE
  bond lookup (a bond pricer and the 10-K debt maturity wall stand in), a
  market-implied policy path from OIS, single-name CDS, Shiller CAPE,
  Fama-French factors, the Caldara-Iacoviello geopolitical risk index,
  tariffs, and earnings call transcripts.
- **Macro shows official releases and IMF forecasts**, not survey consensus.

## Adding a card

1. Add a `CardDef` in `packages/research/src/cards/<area>/` (see `types.ts`):
   an id `area.name`, a `source`, params with defaults, and `run(ctx, params)`
   returning blocks. Fetch only through `ctx.http` so the cache, the per-host
   queue and Data status all see the request.
2. Put its id on a tab in that area's dashboards.
3. Check it live: `pnpm exec tsx packages/research/scripts/run-card.ts <id>`.
   `--all <prefix>` runs every card in an area and fails on an empty one.
4. Test parsers and maths on inline fixtures beside the code.

A card never returns sample data. If its source is down it throws, and the
surface shows the source's own error.

## Origin

The feature set follows the public description of an existing open-source
research terminal. This is an independent implementation written from that
feature list and from each data provider's own documentation; no code, text or
assets from that project were used.
