FROM oven/bun:1.3.14-slim AS dependencies
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --ignore-scripts

# Bun 1.3.14 segfaults inside `next build` while it collects page data
# (oven-sh/bun#36866), and its own panic handler then traps — that is the SIGILL,
# exit 132, that kills the staging image build. So this stage runs on real Node.
# Bun still resolves and installs the dependency closure above, and the runner
# below still runs the app on Bun. Only the build itself moves.
#
# `node:22-trixie-slim` deliberately matches the Debian release of
# `oven/bun:1.3.14-slim`, so the Prisma engines resolved here are the ones the
# runner can load. Dropping Bun from this stage also means `prisma generate`,
# `next typegen` and `tsc` now run under Node.
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
RUN AUTH_SECRET=container-build-only node node_modules/next/dist/bin/next build

FROM oven/bun:1.3.14-slim AS runner
WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    HOSTNAME=0.0.0.0 \
    PORT=3000
COPY package.json bun.lock prisma.config.ts ./
COPY prisma ./prisma
RUN chown bun:bun /app
USER bun
RUN bun install --production --frozen-lockfile --ignore-scripts
COPY --chown=bun:bun --from=builder /app/.next/standalone ./
COPY --chown=bun:bun --from=builder /app/.next/static ./.next/static
COPY --chown=bun:bun --from=builder /app/public ./public
COPY --chown=bun:bun --from=builder /app/scripts ./scripts
COPY --chown=bun:bun --from=builder /app/src ./src
COPY --chown=bun:bun --from=builder /app/tsconfig.json ./tsconfig.json
EXPOSE 3000
CMD ["bun", "server.js"]
