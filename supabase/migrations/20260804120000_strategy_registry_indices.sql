-- strategy_registry + forward_trades — add composite indices for daemon polling
-- and trade history queries.
--
-- The tables were created in 20260803120000_strategy_registry.sql.
-- This migration adds the composite indices the forward-test daemon needs.

-- Composite index for daemon polling: "give me all gauntlet_passed +
-- forward_running entries for user X".
create index if not exists strategy_registry_user_status_idx
  on public.strategy_registry (user_id, status);

-- Composite index for trade history lookups ordered by entry_ts.
create index if not exists forward_trades_strategy_entry_idx
  on public.forward_trades (strategy_id, entry_ts);
