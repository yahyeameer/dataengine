# The DataEngine web app.
#
# alpine rather than slim, the opposite of the choice in services/hermes: this
# image installs no native numeric stack, and Next's only compiled dependency
# (SWC) ships a musl build. There is nothing here that would have to compile
# from source, so the smaller base is free.
#
# Three stages so the runtime image carries neither the source nor the full
# dependency tree -- only the standalone server Next emits, which is a few tens
# of megabytes against roughly a gigabyte for node_modules.

FROM node:22-alpine AS deps
WORKDIR /app
# Dependencies in their own layer, ahead of the source, so a code-only deploy
# reuses the cached install.
COPY package.json package-lock.json ./
RUN npm ci

FROM node:22-alpine AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .

# NEXT_PUBLIC_* is inlined into the client bundle at build time, not read at
# startup. These have to arrive as build args; passing them only as runtime
# environment (the obvious thing, and what the Hostinger panel invites) yields
# an image whose browser code has `undefined` for the Supabase URL and fails at
# the first query with no server-side error to find.
#
# Both are public by definition -- the URL and the publishable key are in the
# bundle either way -- so baking them in leaks nothing. SUPABASE_SECRET_KEY is
# deliberately absent here: it is read at runtime, in server code only, and must
# never enter a build layer where `docker history` would show it.
ARG NEXT_PUBLIC_SUPABASE_URL
ARG NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY
ENV NEXT_PUBLIC_SUPABASE_URL=$NEXT_PUBLIC_SUPABASE_URL \
    NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=$NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY

RUN npm run build

FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production

# Unprivileged, for the same reason as the agent: this process holds
# SUPABASE_SECRET_KEY, which bypasses RLS.
RUN addgroup -S nodejs -g 1001 && adduser -S nextjs -u 1001

# `standalone` traces the modules actually imported and writes a self-contained
# server.js. public/ and .next/static are not traced -- they are served from
# disk -- so they are copied separately.
COPY --from=builder /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static

USER nextjs

# 3100 to match `next dev -p 3100` and `next start -p 3100` in package.json, so
# a URL that works in development works here. The port is published to nothing:
# the reverse proxy reaches it over the compose network.
ENV PORT=3100 HOSTNAME=0.0.0.0
EXPOSE 3100

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:3100/').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
