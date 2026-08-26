# syntax=docker/dockerfile:1

# ---------- 构建阶段 ----------
FROM node:22-bookworm-slim AS builder

RUN apt-get update -y \
  && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY server/package.json server/tsconfig.json ./server/
COPY server/prisma ./server/prisma
COPY server/src ./server/src
COPY shared ./shared

WORKDIR /app/server

RUN npm install
RUN npx prisma generate
RUN npm run build

# ---------- 运行阶段 ----------
FROM node:22-bookworm-slim AS runner

RUN apt-get update -y \
  && apt-get install -y --no-install-recommends openssl ca-certificates ffmpeg \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app/server

ENV NODE_ENV=production

COPY server/package.json server/tsconfig.json ./
COPY server/prisma ./prisma
COPY shared /app/shared
COPY --from=builder /app/server/node_modules ./node_modules
COPY --from=builder /app/server/dist ./dist

EXPOSE 3001

CMD ["sh", "-c", "npx prisma migrate deploy && npx prisma db seed && node dist/server/src/index.js"]
