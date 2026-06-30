# Trading Strategy Protocol (TSP) — v0.1

**An open, vendor-neutral, declarative JSON protocol for signals-only equities &
crypto trading strategies.**

- Canonical JSON Schema: <https://b1dz.com/spec/tsp/v0.1/tsp.schema.json>
- Status: Draft v0.1
- License: open (publish freely; attribution appreciated)

## Why

There is no widely-adopted open standard for describing a trading strategy as
*data*:

- **Pine Script** (TradingView) is a proprietary, code-based DSL.
- **QuantConnect / LEAN, Backtrader, Backtesting.py** express strategies as
  Python/C# **code**.
- **FIX / FIXML** standardize *order and execution messaging*, not strategy
  logic.

TSP fills that gap. A TSP document is **declarative data, not a program**: it
names indicators and boolean rules over them, and emits buy/sell *signals*. It
never sizes, executes, or touches keys — an engine does that. Because nothing in
a document is executable code, **user-authored strategies are safe to validate,
backtest, share, and publish**.

## Design principles

1. **Signals-only.** A strategy reads a market-data stream and emits a `Signal`
   (`side`, `strength`, `reason`). Sizing, risk, session-gating, and execution
   belong to the runtime, not the strategy.
2. **Asset-agnostic.** The same document scores BTC-USD ticks or AAPL bars; it
   operates on a mid-price series.
3. **Total & safe.** No loops, no I/O, no code. A malformed or hostile document
   can at worst produce no signal.
4. **Two surfaces, one model.** `template` (presets with sliders) and `rules`
   (an indicator + condition builder) both compile to the same plugin shape.

## Document shape

```json
{
  "tsp": "0.1",
  "id": "my-rsi-dip",
  "name": "My RSI Dip Buyer",
  "author": "anthony",
  "description": "Buy deep RSI dips, sell the bounce.",
  "assetClasses": ["crypto", "equity"],
  "definition": { "...": "one of: template | rules" }
}
```

| Field          | Required | Notes                                                   |
| -------------- | -------- | ------------------------------------------------------- |
| `tsp`          | ✓        | Protocol version. Must be `"0.1"`.                      |
| `id`           | ✓        | Stable slug `^[a-z0-9][a-z0-9-]*$`.                     |
| `name`         | ✓        | Human-readable name.                                    |
| `author`       |          | Display author.                                         |
| `description`  |          | Free text.                                              |
| `assetClasses` |          | Subset of `["crypto","equity"]`; informational.         |
| `definition`   | ✓        | A `template` or `rules` body.                            |

## `definition.kind = "template"`

A named preset with numeric overrides. Unspecified params use the defaults.

```json
{ "kind": "template", "template": "mean-reversion", "params": { "period": 14, "oversold": 30, "overbought": 70 } }
```

| Template             | Params (defaults)                       | Behavior                                                                 |
| -------------------- | --------------------------------------- | ----------------------------------------------------------------------- |
| `mean-reversion`     | `period` 14, `oversold` 30, `overbought` 70 | Buy when RSI ≤ oversold; sell when RSI ≥ overbought.                 |
| `breakout`           | `lookback` 20                           | Buy above the prior `lookback`-bar high; sell below the prior low.       |
| `trend-continuation` | `fast` 12, `slow` 26                    | Buy when fast EMA > slow EMA with positive MACD; sell on the inverse.    |

## `definition.kind = "rules"`

Declare indicators, then list `{when, signal}` rules. **The first rule whose
`when` evaluates true wins**; if none match, no signal is emitted.

```json
{
  "kind": "rules",
  "indicators": {
    "rsi14":   { "fn": "rsi", "period": 14 },
    "emaFast": { "fn": "ema", "period": 12 },
    "emaSlow": { "fn": "ema", "period": 26 }
  },
  "rules": [
    { "when": { "lt": ["rsi14", 30] }, "signal": { "side": "buy", "strength": 0.8, "reason": "RSI oversold" } },
    { "when": { "and": [ { "gt": ["rsi14", 70] }, { "lt": ["emaFast", "emaSlow"] } ] }, "signal": { "side": "sell" } }
  ]
}
```

### Indicators

Each yields the **latest scalar value** over the mid-price series.

| `fn`       | Params (defaults)               | Value                          |
| ---------- | ------------------------------- | ------------------------------ |
| `rsi`      | `period` 14                     | Wilder's RSI.                  |
| `ema`      | `period` (required)             | Latest EMA.                    |
| `sma`      | `period` (required)             | Simple moving average.         |
| `macdHist` | `fast` 12, `slow` 26, `signal` 9 | MACD histogram (latest).       |

### Operands

A condition operand is one of:

- a **number** literal (e.g. `30`),
- the keyword **`"price"`** — the current bar's mid price, or
- a **declared indicator name** (a key of `indicators`).

### Conditions

A boolean expression tree. A comparison object has exactly one comparator key:

```
{ "gt": [a, b] } | { "gte": [a, b] } | { "lt": [a, b] } | { "lte": [a, b] } | { "eq": [a, b] } | { "neq": [a, b] }
```

Combine with `{ "and": [..] }`, `{ "or": [..] }`, `{ "not": <cond> }`.

### Signal

```json
{ "side": "buy" | "sell", "strength": 0.0-1.0, "reason": "text" }
```

`strength` defaults to `1` and is clamped to `[0,1]`. `reason` defaults to a
generic message.

## Semantics

Given the chronological mid-price series (history + current bar):

1. If the series is shorter than the longest declared indicator needs, emit
   **no signal** (`null`).
2. Compute each declared indicator's latest value.
3. For `rules`: evaluate rules top-to-bottom; emit the first match's signal.
   For `template`: apply the preset's logic.

The runtime turns signals into trades. The reference backtester
(`@b1dz/source-strategies` → `replayStrategy`) is **long-only**: enter on `buy`
when flat, exit on `sell` when long, mark any open position to the final bar.

## Reference implementation

`@b1dz/source-strategies` exports:

- `tsp.validateDefinition(doc)` / `tsp.assertDefinition(doc)` — structural validation.
- `tsp.compile(doc)` → a `StrategyPlugin` you can run or backtest.

```ts
import { tsp, replayStrategy, summarizeTrades } from '@b1dz/source-strategies';

const plugin = tsp.compile(doc);              // throws on invalid docs
const trades = replayStrategy(plugin, snapshots, 100);
const summary = summarizeTrades(trades);      // return, win rate, drawdown, …
```

## Versioning

`tsp` is the protocol version. v0.x may evolve; breaking changes bump the
version and the schema URL path (`/spec/tsp/v0.2/…`). Documents declare the
version they target so engines can refuse unknown ones.

## Roadmap (post-v0.1)

- More indicators (`atr`, `vwap`, `bbands`, cross-over helpers `crossAbove`/`crossBelow`).
- `highest`/`lowest` window indicators (so breakout is expressible in `rules`).
- Optional per-strategy risk hints (advisory only).
- JSON-LD `@context` for linked-data tooling; SchemaStore.org catalog entry.
