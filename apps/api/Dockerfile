# Replay API + worker image. Build from the repository root:
#   docker build -f apps/api/Dockerfile -t replay-api .
# Run the API:      docker run --env-file .env -p 3001:3001 replay-api
# Run the worker:   docker run --env-file .env replay-api node apps/api/dist/worker.js
FROM node:22-alpine AS base
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
RUN pnpm install --frozen-lockfile --ignore-scripts

FROM deps AS build
COPY tsconfig.base.json ./
COPY apps/api apps/api
COPY packages packages
COPY targets/demo-shop targets/demo-shop
RUN pnpm --filter @replay/shared^... build && pnpm --filter @replay/api build

FROM base AS runtime
ENV NODE_ENV=production
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/apps/api/dist ./apps/api/dist
COPY --from=build /app/packages ./packages
COPY --from=build /app/targets ./targets
COPY --from=build /app/samples ./samples
WORKDIR /app
EXPOSE 3001
CMD ["node", "apps/api/dist/server.js"]
