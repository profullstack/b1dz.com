# Multi-stage Dockerfile for b1dz.com
#
# Builds the entire pnpm workspace once. The final image contains both
# `apps/web` (Next.js API + dashboard) and `apps/daemon` (trading engine).
#
# Choose which service to start at runtime:
#   docker run b1dz pnpm start     # web/api server (default)
#   docker run b1dz pnpm daemon    # trading daemon
#
# On Railway: deploy as TWO services from the same image, each with
# its own CMD set in the Railway dashboard.

FROM node:22-bookworm-slim AS base
ENV PNPM_HOME="/pnpm" \
    PATH="/pnpm:$PATH" \
    NEXT_TELEMETRY_DISABLED=1
# Install curl for the Binance.US proxy and redis-server for shared runtime cache.
RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates redis-server && rm -rf /var/lib/apt/lists/*
RUN corepack enable && corepack prepare pnpm@10.0.0 --activate

# ---- deps ----
FROM base AS deps
WORKDIR /app
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY tsconfig.base.json turbo.json ./
COPY apps/web/package.json apps/web/
COPY apps/cli/package.json apps/cli/
COPY apps/daemon/package.json apps/daemon/
COPY packages/core/package.json packages/core/
COPY packages/sdk/package.json packages/sdk/
COPY packages/storage-json/package.json packages/storage-json/
COPY packages/storage-supabase/package.json packages/storage-supabase/
COPY packages/storage-b1dz-api/package.json packages/storage-b1dz-api/
COPY packages/source-dealdash/package.json packages/source-dealdash/
COPY packages/source-crypto-arb/package.json packages/source-crypto-arb/
COPY packages/source-crypto-trade/package.json packages/source-crypto-trade/
COPY packages/venue-types/package.json packages/venue-types/
COPY packages/profitability/package.json packages/profitability/
COPY packages/event-channel/package.json packages/event-channel/
COPY packages/observe-engine/package.json packages/observe-engine/
COPY packages/trade-daemon/package.json packages/trade-daemon/
COPY packages/adapters-cex/package.json packages/adapters-cex/
COPY packages/adapters-evm/package.json packages/adapters-evm/
COPY packages/adapters-solana/package.json packages/adapters-solana/
COPY packages/wallet-service/package.json packages/wallet-service/
COPY packages/wallet-provider/package.json packages/wallet-provider/
COPY packages/wallet-direct/package.json packages/wallet-direct/
COPY packages/wallet-coinpay/package.json packages/wallet-coinpay/
COPY packages/inventory/package.json packages/inventory/
RUN pnpm install --frozen-lockfile --ignore-scripts

# ---- build ----
FROM base AS build
WORKDIR /app
COPY --from=deps /app /app
COPY . .
RUN pnpm install --frozen-lockfile --ignore-scripts
# Build packages first (daemon depends on them), then web
RUN pnpm --filter @b1dz/core build && \
    pnpm --filter @b1dz/sdk build && \
    pnpm --filter @b1dz/storage-json build && \
    pnpm --filter @b1dz/storage-supabase build && \
    pnpm --filter @b1dz/storage-b1dz-api build && \
    pnpm --filter @b1dz/source-crypto-arb build && \
    pnpm --filter @b1dz/source-crypto-trade build && \
    pnpm --filter @b1dz/daemon build
ARG NEXT_PUBLIC_SUPABASE_URL=https://hnohaxemomzlpfnoidhp.supabase.co
ARG NEXT_PUBLIC_SUPABASE_ANON_KEY=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imhub2hheGVtb216bHBmbm9pZGhwIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzU2NTE1NDEsImV4cCI6MjA5MTIyNzU0MX0.AWBlZtFytM5vNzUH7NyWgBLFzpNWN7UhsBIjwyC44KI
ARG NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=sb_publishable_8WgKipIZGdvBaz-5s9nqyQ_JK7Ynjy4
RUN NEXT_PUBLIC_SUPABASE_URL=$NEXT_PUBLIC_SUPABASE_URL \
    NEXT_PUBLIC_SUPABASE_ANON_KEY=$NEXT_PUBLIC_SUPABASE_ANON_KEY \
    NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=$NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY \
    pnpm --filter @b1dz/web build

# ---- runtime ----
FROM base AS runtime
WORKDIR /app
ENV NODE_ENV=production
# v3
COPY --from=build /app /app
EXPOSE 8080
# Start both web API and daemon under a small supervisor so if either dies,
# the container exits and Railway/Docker can restart it.
CMD ["bash", "./scripts/start-railway.sh"]
