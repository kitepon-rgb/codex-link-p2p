# syntax=docker/dockerfile:1
FROM node:20-alpine AS builder
WORKDIR /app
RUN corepack enable
COPY pnpm-workspace.yaml package.json tsconfig.base.json ./
COPY packages/protocol/package.json packages/protocol/tsconfig.json packages/protocol/
COPY packages/protocol/src packages/protocol/src
COPY services/relay/package.json services/relay/tsconfig.json services/relay/
COPY services/relay/src services/relay/src
RUN pnpm install --frozen-lockfile=false
RUN pnpm --filter @codex-link/relay build

FROM node:20-alpine
WORKDIR /app
RUN corepack enable
COPY --from=builder /app/services/relay/dist ./services/relay/dist
COPY --from=builder /app/services/relay/package.json ./services/relay/
COPY --from=builder /app/packages/protocol ./packages/protocol
COPY --from=builder /app/package.json ./
COPY --from=builder /app/pnpm-workspace.yaml ./
RUN pnpm install --prod --frozen-lockfile=false
EXPOSE 3000
CMD ["node", "services/relay/dist/server.js"]
