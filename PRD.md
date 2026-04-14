# PRD.md

# Crypto Trading Bot Analysis Engine PRD

## 1. Overview

Build a deterministic short-term crypto trading analysis engine that scores market conditions and emits actionable trade setup signals without relying on AI for trade decisioning in v1.

The goal is to create a modular, testable signal engine that can:
- detect market regime
- score long and short setups
- filter out low-quality conditions
- support real-time analysis
- feed a downstream execution engine
- provide a clean upgrade path for AI-assisted regime classification and post-trade optimization in v2

This PRD covers the analysis engine only. It does not assume that AI is used to place trades.

## 2. Goals

- Generate short-term trading signals for crypto markets
- Support intraday and swing-aware analysis
- Minimize false positives during chop
- Avoid overfitting by using a small number of interpretable signals
- Provide a confidence score for each setup
- Make all signals explainable in logs and UI
- Enable later AI augmentation without changing core architecture

## 3. Non-Goals

- No AI-based autonomous trade placement in v1
- No next-candle prediction model in v1
- No opaque black-box signals in v1
- No exchange-specific execution logic in this module
- No portfolio optimization in v1

## 4. Product Requirements

The analysis engine must:
- run continuously on live market data
- support multiple symbols
- support multiple timeframes
- compute deterministic indicators in real time
- classify market regime before evaluating entries
- score setups using weighted signal logic
- emit structured signal objects for downstream execution
- expose reasons why a signal was produced or rejected
- log all intermediate values for backtesting and debugging

## 5. Supported Timeframes

The engine must support:
- 1m
- 5m
- 15m
- 1h
- 4h
- 1d
- 1w

Recommended default usage:
- entry timeframe: 1m or 5m
- confirmation timeframe: 15m
- bias timeframe: 1h

## 6. Core Strategy Philosophy

Use a small, complementary set of signals:
- trend
- momentum
- intraday bias
- volatility
- volume
- market regime

Do not stack many overlapping indicators.

The engine should first determine whether the market is:
- trending up
- trending down
- sideways / choppy
- high-volatility breakout
- low-volatility compression

Only strategies appropriate to the current regime should be eligible.

## 7. Inputs

Required live inputs:
- symbol
- exchange
- OHLCV candles by timeframe
- real-time last trade price
- bid/ask spread
- volume
- timestamp

Optional future inputs:
- order book imbalance
- funding rates
- open interest
- liquidations
- news / sentiment events

## 8. Indicators and Signals

### 8.1 Trend Filter
Primary trend filter:
- EMA fast
- EMA slow

Recommended defaults:
- 9 EMA
- 21 EMA
- optional 50 EMA for stronger trend confirmation

Rules:
- bullish trend when EMA fast > EMA slow and price > both
- bearish trend when EMA fast < EMA slow and price < both
- neutral otherwise

### 8.2 Momentum Confirmation
Use MACD as momentum confirmation, not as standalone direction.

Compute:
- MACD line
- signal line
- histogram
- histogram slope

Bullish momentum:
- MACD histogram > previous histogram
- MACD line >= signal line preferred

Bearish momentum:
- MACD histogram < previous histogram
- MACD line <= signal line preferred

### 8.3 Mean Reversion Trigger
Use RSI as a pullback or exhaustion tool, not as a standalone buy/sell trigger.

Recommended defaults:
- RSI length 14

Bullish pullback context:
- higher timeframe bullish
- RSI dips into 35-45 zone
- RSI turns upward

Bearish pullback context:
- higher timeframe bearish
- RSI rises into 55-65 zone
- RSI turns downward

Optional hard oversold / overbought:
- RSI < 30 oversold
- RSI > 70 overbought

### 8.4 Intraday Bias
Use VWAP as the primary intraday anchor.

Bullish intraday bias:
- price above VWAP
- or price reclaims VWAP after pullback

Bearish intraday bias:
- price below VWAP
- or price rejects VWAP after rally

### 8.5 Volatility Gate
Use ATR for volatility qualification and stop sizing.

Recommended default:
- ATR length 14

Usage:
- skip trades when ATR is below configured minimum threshold
- prefer breakout setups when ATR is expanding
- size stops and targets using ATR multiples

### 8.6 Volume Confirmation
Use volume as a quality check.

Recommended checks:
- current volume > rolling average volume
- breakout candle volume > N-period average
- reject weak breakouts on low volume

