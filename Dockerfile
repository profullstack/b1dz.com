# Multi-stage Dockerfile for b1dz.com
#
# Builds the entire pnpm workspace once. The final image contains both
# `apps/web` (Next.js) and `apps/daemon` (background runner). Choose which
# one to start at runtime by overriding CMD:
#
#   docker run b1dz pnpm start     # web/api server (default)
#   docker run b1dz pnpm daemon    # background daemon
#
# On Railway: deploy as TWO services from the same image (web + daemon),
# each with its own CMD set in the Railway dashboard.

FROM node:22-bookworm-slim AS base
ENV PNPM_HOME="/pnpm" \
    PATH="/pnpm:$PATH" \
    NEXT_TELEMETRY_DISABLED=1
RUN corepack enable && corepack prepare pnpm@10.0.0 --activate

# ---- deps ----
FROM base AS deps
WORKDIR /app
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY tsconfig.base.json turbo.json ./
COPY apps/web/package.json apps/web/
COPY apps/cli/package.json apps/cli/
COPY apps/daemon/package.json apps/daemon/
COPY apps/extension/package.json apps/extension/ 2>/dev/null || true
COPY packages/core/package.json packages/core/
COPY packages/sdk/package.json packages/sdk/
COPY packages/storage-json/package.json packages/storage-json/
COPY packages/storage-supabase/package.json packages/storage-supabase/
COPY packages/storage-b1dz-api/package.json packages/storage-b1dz-api/
COPY packages/source-dealdash/package.json packages/source-dealdash/
COPY packages/source-crypto-arb/package.json packages/source-crypto-arb/
COPY packages/source-crypto-trade/package.json packages/source-crypto-trade/
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile --ignore-scripts

# ---- build ----
FROM base AS build
WORKDIR /app
COPY --from=deps /app /app
COPY . .
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile --ignore-scripts
RUN pnpm --filter @b1dz/web build

# ---- runtime ----
FROM base AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app /app
EXPOSE 3000
# Default to the web server. Override CMD with `pnpm daemon` for the daemon.
CMD ["pnpm", "start"]
