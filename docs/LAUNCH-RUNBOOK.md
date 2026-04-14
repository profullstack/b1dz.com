# b1dz Launch Runbook

End-to-end checklist for going from "code merged" to "live trading on
Base with $5 size caps".

The system is built in three concentric rings — you can ship each
ring independently:

1. **Observe** — quotes + ranking, no execution. Safe to deploy first.
2. **Paper** — full daemon flow, simulated fills, no real money.
3. **Live** — actual trades on real chains. Wallet money at risk.

Each ring uses the same code. The `MODE` env var (or `--mode` CLI
flag) selects which.

---

## Pre-flight

### 1. Workspace sanity

```bash
pnpm install
pnpm -r typecheck    # zero errors expected
pnpm -r test --run   # 21 test files, 400+ tests, all pass
```

If anything fails here, do not proceed.

### 2. Environment variables

The minimum to run **observe** mode:

```env
NODE_ENV=production
LOG_LEVEL=info
MODE=observe

# CEX (read-only quote API auth)
COINBASE_API_KEY=
COINBASE_API_SECRET=
KRAKEN_API_KEY=
KRAKEN_API_SECRET=
BINANCE_US_API_KEY=
BINANCE_US_API_SECRET=
GEMINI_API_KEY=
GEMINI_API_SECRET=

# EVM (RPC for quotes — public RPCs work, paid ones recommended)
BASE_RPC_URL=https://mainnet.base.org
ETHEREUM_RPC_URL=https://eth.llamarpc.com
AVALANCHE_RPC_URL=https://api.avax.network/ext/bc/C/rpc
ZEROX_API_KEY=     # optional but rate-limit relief
ONEINCH_API_KEY=   # optional but rate-limit relief

# Solana (RPC for Jupiter quote latency check)
SOLANA_RPC_URL=https://api.mainnet-beta.solana.com

# Supabase (event channel + opportunity log persistence)
NEXT_PUBLIC_SUPABASE_URL=
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=
SUPABASE_SECRET_KEY=
```

For **paper** mode, add nothing — paper trades don't touch wallets.

For **live** mode, add the wallet config (next section).

### 3. Database migrations

Migrations live in `supabase/migrations/`. To apply against the linked
project (`hnohaxemomzlpfnoidhp`):

```bash
supabase db push --linked
```

Verify with `supabase migration list --linked`. Local matches Remote
on every row, both columns identical.

---

## Ring 1: Observe-only deployment

Goal: see what opportunities the bot finds against production venues
*without* executing anything. Run for at least 24h before promoting.

### Start the stack

```bash
MODE=observe pnpm dev:cli observe         # streaming observer
MODE=observe pnpm dev:daemon              # daemon in observe mode
```

The observer:
- fetches quotes from all enabled CEX + EVM + Solana + Pump.fun
- ranks opportunities through the profitability engine
- assigns `OpportunityExecutionMeta` (realizability, MEV risk,
  recommended execution mode)
- publishes ranked candidates to the event channel

The daemon in observe mode:
- claims items from the channel
- runs full risk + execution-mode policy
- always resolves with `status=rejected` and a clear reason
- never touches a wallet

### What to watch

| Signal | Where | Healthy looks like |
|---|---|---|
| Opportunities/min | Observer logs | `>5/min` during US market hours |
| Reject reasons | Daemon logs | mix of `net <`, `realizability <`, `requires private` — not 100% one reason |
| Quote latency | Adapter health checks | `<500ms` per venue, `<1s` for Pump.fun discovery |
| Realizability score distribution | Daemon logs | bimodal: high for L2/CEX, low for mainnet dex↔dex |
| Net edge after costs | Channel resolved-reason field | want `>$2` net on at least one route per hour |

### Promote criteria

Move to ring 2 only when:
- ≥24h continuous run with no crashes
- Observer + daemon stayed in sync (no growing channel backlog)
- At least 5 unique routes hit `executable=true` with realizability `>0.6`
- No realized RPC outage on any provider for the full window

---

## Ring 2: Paper-mode deployment

Goal: prove the daemon's risk gates accept the right opportunities and
the channel-resolution flow stays consistent under load. Still no
real money.

