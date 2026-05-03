FROM node:20-slim AS base
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable && corepack prepare pnpm@9.12.1 --activate
RUN apt-get update && apt-get install -y openssl && rm -rf /var/lib/apt/lists/*

WORKDIR /app

FROM base AS build
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml* ./
COPY packages/shared/package.json ./packages/shared/
COPY packages/agent/package.json ./packages/agent/
RUN pnpm install --frozen-lockfile=false

COPY packages/shared ./packages/shared
COPY packages/agent ./packages/agent
RUN pnpm --filter @hermes/shared prisma:generate
RUN pnpm --filter @hermes/shared build
RUN pnpm --filter @hermes/agent build

FROM base AS runtime
ENV NODE_ENV=production
COPY --from=build /app /app
WORKDIR /app/packages/agent
EXPOSE 3000
CMD ["sh", "-c", "cd /app/packages/shared && npx prisma db push --accept-data-loss --skip-generate && cd /app/packages/agent && node dist/index.js"]
