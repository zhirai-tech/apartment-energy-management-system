FROM node:22-bookworm-slim AS builder

RUN apt-get update -y && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY server/package.json ./server/
COPY server/tsconfig.json ./server/
COPY server/prisma ./server/prisma
COPY server/src ./server/src
COPY shared ./shared

WORKDIR /app/server

RUN npm install --production=false
RUN npx prisma generate
RUN npm run build

FROM node:22-bookworm-slim AS runner

RUN apt-get update -y && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/*

WORKDIR /app

ENV NODE_ENV=production

COPY server/package.json ./server/
COPY server/prisma ./server/prisma
COPY --from=builder /app/server/dist/server/src ./server/dist
COPY --from=builder /app/server/dist/shared ./server/shared
COPY --from=builder /app/server/node_modules ./server/node_modules
COPY shared ./shared.orig

WORKDIR /app/server

RUN npm install --production
RUN npx prisma generate

RUN mkdir -p /shared /app/shared \
  && cp -rf /app/server/shared/* /shared/ 2>/dev/null || true \
  && cp -rf /app/server/shared/* /app/shared/ 2>/dev/null || true \
  && (cp /app/shared.orig/index.ts /shared/index.ts 2>/dev/null || true) \
  && ls /shared 2>/dev/null || true

EXPOSE 3001

CMD ["sh", "-c", "npx prisma migrate deploy; npx prisma db seed 2>/dev/null; node dist/index.js"]