### 8.7 Optional Future Signals
Optional for v1.1 or v2:
- Bollinger Band expansion/compression
- ADX for trend strength
- support/resistance breakout detection
- order book imbalance
- liquidation cluster proximity
- open interest expansion

## 9. Market Regime Engine

Before scoring entries, classify current regime.

Minimum regimes:
- Uptrend
- Downtrend
- Sideways
- Breakout Expansion
- Compression

Suggested logic:
- Uptrend: EMA fast > EMA slow, price above VWAP, ATR normal-to-rising
- Downtrend: EMA fast < EMA slow, price below VWAP, ATR normal-to-rising
- Sideways: EMA mixed, price crossing VWAP frequently, low ADX or flat ATR behavior
- Breakout Expansion: ATR rising sharply, volume rising, price breaking recent range
- Compression: ATR falling, range narrowing, low realized volatility

The strategy engine must only allow:
- trend continuation setups in trending regimes
- mean reversion setups in sideways or pullback contexts
- breakout setups in expansion regimes

## 10. Setup Types

### 10.1 Long Trend Continuation
Conditions:
- higher timeframe bullish bias
- EMA fast > EMA slow
- price above VWAP
- RSI pulled back and recovering
- MACD histogram rising
- volume above average

Entry trigger examples:
- reclaim of short EMA
- break of prior candle high
- reclaim of VWAP after pullback

### 10.2 Short Trend Continuation
Conditions:
- higher timeframe bearish bias
- EMA fast < EMA slow
- price below VWAP
- RSI rallied and turning down
- MACD histogram falling
- volume above average

Entry trigger examples:
- rejection from short EMA
- break of prior candle low
- rejection at VWAP

### 10.3 Long Mean Reversion
Conditions:
- higher timeframe not strongly bearish
- price stretched below local fair value
- RSI oversold or in pullback zone
- seller momentum decelerating
- reclaim trigger confirmed

Good contexts:
- range market
- pullback in broader uptrend

### 10.4 Short Mean Reversion
Conditions:
- higher timeframe not strongly bullish
- price stretched above local fair value
- RSI overbought or in rally zone
- buyer momentum decelerating
- rejection trigger confirmed

### 10.5 Breakout / Breakdown
Conditions:
- recent compression or range
- ATR expansion begins
- volume expands
- price breaks local structure
- VWAP aligns with breakout direction where possible

## 11. Signal Scoring

Each candidate setup should receive a confidence score from 0 to 100.

Suggested weights:
- trend alignment: 25
- momentum confirmation: 20
- VWAP / intraday bias: 20
- RSI context: 10
- volatility qualification: 10
- volume confirmation: 10
- spread / execution quality: 5

Suggested score thresholds:
- 80-100: high-confidence setup
- 65-79: tradable setup
- 50-64: weak / optional
- below 50: reject

The engine must return both:
- numeric score
- structured reasons

Example:
- trend_aligned = true
- vwap_aligned = true
- macd_confirmed = true
- rsi_recovery = true
- volume_confirmed = false
- atr_ok = true

## 12. Risk and Trade Filters

The analysis engine must include reject conditions even though actual risk management may live elsewhere.

Reject setup if:
- spread too wide
- ATR too low
- volume too low
- recent candles too noisy
- price too extended from entry anchor
- regime conflicts with strategy type
- cooldown active for symbol
- too close to max loss threshold or kill switch state

Recommended filters:
- max spread percentage
- min ATR threshold by symbol
- min relative volume
- no trade after N consecutive stopouts
- no entry if distance to stop is too wide for configured risk

## 13. Outputs

The engine should emit structured signal objects like:

```json
{
  "symbol": "BTCUSDT",
  "timestamp": 1770000000,
  "timeframe": "5m",
  "regime": "uptrend",
  "setupType": "long_trend_continuation",
  "score": 84,
  "direction": "long",
  "entryBias": "market_or_limit",
  "entryZone": {
    "min": 63250.5,
    "max": 63290.0
  },
  "stopLoss": 62980.0,
  "takeProfit": 63840.0,
  "riskReward": 2.1,
  "indicators": {
    "emaFast": 63210.2,
    "emaSlow": 63140.7,
    "rsi": 42.6,
    "macdHistogram": 18.2,
    "vwap": 63195.8,
    "atr": 145.3,
    "volumeRatio": 1.42
  },
  "reasons": [
    "Higher timeframe bullish bias",
    "Price above VWAP",
    "EMA fast above EMA slow",
    "RSI pullback recovered",
    "MACD histogram rising"
  ],
  "rejected": false
}
```

