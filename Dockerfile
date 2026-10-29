FROM oven/bun:1.4.2-slim AS dependencies
WORKDIR /app
COPY package.json bun.lock ./
COPY patches ./patches
RUN bun install --frozen-lockfile --ignore-scripts

# Bun 1.3.14 segfaulted inside `next build` while it collected page data
# (oven-sh/bun#36866), and its own panic handler then trapped — the SIGILL,
# exit 132, that killed the staging image build. So this stage runs on real Node.
# Bun still resolves and installs the dependency closure above, and the runner
# below still runs the app on Bun. Only the build itself moves.
#
# Bun is 1.4.2 because bun.lock is lockfile version 3 with scoped overrides
# (the CVE pins for undici, uuid and mysql2), which Bun 1.3 can neither parse
# nor apply.
#
# `node:22-trixie-slim` deliberately matches the Debian release of
# `oven/bun:1.4.2-slim` (trixie, checked in the runner), so the Prisma engines
# resolved here are the ones the runner can load. Dropping Bun from this stage
# also means `prisma generate`, `next typegen` and `tsc` now run under Node.
FROM node:22-trixie-slim AS builder
WORKDIR /app
# Bun has no V8 heap cap; Node sizes one from host memory and lands on 2GB in a
# container this size, which `tsc` exhausts outright (`Ineffective mark-compacts
# near heap limit`, exit 134). `.github/workflows/deploy-staging.yml` already
# raises this for `tsc` on the runner. Match that job's 8192 ceiling here.
ENV NODE_OPTIONS=--max-old-space-size=8192
COPY --from=dependencies /app/node_modules ./node_modules
COPY . .
# `tsconfig.json` includes `.next/types`, and `PageProps`/`LayoutProps`/`RouteContext`
# are globals Next generates there. `.dockerignore` excludes `.next`, so nothing the
# host generated reaches this stage — `next typegen` has to run here, before `tsc`,
# or every route-type global is `TS2304: Cannot find name`.
RUN node node_modules/prisma/build/index.js generate \
 && node node_modules/next/dist/bin/next typegen \
 && node node_modules/typescript/bin/tsc --noEmit
ENV NEXT_BUILD_SKIP_TYPECHECK=1 \
    NEXT_TELEMETRY_DISABLED=1
# Invoked through `node` and a real path, not `next build` and not `bun run build`.
# A `.bin` shim picks its interpreter back up from a shebang and `PATH`, and
# `oven/bun` ships a `node` that is a symlink to `bun` — being explicit is the point.
# NEXT_PUBLIC_* values are inlined into client bundles at build time. Pass per environment,
# e.g. --build-arg NEXT_PUBLIC_APP_URL=https://staging.devfathom.com. Empty keeps the fallback.
ARG NEXT_PUBLIC_APP_URL=
ENV NEXT_PUBLIC_APP_URL=$NEXT_PUBLIC_APP_URL
RUN AUTH_SECRET=container-build-only node node_modules/next/dist/bin/next build

FROM oven/bun:1.4.2-slim AS runner
WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    HOSTNAME=0.0.0.0 \
    PORT=3000
COPY package.json bun.lock prisma.config.ts ./
COPY patches ./patches
COPY prisma ./prisma
# The builder's Prisma engines are resolved for Debian trixie (node:22-trixie-slim).
RUN . /etc/os-release && test "$VERSION_CODENAME" = trixie
RUN chown bun:bun /app
USER bun
RUN bun install --production --frozen-lockfile --ignore-scripts
COPY --chown=bun:bun --from=builder /app/.next/standalone ./
COPY --chown=bun:bun --from=builder /app/.next/static ./.next/static
COPY --chown=bun:bun --from=builder /app/public ./public
COPY --chown=bun:bun --from=builder /app/scripts ./scripts
COPY --chown=bun:bun --from=builder /app/src ./src
# The staging demo seed reuses the pharmacy counter fixture ids (scripts/seed-staging-demo.ts).
COPY --chown=bun:bun --from=builder /app/tests/e2e/pharmacy-counter-fixture.ts ./tests/e2e/pharmacy-counter-fixture.ts
COPY --chown=bun:bun --from=builder /app/tsconfig.json ./tsconfig.json
EXPOSE 3000
CMD ["bun", "server.js"]
