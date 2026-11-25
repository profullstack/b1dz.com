# b1dz research

A market research TUI: 37 dashboards, 156 tabs and 282 cards covering equities,
options, sovereign curves, credit, FX, futures, energy, shipping, crypto, macro,
SEC filings and news. Every card reads a public or official source and names it.
No b1dz account is needed, and all but one card work with no API key.

```sh
b1dz                                 # open the terminal (same as b1dz research)
b1dz research                        # open the TUI
b1dz research company symbol=NVDA    # open on a dashboard
b1dz research help                   # every command
```

Research only. Quotes can be delayed, data can be revised, and nothing here is
investment advice. The cards never trade. Buying and selling is a separate,
explicit step through your own broker: see [Watchlist and trading](#watchlist-and-trading).

## One registry, five surfaces

Cards live in `packages/research` (`@b1dz/research`, no dependencies). A card
fetches from its source and returns neutral blocks (table, chart, stats, text)
with the source that answered and the data date. Five surfaces run the same
cards:

| Surface | Where | Notes |
|---|---|---|
| TUI | `b1dz` (also `b1dz terminal`, `b1dz research`) | `apps/cli/src/research/tui.ts`. Bare `b1dz` opens it; the header links the web terminal and `u` prints a link to the same view |
| Web | `https://b1dz.com/terminal` | `apps/web/src/app/terminal/`: the same dashboards in the browser, keyboard driven, installable with the PWA. Public to browse; live data needs a signed-in user. Links are shareable (`/terminal?d=company&symbol=NVDA`) |
| CLI | `b1dz research card <id> [name=value ...] [--json\|--csv]` | text, JSON or CSV for scripts |
| HTTP API | `GET /api/research`, `/api/research/card/<id>`, `/api/research/search` | catalog is public; cards need a session or a `b1dz_agent_` token |
| MCP | `research_catalog`, `research_search`, `research_card`, `watchlist_get`, `watchlist_edit`, `broker_account`, `place_stock_order`, `cancel_stock_order` on `/api/agent/mcp` | research tools are read-only; the watchlist tools never trade; stock orders need the `trade:equity` scope and budget |

## Watchlist and trading

The web terminal has a right-hand panel (press `w`) with a watchlist, your
broker account and an order ticket. The CLI has the same account features as
`b1dz trade`.

### Watchlist

| Where | Saved | How |
|---|---|---|
| `/terminal` signed in | on your account (`TERMINAL_WATCHLIST` in your plain settings) | type a ticker in the panel, press `a` on a company page, or click `+ watch` |
| `/terminal` signed out | in that browser | same, prices need a sign-in |
| `b1dz trade watch [+NVDA -TSLA]` | on your account | the same list the web shows |
| `b1dz research watchlist` | on that machine (`~/.config/b1dz/research.json`) | the account-free TUI list |
| MCP | on your account | `watchlist_get`, `watchlist_edit` |
| TUI (`b1dz`) signed in | on your account | the list named `Account` mirrors it; `w` edits it |
| HTTP | on your account | `GET` / `PUT /api/terminal/watchlist` |

It holds up to 100 tickers of any kind the cards can price (`AAPL`, `BRK.B`,
`BTC-USD`, `^GSPC`). It is separate from `EQUITY_WATCHLIST`, the list the
automated equity strategies trade: watching a ticker never makes the bot trade
it. Prices in the panel are the latest daily close from the Watchlist card,
not a live quote.

### Buy and sell

Orders go through a broker you link yourself, on your own account:

| Broker | Link it | Accounts | Sizes |
|---|---|---|---|
| Alpaca | Settings, Plugins: paste an API key id and secret, or Connect | paper (default) and live | shares or dollars (fractional) |
| moomoo | Settings, Plugins: Connect (OAuth 2.1, grant quotes and trading) | paper (default) and live | whole shares |
| Tradier, Schwab, TradeStation, IBKR | Settings, Plugins | per broker | whole shares (IBKR fractional) |

Then unlock trading (Settings, or `b1dz unlock`): broker credentials are sealed
under your passphrase and only the daemon can read them, only while your
session is unlocked. The web server relays the ticket and never sees a key.

In the web terminal: `buy` / `sell` on a watchlist row or a position, `b` / `x` on
a company page. In the TUI (`b1dz`): `a` shows the account, `b` / `x` open a
one-line ticket for the tab's symbol (`5`, `$500`, or `5 @190.50 gtc`), and a
live order is sent only after you type `live`. The ticket takes shares (or dollars where the broker allows),
market or limit, day or good-until-canceled, and optional extended hours on a
limit order. You review it, and a live order needs a tick on "this is a real
order" before the button works. Open orders can be canceled from the panel.

```sh
b1dz trade                      # broker, buying power, positions, open orders
b1dz trade buy AAPL 5           # market order, asks before sending
b1dz trade buy SPY '$500'       # dollars (Alpaca)
b1dz trade sell AAPL 5 --limit 190.50 --gtc
b1dz trade orders
b1dz trade cancel <order-id>
b1dz trade --broker moomoo      # pick a linked broker
```

Guards on every manual order, applied in the daemon:

- a sell can never exceed the shares you hold (no short selling from a ticket);
- a live order may not exceed `TERMINAL_MAX_ORDER_USD` (default $10,000), and
  one that cannot be priced is refused, so use a limit order when quotes are down;
- paper and live are labelled on the account, the ticket and the confirmation.

Buying power, market hours and pattern-day-trading rules are the broker's
call; its answer is shown word for word. A manual order does not wait on
`EQUITY_TRADE_EXECUTION`: that switch gates the automated strategies only.
moomoo sometimes answers a live order with a warning to acknowledge; the
ticket shows it and sends only if you confirm. If a broker does not answer in
time the ticket says so and never retries by itself, because a placed order is
not idempotent: check your open orders first.

Agents (MCP) get less than you do at the ticket. `broker_account` reads the
account. `place_stock_order` and `cancel_stock_order` need a token with the
`trade:equity` scope; a buy must have a known maximum cost (a dollar amount, or
a limit order) and that cost is charged to the token's budget before the order
is sent and released if the broker refuses it. A broker warning that needs a
person's yes is never answered for an agent. Code: `apps/web/src/lib/agent-equity.ts`.

Code: `packages/core/src/terminal.ts` (shared ticket rules),
`apps/daemon/src/manual-trade.ts` and `brokers.ts`, `packages/source-moomoo`,
`packages/source-alpaca`, `apps/web/src/lib/terminal-api.ts`,
`apps/web/src/app/terminal/watch-panel.tsx`, `apps/cli/src/trade.ts`.

Operator setup for moomoo: register a public OAuth client once
(`POST https://webapi.moomoo.com/oauth2/register` with the redirect URI
`https://<site>/api/oauth/moomoo/callback` and
`token_endpoint_auth_method: "none"`) and set `MOOMOO_OAUTH_CLIENT_ID`. There
is no client secret.

## Live TV

CNBC, Bloomberg and Fox Business play inside the terminal from your own
[hdtilt.com](https://hdtilt.com) account. hdtilt is an IPTV player for a
playlist you already have; b1dz supplies no streams.

| Where | How |
|---|---|
| Web (`/terminal`) | the `tv` button or `v` opens a small tile, bottom right. `Connect hdtilt` the first time. Channel buttons, `,` and `.` to zap, `unmute`, and `pop out` for picture-in-picture, which stays on top of other windows and keeps playing if you close the tile |
| CLI | `b1dz tv login`, `b1dz tv` (what each channel matched), `b1dz tv watch cnbc` (plays in [mpv](https://mpv.io)), `b1dz tv logout` |
| TUI (`b1dz`) | `v` picks a channel and starts it in mpv |

How it works:

- **Sign-in is OAuth 2.1 with PKCE** against hdtilt.com, as a public client
  with no secret: `b1dz-web` (redirect `https://b1dz.com/api/tv/callback`) for
  the web tile and `b1dz-cli` (loopback redirect) for the CLI. hdtilt's consent
  screen names the app.
- **Tokens.** On the web the refresh token is an httpOnly cookie scoped to
  `/api/tv`; page script only ever gets the one-hour access token from
  `/api/tv/token`. Nothing is stored on the server. The CLI keeps its tokens in
  `~/.config/b1dz/tv.json` (mode 600).
- **Channels are found by name** with hdtilt's `POST /api/tv/find`, so neither
  the page nor the CLI holds your playlist address or provider password. The
  result is remembered for a week (web: this browser) and looked up again if a
  stream stops working.
- **Video goes straight from hdtilt to your browser** (its stream proxy, your
  token on every request). b1dz relays none of it.
- **Player:** `@profullstack/player` (`attachSource`): hls.js for HLS,
  mpegts.js for raw transport streams, one `<video>` element for both and for
  picture-in-picture.

Things to know:

- hdtilt keeps your playlists sealed under your passphrase. The first lookup
  needs your hdtilt library unlocked (open hdtilt.com and unlock); the tile
  says so when it is not.
- A channel that is not in your playlists shows as a greyed button.
- Browsers only start video muted; click `unmute`.
- Safari plays HLS natively and cannot send the token with it, so an HLS-only
  channel does not play in Safari yet. Transport streams (most IPTV) do.
- The MCP server has no TV tools: the connection lives in your browser or CLI,
  not on the server. hdtilt.com has its own MCP server.

Code: `apps/web/src/lib/tv-oauth.ts`, `apps/web/src/app/terminal/tv-tile.tsx`
and `tv.ts`, `apps/cli/src/tv.ts`, channel list in `packages/core/src/terminal.ts`.
`HDTILT_URL` points a dev build at another hdtilt.

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
| **Crypto** | **Crypto Markets** (`crypto-markets`: Overview, Movers, Sentiment, Sectors); **Crypto: Coin** (`crypto`: Overview, Venues, Order book, Options, Volatility, Funding, News); **Crypto Derivatives** (`crypto-derivatives`: Funding, Open interest, Venues, Basis, Positioning, Options); **DeFi** (`defi`: Value locked, Protocols, DEX volume, Fees & revenue, Yields, Hacks); **Stablecoins** (`stablecoins`: Supply, Pegs, By chain); **Bitcoin On-Chain** (`bitcoin`: Mempool & fees, Mining, Halving & supply, Activity, Lightning); **Ethereum On-Chain** (`ethereum`: Supply & burn, Gas & activity, Staking, Layer 2); **Crypto ETFs & Stocks** (`crypto-equities`: ETFs, Stocks, Treasuries); **Crypto Exchanges** (`crypto-exchanges`: Spot, Derivatives, Reserves & flows, Decentralized); **Crypto News** (`crypto-news`: Headlines, Coin or topic, Research) |
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
| `/` or `Ctrl-G` | search: ticker, company, coin (`sol`, `chainlink`), `CIK 320193`, CUSIP, dataset (`cpi`, `sofr`, `tvl`), dashboard |
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
UN Comtrade, Deribit, Coinbase and Coinbase Derivatives, Kraken, NicheDB
(Alpaca), Montreal Exchange, and publisher and agency RSS feeds. The crypto
dashboards add CoinPaprika, CoinGecko, alternative.me, DefiLlama,
mempool.space, Blockchain.com, 1ML, ultrasound.money, Blockscout, L2BEAT, and
the public market-data APIs of Hyperliquid, OKX, Kraken Futures, dYdX, Bitget,
Gate, Gemini, Bitstamp, Binance.US and Bitfinex.

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
- **Commodity and crypto futures come from Coinbase Derivatives**, the same
  exchange the b1dz console prices crypto from: crude oil, natural gas, gold,
  silver, copper, platinum, bitcoin and ether, with dated contracts for the
  forward curves. These are Coinbase's own contracts (crude is 10 barrels, not
  NYMEX's 1,000), quoted in the usual unit. They track the benchmark futures
  closely but are not CME settlements: the change is over 24 hours, far-dated
  contracts often have not traded yet (so a curve can be two points), and a
  contract's history starts when it was listed. Each row names its venue.
- **Crypto is keyless and built to stay inside free limits.** Ten dashboards
  in the Crypto group, described under [Crypto](#crypto) below.
- **U.S. stock and ETF history falls back to NicheDB**, the Alpaca-fed daily
  bars the b1dz console and backtester read, when Nasdaq does not answer.
- **Yahoo Finance is still the only source for the rest**: equity-index,
  Treasury, currency and agricultural futures, Brent and refined products,
  Fed funds futures, and listings and indices outside North America. Yahoo
  refuses data-centre networks, so those rows are blank and the Fed funds
  and agriculture futures cards report "unavailable" on the hosted site, API
  and MCP. From the TUI on a home or office connection they should work; that
  path has a fixture test but has not been run live.
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
  tariffs, crude exports by country (the EIA series is complete only through
  2018), and earnings call transcripts.
- **Macro shows official releases and IMF forecasts**, not survey consensus.

## Crypto

Every crypto card reads a public endpoint with no key. One `symbol` input (a
coin or a dollar pair: `SOL`, `ETH-USD`) drives the coin cards across
dashboards; the Deribit option and volatility cards take `currency` (BTC or
ETH) because Deribit lists options on those two only.

| Dashboard | Source | What to know |
|---|---|---|
| Crypto Markets | CoinPaprika, then CoinGecko; alternative.me; Coinbase | The top 500 coins (250 on the fallback). Prices are volume-weighted across exchanges. Trending and Sectors are CoinGecko only |
| Crypto: Coin | CoinPaprika; Coinbase, Kraken, Gemini, Bitstamp, Binance.US, Bitfinex, OKX; Deribit | Price Across Exchanges reads each exchange's own ticker. The spot book is one exchange (Kraken, then Coinbase). Market cap history goes back one year |
| Crypto Derivatives | Hyperliquid, OKX, Kraken Futures, dYdX, Bitget, Gate, Deribit, DefiLlama | Funding is annualised so venues with different intervals compare. Positioning and liquidations are OKX only |
| DeFi, Stablecoins | DefiLlama | Value locked, DEX volume, fees and revenue, yields, hacks, stablecoin supply and pegs. The large lists are cached for an hour |
| Bitcoin On-Chain | mempool.space, Blockchain.com, 1ML | Halving dates are estimates from the block height. Lightning is the public network as 1ML's node sees it |
| Ethereum On-Chain | ultrasound.money, Blockscout, L2BEAT, DefiLlama | Supply, burn and issuance; gas with dollar costs; staking; layer 2 value and activity |
| Crypto ETFs & Stocks | Nasdaq, Coinbase, CoinGecko | Share prices and returns, not fund flows. Treasuries are holdings from company filings as CoinGecko collects them |
| Crypto Exchanges | CoinPaprika, CoinGecko, DefiLlama | Reported volume, open interest, and the assets in wallets exchanges have disclosed |
| Crypto News | Publisher RSS feeds | CoinDesk, Cointelegraph, The Block, Decrypt, DL News, CryptoSlate, Protos, The Defiant and others, with repeats folded |

Limits that shape the cards:

- **CoinGecko's public API allows about five requests a minute** from a server
  address. It is the fallback for the market list and the only source for
  trending coins, sectors, derivatives exchanges and company treasuries, so
  those are cached for 30 minutes to six hours. A cold load of several
  CoinGecko cards at once can still be refused; the card says so and works on
  the next refresh.
- **CoinPaprika's keyless plan allows 20,000 requests a month** and one year of
  daily history. The market list is cached for five minutes.
- **Binance and Bybit do not serve U.S. addresses**, so they are not read
  directly. Their funding rates come from the comparison feed Hyperliquid
  publishes; their open interest and liquidations are not included, and the
  open interest and liquidation cards say they are not the whole market.
- **Not included**, because the source refused or was unreliable when tested:
  bridge volumes and perpetual DEX volume (DefiLlama serves those on its paid
  plan only), validator counts and the staking entry and exit queues
  (beaconcha.in now requires a key), and Lightning capacity history
  (mempool.space's Lightning statistics returned a different snapshot on each
  request). Spot ETF flows, market-wide liquidation totals and on-chain
  valuation measures such as MVRV are also absent: no open data feed for them
  was found.

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

5. Decide whether agents pay for it (`packages/research/src/billing.ts`). A
   card from FRED or EIA is metered automatically; a card b1dz computes
   (ratios, risk statistics, a payoff) is metered only if you add it to
   `DERIVED_CARDS`. Never meter a card that shows quotes: `billing.test.ts`
   fails if a raw-quote card (chart, board, chain, book, price history) is
   marked billable.

## Pricing, the AI analyst and agents

Plan approved 2026-11-25 as a 60-day test (to 2027-01-24); prices and caps are
env (see `apps/web/src/lib/monetization.ts`).

- **People** use `/terminal`, the TUI and the CLI free, every card included.
- **AI analyst** (`POST /api/research/analyst`, the "ask the AI analyst" box on
  `/terminal`, `b1dz analyst <question>`, MCP `research_analyst`): latest Opus,
  answering from up to 4 cards. Free accounts: `FREE_ANALYST_DAILY_QUERIES` (5)
  a day under `FREE_ANALYST_MONTHLY_CAP_USD` per user and
  `FREE_ANALYST_GLOBAL_MONTHLY_CAP_USD` for all free users, answers watermarked.
  Pro: until this calendar month's real Anthropic cost (from the usage block,
  table `ai_usage`) would pass `PRO_AI_MONTHLY_CAP_USD` ($8).
- **Pro** = prepaid passes on `/pricing` (CoinPay checkout, 30 days $25, 365
  days $199) adding `pro_days` to the credit ledger, plus credit codes, invite
  days and an active Profullstack Pass (read from CoinPay userinfo at CoinPay
  sign-in or connect; Settings has "Refresh Profullstack Pass").
- **Agents** (b1dz_agent_ token, MCP OAuth, or no credential): metered cards
  cost `AGENT_CARD_PRICE_USD` ($0.03), analyst queries `AGENT_ANALYST_PRICE_USD`
  ($0.35), paid by x402 (`PAYMENT-SIGNATURE`/`X-PAYMENT`, USDC via CoinPay to
  `CRAWL_PAY_TO`) or from prepaid agent credit (`agent_cents`). Otherwise HTTP
  402 with the x402 offer. Quote cards are always free. Charges: `agent_charges`.
- **Admin** (`/admin`, users in `B1DZ_ADMIN_USER_IDS`): trailing-30-day AI cost
  per non-paying user, total AI cost, Pro revenue vs Anthropic + server cost
  (`B1DZ_SERVER_MONTHLY_USD`), renewals, agent revenue, founder-time notes.
- **Referral links** (`apps/web/src/data/broker-referrals.json`, or
  `BROKER_REFERRAL_URLS` JSON in app.env) show where people link a broker;
  without a referral URL the plain signup link is shown.

## Origin

The feature set follows the public description of an existing open-source
research terminal. This is an independent implementation written from that
feature list and from each data provider's own documentation; no code, text or
assets from that project were used.
