# DevFathom — Socket.IO realtime relay.
#
# Runs the standalone server (socket-server/index.ts) from this repo on a
# long-running host. Vercel can't hold persistent websockets; this container
# can. Built for Koyeb (also works on Fly / Render / any Docker host).
#
# The server is a thin relay: presence + typing + fan-out of events. Message
# persistence happens in the Next app via tRPC/Postgres, not here.
FROM oven/bun:1

WORKDIR /app

# Copy source first so the Prisma schema is present when `prisma generate`
# runs. Deps for the socket server (express, socket.io, cors, zod, pg,
# @prisma/adapter-pg, prisma) all live in "dependencies".
COPY . .
RUN bun install --frozen-lockfile && bunx prisma generate

ENV NODE_ENV=production

# Managed hosts inject PORT (Koyeb defaults to 8000); the server binds to it
# (see socket-server/index.ts: SOCKET_PORT || PORT || 3001).
EXPOSE 8000

CMD ["bun", "socket-server/index.ts"]
