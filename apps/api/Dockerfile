# Replay API + worker image (Playwright-capable, Debian).
# Build from the repository root:
#   docker build -f apps/api/Dockerfile -t replay-api .
# The Playwright image version must match @playwright/test in targets/demo-shop.
FROM mcr.microsoft.com/playwright:v1.50.1-noble AS base
RUN corepack enable
WORKDIR /app

FROM base AS deps
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps/api/package.json apps/api/
COPY packages/agents/package.json packages/agents/
COPY packages/db/package.json packages/db/
COPY packages/sandbox/package.json packages/sandbox/
COPY packages/shared/package.json packages/shared/
COPY packages/storage/package.json packages/storage/
COPY packages/video/package.json packages/video/
COPY targets/demo-shop/package.json targets/demo-shop/
RUN pnpm install --frozen-lockfile

FROM deps AS build
COPY tsconfig.base.json ./
COPY apps/api apps/api
COPY packages packages
COPY targets/demo-shop targets/demo-shop
# Build the API and every workspace package it depends on.
RUN pnpm --filter "@replay/api..." build

FROM base AS runtime
ENV NODE_ENV=production
# ffmpeg for live frame extraction
USER root
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg \
    && rm -rf /var/lib/apt/lists/*
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/apps/api/dist ./apps/api/dist
COPY --from=build /app/packages ./packages
COPY --from=build /app/targets ./targets
COPY --from=build /app/samples ./samples
# Writable artifact dirs for the non-root user (uploads, run artifacts).
# The Playwright image ships a non-root user `pwuser` (uid 1000).
RUN mkdir -p /app/artifacts/uploads /app/artifacts/runs \
    && chown -R pwuser:pwuser /app/artifacts /app
USER pwuser
WORKDIR /app
ENV REPLAY_DATA_DIR=/app/artifacts
EXPOSE 3001
CMD ["node", "apps/api/dist/server.js"]
