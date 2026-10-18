# ──────────────────────────────────────────────────────────────
# Multi-stage build for Next.js web app
# ──────────────────────────────────────────────────────────────
FROM node:20-alpine AS base

# ── Dependencies ─────────────────────────────────────────────
FROM base AS deps
RUN apk add --no-cache libc6-compat
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --ignore-scripts --include=dev
COPY prisma ./prisma/
RUN npx prisma generate
# Guarantee this path exists even if the engine cache ended up empty/elsewhere
# (e.g. a restricted network) — keeps the later COPY in the runner stage safe.
RUN mkdir -p /root/.cache/prisma

# ── Builder ──────────────────────────────────────────────────
FROM base AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build

# ── Runner ───────────────────────────────────────────────────
FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1

RUN addgroup --system --gid 1001 nodejs
RUN adduser --system --uid 1001 nextjs --home /home/nextjs
RUN mkdir -p /home/nextjs/.cache && chown -R nextjs:nodejs /home/nextjs
ENV HOME=/home/nextjs

# Copy only what's needed for production
COPY --from=builder /app/public ./public
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
COPY --from=builder /app/prisma ./prisma

# Full node_modules from the `deps` stage (not just @prisma/*): the `prisma`
# CLI (used below for `migrate deploy`) pulls in several small transitive
# packages of its own (e.g. `effect`) that Next.js's standalone output
# tracer doesn't include, since it only traces what the app itself imports.
# This also carries over the CLI's .wasm engine files intact.
COPY --from=deps /app/node_modules ./node_modules

# `.bin/prisma` is a symlink to ../prisma/build/index.js. Docker's COPY can
# dereference symlinks across stages, which breaks the CLI's relative lookup
# of its sibling .wasm engine files at runtime — so recreate it explicitly
# to guarantee it's a real symlink pointing at the copy above.
RUN rm -f ./node_modules/.bin/prisma && \
    ln -s ../prisma/build/index.js ./node_modules/.bin/prisma

# `prisma migrate deploy` needs a separate "schema-engine" binary that Prisma
# caches under $HOME/.cache/prisma (NOT inside node_modules). That download
# happened as root during the `deps` build stage. Without copying it here,
# the runtime `nextjs` user has an empty cache and `migrate deploy` tries to
# re-download it over the network on every container start — unreliable,
# and it silently blocks the app from ever reaching `node server.js`.
COPY --from=deps /root/.cache/prisma /home/nextjs/.cache/prisma
RUN chown -R nextjs:nodejs /home/nextjs/.cache/prisma

RUN mkdir -p /app/uploads && chown nextjs:nodejs /app/uploads

USER nextjs

EXPOSE 3000
ENV PORT=3000
ENV HOSTNAME="0.0.0.0"

CMD ["sh", "-c", "npx prisma migrate deploy && node server.js"]