Rejected setups should also be logged with reject reasons.

## 14. Backtesting Requirements

The same exact signal engine used in production must be usable in backtests.

Backtests must include:
- fees
- slippage
- spread assumptions
- latency assumptions where possible
- stop and target simulation
- cooldown logic
- no-trade filters

Minimum metrics:
- total return
- win rate
- profit factor
- expectancy
- max drawdown
- Sharpe or simpler risk-adjusted metric
- average hold time
- trades per day
- performance by symbol
- performance by regime
- performance by hour of day
- performance by volatility bucket

## 15. Logging and Observability

The engine must log:
- raw indicator values
- regime classification
- score breakdown
- reason codes
- rejected setup reasons
- final output signal
- downstream execution result references

Logs should support:
- debugging false positives
- post-trade review
- AI-assisted analysis later
- dashboard visualization

## 16. Suggested Default Config

```json
{
  "timeframes": {
    "entry": "5m",
    "confirm": "15m",
    "bias": "1h"
  },
  "indicators": {
    "emaFast": 9,
    "emaSlow": 21,
    "emaTrend": 50,
    "rsiLength": 14,
    "atrLength": 14,
    "macdFast": 12,
    "macdSlow": 26,
    "macdSignal": 9,
    "volumeLookback": 20
  },
  "thresholds": {
    "minScore": 65,
    "highConfidenceScore": 80,
    "maxSpreadPct": 0.15,
    "minVolumeRatio": 1.1,
    "minAtrPct": 0.2
  },
  "risk": {
    "defaultAtrStopMultiple": 1.5,
    "defaultAtrTargetMultiple": 2.5,
    "cooldownBarsAfterLoss": 3
  }
}
```

## 17. AI Roadmap

### 17.1 No-AI v1
v1 should be fully deterministic and explainable.

AI is not required for profitable operation in the first version.

### 17.2 AI-Assisted v2
AI should help with classification and optimization, not directly place trades initially.

Recommended AI use cases:
- regime classification enhancement
- anomaly detection
- strategy selection by environment
- threshold adaptation
- post-trade pattern clustering
- performance attribution
- filtering out low-quality setups

Examples:
- identify whether current market is trend, chop, breakout, liquidation event, or news shock
- disable mean reversion during violent expansion
- identify which hours and symbols respond best to which setups
- detect when spread/slippage conditions are abnormal

### 17.3 Avoid These AI Uses Early
Do not start with:
- raw next-candle prediction
- LLM-generated trade calls
- black-box autonomous trading
- continuously changing parameters without guardrails
- training on tiny datasets

## 18. Recommended Architecture

Modules:
- market data ingestion
- candle builder
- indicator engine
- regime classifier
- setup evaluator
- score engine
- risk filter layer
- signal publisher
- logging / analytics pipeline

Flow:
1. ingest live market data
2. update candles
3. compute indicators
4. classify regime
5. evaluate eligible setup types
6. score setup
7. run reject filters
8. emit signal or rejection
9. log everything

## 19. MVP Scope

MVP must include:
- OHLCV ingestion
- multi-timeframe candle support
- EMA trend filter
- MACD momentum confirmation
- RSI pullback logic
- VWAP bias
- ATR gate
- volume confirmation
- regime classification
- score engine
- structured output
- full logging
- backtest compatibility

Nice-to-have after MVP:
- ADX
- Bollinger compression
- order book imbalance
- open interest
- liquidation feeds
- AI-assisted regime labeling

## 20. Success Criteria

The analysis engine is successful when:
- it produces fewer low-quality trades in chop
- it emits explainable signals
- it supports reliable backtesting and live use with identical logic
- it shows positive expectancy after fees and slippage on selected pairs
- it can be extended with AI without rewriting the core system

## 21. Final Recommendation

Start with deterministic signals first.

The best first production setup is:
- higher timeframe bias
- EMA trend filter
- VWAP intraday bias
- RSI pullback trigger
- MACD histogram confirmation
- ATR-based volatility gate
- volume confirmation
- strict score threshold
- strict spread/slippage rejection

Add AI later as a supervisor and optimizer, not as the first trader.
