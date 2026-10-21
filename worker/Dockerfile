# ──────────────────────────────────────────────────────────────
# Standalone BullMQ worker — NOT inside Next.js
# ──────────────────────────────────────────────────────────────
FROM node:20-alpine AS base

FROM base AS deps
RUN apk add --no-cache libc6-compat
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --ignore-scripts --include=dev
# Worker has its own copy of prisma/ in its build context
COPY prisma ./prisma/
RUN npx prisma generate

FROM base AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

FROM base AS runner
WORKDIR /app
ENV NODE_ENV=production

RUN addgroup --system --gid 1001 worker
RUN adduser --system --uid 1001 worker

COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY --from=deps /app/prisma ./prisma
COPY --from=deps /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=deps /app/node_modules/@prisma ./node_modules/@prisma
COPY --from=deps /app/node_modules/.bin/prisma ./node_modules/.bin/prisma
COPY --from=deps /app/node_modules/prisma ./node_modules/prisma

# Same path + owner as the web image so the shared upload-data volume is
# writable no matter which container creates it first.
RUN mkdir -p /app/uploads && chown worker:worker /app/uploads

USER worker

CMD ["node", "dist/index.js"]