```bash
MODE=paper pnpm dev:daemon
```

Paper mode:
- runs the same risk + execution-mode policy as live
- marks accepted opportunities as `filled` with `paper fill expected=$X`
- does **not** call any executor (no wallet activity)

### What to watch

- **Acceptance rate** — what % of items the daemon accepts vs rejects.
  Too high (>20%) suggests risk limits are too loose for real
  capital. Too low (<1%) suggests they're too strict.
- **Expected vs realized edge** — paper assumes optimistic fill at
  the quoted price. Compare `expectedNetUsd` against what live mode
  *would have* gotten if the route remained available 5–30s later.
  This is a manual eyeballing exercise until the post-trade variance
  reporter lands.

### Promote criteria

Move to ring 3 only when:
- ≥48h paper run, ≥10 accepted opportunities
- Acceptance rate stable in the 1–10% range
- No `decideOpportunity` panic / unhandled exception in logs

---

## Ring 3: Live execution (Base, $5 trades)

Goal: prove every lego works end-to-end with real but tiny size.

### Wallet setup

You need:
- a hot wallet on Base with **at most $20 USDC + $20 worth of ETH**
- the EVM private key in `EVM_PRIVATE_KEY` (env, never committed)
- approval already granted on the venues you plan to use
  (the daemon will request it on first use; you can also pre-approve)

Add to env:

```env
MODE=live
EVM_PRIVATE_KEY=0x...
WALLET_PROVIDER=direct-evm

# Risk caps — KEEP THESE TIGHT FOR FIRST RUN
MAX_TRADE_USD=5
MIN_NET_PROFIT_USD=0.50
MIN_NET_PROFIT_BPS=50
MAX_GAS_USD=1
MAX_SLIPPAGE_BPS=30
MAX_ROUTE_HOPS=2

# Execution mode — start in public-only on Base (it's not a high-MEV
# chain). Private/bundle support is a later ring.
EXECUTION_MODE=public
REJECT_PUBLIC_HIGH_MEV_ROUTES=true

# Circuit breaker — trip on 3 failures or $10 daily loss
CIRCUIT_MAX_FAILURES=3
CIRCUIT_MAX_DAILY_LOSS_USD=10
```

### Wire the daemon

The daemon needs an `Executor` for the categories you want to trade.
For Base-only EVM live trading, wire the wallet-service as the
executor:

```typescript
// apps/daemon/src/main.ts (excerpt)
import { TradeDaemon } from '@b1dz/trade-daemon';
import { WalletService } from '@b1dz/wallet-service';
import { DirectEvmWalletProvider } from '@b1dz/wallet-direct';
import { ViemGasOracle } from '@b1dz/adapters-evm';
import { InventoryLedger, EvmWalletBalanceSource } from '@b1dz/inventory';
import { SupabaseEventChannel } from '@b1dz/event-channel';
import { createPublicClient, http } from 'viem';
import { base } from 'viem/chains';

const baseClient = createPublicClient({ chain: base, transport: http(process.env.BASE_RPC_URL) });
const wallet = new DirectEvmWalletProvider();
const gasOracle = new ViemGasOracle({ clients: { base: baseClient } });

const inventory = new InventoryLedger({
  sources: [new EvmWalletBalanceSource({
    venue: 'hot-evm',
    wallet: await wallet.getAddress('base'),
    clients: { base: baseClient },
    tokens: {
      base: {
        ETH: { address: '0x0', isNative: true },
        USDC: { address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', isNative: false },
      },
    },
  })],
});

const walletSvc = new WalletService({
  clients: { base: baseClient },
  walletProvider: wallet,
  gasOracle,
});

// Implement an Executor for your strategy:
const executor = {
  canExecute: (opp) => opp.buyChain === 'base' || opp.sellChain === 'base',
  execute: async (opp) => {
    // Build calldata for the swap from the opportunity's quotes
    // (this is venue-specific — see packages/adapters-evm/src/uniswap-v3.ts
    // routerAddress() and quoterAddress() helpers)
    const result = await walletSvc.execute({
      chain: 'base',
      from: await wallet.getAddress('base'),
      to: /* router address from opp.buyQuote.raw */,
      data: /* encoded swap calldata */,
      value: opp.buyQuote.baseAsset === 'ETH' ? toWei(opp.size) : 0n,
      gasLimit: 250_000n,
    });
    return {
      status: result.status === 'aborted' ? 'aborted' : result.status,
      resolvedReason: result.resolvedReason,
      externalId: result.txHash ?? undefined,
    };
  },
};

const daemon = new TradeDaemon({
  channel: new SupabaseEventChannel({ /* … */ }),
  mode: 'live',
  risk: { maxTradeUsd: 5, minNetUsd: 0.5, minNetBps: 50 },
  executors: [executor],
  inventory: {
    canAfford: async (opp) => {
      // Refresh + check the asset we'll spend
      const need = opp.side === 'buy' ? opp.buyQuote.quoteAsset : opp.buyQuote.baseAsset;
      await inventory.refresh({ venue: 'hot-evm', chain: 'base', token: need });
      return inventory.canAfford({ venue: 'hot-evm', chain: 'base', token: need }, /* base units */);
    },
  },
});

daemon.start();
```

