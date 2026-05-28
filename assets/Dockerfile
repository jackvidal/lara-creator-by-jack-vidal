# Lara Creator — multi-stage Docker build for Railway.
#
# Three stages: deps (install npm packages), build (compile Next.js standalone),
# runner (final production image with only the necessary files).
#
# Key invariants:
#   - alpine + libc6-compat + openssl on every stage (Prisma binaries depend on these)
#   - Prisma engine binaries copied EXPLICITLY into the runner — Next standalone misses them
#   - non-root user in runner (security)
#   - HOSTNAME=0.0.0.0 so Railway healthcheck can reach the process

# ─── Stage 1: deps ────────────────────────────────────────────────
FROM node:22-alpine AS deps
RUN apk add --no-cache libc6-compat openssl
WORKDIR /app

COPY package.json package-lock.json* ./
COPY prisma ./prisma
# postinstall script (`prisma generate`) needs the schema present.
RUN npm ci --include=dev

# ─── Stage 2: build ───────────────────────────────────────────────
FROM node:22-alpine AS builder
RUN apk add --no-cache libc6-compat openssl
WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/node_modules/.prisma ./node_modules/.prisma
COPY . .

# Next.js inlines NEXT_PUBLIC_* env vars at build time.
# Other secrets are runtime-only — Railway injects them when the container starts.
ARG NEXT_PUBLIC_APP_URL
ENV NEXT_PUBLIC_APP_URL=${NEXT_PUBLIC_APP_URL}

# Skip telemetry, produce standalone output.
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build

# ─── Stage 3: runner (production image) ──────────────────────────
FROM node:22-alpine AS runner
RUN apk add --no-cache libc6-compat openssl
WORKDIR /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
# Bind to all interfaces so Railway's healthcheck can reach us.
ENV HOSTNAME=0.0.0.0

RUN addgroup --system --gid 1001 nodejs && \
    adduser --system --uid 1001 nextjs

# Copy ONLY what standalone needs.
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
COPY --from=builder --chown=nextjs:nodejs /app/public ./public
# Prisma engine binaries — standalone bundling misses these. Without these
# three COPYs you get "Cannot find module @prisma/engines" at runtime.
COPY --from=builder --chown=nextjs:nodejs /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=builder --chown=nextjs:nodejs /app/node_modules/@prisma/client ./node_modules/@prisma/client
COPY --from=builder --chown=nextjs:nodejs /app/node_modules/@prisma/engines ./node_modules/@prisma/engines

USER nextjs
EXPOSE 3000

CMD ["node", "server.js"]
