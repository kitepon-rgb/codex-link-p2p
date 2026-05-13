# syntax=docker/dockerfile:1
FROM node:20-alpine AS builder
WORKDIR /app
RUN corepack enable
COPY pnpm-workspace.yaml package.json tsconfig.base.json ./
COPY packages/protocol/package.json packages/protocol/tsconfig.json packages/protocol/tsconfig.build.json packages/protocol/
COPY packages/protocol/src packages/protocol/src
COPY services/relay/package.json services/relay/tsconfig.json services/relay/tsconfig.build.json services/relay/
COPY services/relay/src services/relay/src
RUN pnpm install --frozen-lockfile=false
RUN pnpm --filter @codex-link/protocol build
RUN pnpm --filter @codex-link/relay build

FROM node:20-alpine
WORKDIR /app
RUN corepack enable
COPY --from=builder /app/services/relay/dist ./services/relay/dist
COPY --from=builder /app/services/relay/package.json ./services/relay/
COPY --from=builder /app/packages/protocol/dist ./packages/protocol/dist
COPY --from=builder /app/packages/protocol/package.json ./packages/protocol/
COPY --from=builder /app/package.json ./
COPY --from=builder /app/pnpm-workspace.yaml ./

# protocol の dev-time exports は src/*.ts を指すため runtime では node が解釈できない.
# publishConfig の published-form exports を実体化してから prod install する.
RUN node -e "const fs=require('fs');const p='packages/protocol/package.json';const j=JSON.parse(fs.readFileSync(p,'utf8'));if(j.publishConfig){Object.assign(j,j.publishConfig);delete j.publishConfig;}fs.writeFileSync(p,JSON.stringify(j,null,2));"

RUN pnpm install --prod --frozen-lockfile=false
EXPOSE 3000
CMD ["node", "services/relay/dist/server.js"]