### Smoke test sequence

1. **Empty wallet test** — start the daemon with $0 in the wallet.
   Confirm every executable opportunity gets aborted with
   `inventory: need X USDC, have 0 free`. No tx submitted.

2. **Funded wallet, observe one cycle** — fund $20 USDC + $5 ETH. Run
   for one tick, then immediately stop. Confirm:
   - daemon picked at least one opportunity
   - inventory check passed
   - executor was invoked
   - tx hash appears in logs
   - receipt tracker resolved (filled / reverted / stuck)

3. **Run for 1 hour** — fill rate should be `<10%` of accepted
   opportunities (most legitimate routes will have moved by submission
   time). Watch the circuit breaker — if it trips, investigate
   before resetting.

### What to watch in live

| Metric | Where | Action |
|---|---|---|
| Tx hash + block | Daemon logs | spot-check on basescan.org |
| Realized PnL per fill | Manual diff of inventory before/after | should match `expectedNetUsd` ± gas surprise |
| Circuit state | `daemon.getCircuit().status()` | if `state=open` — stop, read `trip.reason`, fix root cause before resetting |
| Wallet balance | `inventory.snapshot()` | should never go to zero (keep ETH for gas) |

### Kill switches

The daemon trips its circuit automatically on:
- 3 consecutive executor failures (revert / stuck / aborted)
- $10 realized daily loss

External signals you may want to wire:
- gas spike via `gasOracle.getFeeData()` ratio vs baseline
- RPC degradation (5xx rate, timeout rate)
- approval stuck state (`checkApproval()` returning needed=true on
  the same (token, spender) for >5 min)

Manual reset: `daemon.getCircuit().reset()`.

---

## Rollback

If anything goes wrong in live:

1. **Stop the daemon** — `daemon.stop()` or kill the process.
2. **Withdraw funds** — move the hot wallet's balance to a cold wallet
   manually via your usual signer.
3. **Investigate** — read the channel for the last 10 resolved items
   (`channel.inspect('failed')`, `channel.inspect('rejected')`).
4. **Drop back to paper** — change `MODE=paper`, restart, run for
   another 24h before retrying live.

---

## Known gaps before "real" launch

These don't block first-light testing on Base but should land before
any meaningful capital deployment:

- **Inventory writes are not yet auto-triggered by execution** — the
  daemon doesn't call `inventory.markPending()` / `settle()` after
  the executor returns. Wire those in your Executor implementation.
- **No automatic gas-spike circuit trip** — currently only
  consecutive-failures + daily-loss trip. Add a hook that reads
  `gasOracle.getFeeData()` each tick and trips on `isGasSpike()`.
- **Solana live execution** — modules ship in `@b1dz/adapters-solana`
  (`signAndSendJupiterTx`, `trackSolanaTransaction`) but no executor
  wraps them yet. Mirror the EVM pattern when you're ready.
- **Approval auto-prompt** — `approvalManager.checkApproval()` is
  available but the executor must call it before the swap and submit
  the approval tx separately.
- **Pump.fun live** — observe + paper only. Live requires the rule
  engine (PRD §17.2 / §17.3) which is not yet built.
