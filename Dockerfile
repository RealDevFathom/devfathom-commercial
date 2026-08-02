FROM oven/bun:1.3.14-slim AS dependencies
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --ignore-scripts

FROM dependencies AS builder
COPY . .
RUN bunx prisma generate && bun run typecheck
ENV NEXT_BUILD_SKIP_TYPECHECK=1 \
    NEXT_TELEMETRY_DISABLED=1
RUN AUTH_SECRET=container-build-only bun run build

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
