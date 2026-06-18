/**
 * DevFathom — realtime socket server.
 *
 * Lives in this repo alongside the Next.js app, but runs as its OWN process:
 * Next.js (on Vercel) is serverless and can't hold open websocket connections,
 * so this stateful Socket.IO relay must run on a long-running host
 * (Railway / Render / Fly / a VM) in production.
 *
 * Dev: started together with the web app via `bun dev` (see package.json).
 * It relays chat / typing / notification / presence events between clients;
 * persistence happens in the Next app via tRPC, this only broadcasts live.
 *
 * SECURITY MODEL (added):
 *  - Connections are UNTRUSTED until they present a valid, short-lived,
 *    HMAC-signed ticket (minted by /api/realtime-token from the NextAuth
 *    session). The identity comes from the verified ticket — NEVER from
 *    client-controlled handshake.query.
 *  - Every channel operation is authorized against ChannelMember in the DB, so
 *    a user can only join/read/post in channels they actually belong to
 *    (including private DMs).
 *  - All inbound payloads are validated (zod) and malformed events are dropped.
 *  - chat:message / chat:typing are rate-limited per socket.
 */
import 'dotenv/config';
import crypto from 'node:crypto';
import express from 'express';
import { createServer } from 'http';
import { Server, type Socket } from 'socket.io';
import cors from 'cors';
import { z } from 'zod';

// Prisma client for authorization checks (membership). Mirrors prisma/seed.ts.
// `socket-server/` and `prisma/` sit at the same depth, so the relative path to
// the generated client is identical; `bundler` module resolution + tsx resolve
// the extensionless import to src/generated/prisma/client.ts.
import { PrismaClient } from '../src/generated/prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import pg from 'pg';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

const app = express();
const server = createServer(app);

const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:3000';
// Dedicated port var so it never collides with Next.js's own PORT.
const PORT = process.env.SOCKET_PORT || 3001;

// Shared secret used to verify realtime tickets. MUST match the one the Next
// route signs with — resolved in the SAME order so both sides agree on the key.
// The trailing `|| ''` only makes the type `string`; the guard still throws
// when neither env var is set. Resolved in the SAME order as the Next route.
const TICKET_SECRET = process.env.SOCKET_SHARED_SECRET || process.env.AUTH_SECRET || '';
if (!TICKET_SECRET) {
  throw new Error(
    'SOCKET_SHARED_SECRET or AUTH_SECRET must be set to verify realtime tickets'
  );
}

app.use(cors({ origin: FRONTEND_URL, credentials: true }));
app.use(express.json());

// Socket.io setup
const io = new Server(server, {
  cors: {
    origin: FRONTEND_URL,
    methods: ['GET', 'POST'],
    credentials: true,
  },
});

// Track online users: userId -> the socketId currently representing presence.
const onlineUsers = new Map<string, string>();

// ---------------------------------------------------------------------------
// Inbound payload schemas. Anything that fails validation is dropped silently.
// ---------------------------------------------------------------------------
const channelIdSchema = z.string().min(1).max(255);

const messageSchema = z.object({
  channelId: z.string().min(1).max(255),
  // The live message blob is broadcast as-is (persistence is handled by tRPC in
  // the Next app); we only re-stamp the sender below.
  message: z.unknown(),
});

const typingSchema = z.object({
  channelId: z.string().min(1).max(255),
  userName: z.string().min(1).max(255),
});

const stopTypingSchema = z.object({
  channelId: z.string().min(1).max(255),
});

// ---------------------------------------------------------------------------
// Simple per-socket token-bucket rate limiter.
// ---------------------------------------------------------------------------
class TokenBucket {
  private tokens: number;
  private last: number;
  constructor(
    private readonly capacity: number,
    private readonly refillPerSec: number
  ) {
    this.tokens = capacity;
    this.last = Date.now();
  }
  /** Returns true if a token was available (and consumed), false otherwise. */
  tryConsume(): boolean {
    const now = Date.now();
    const elapsedSec = (now - this.last) / 1000;
    this.tokens = Math.min(this.capacity, this.tokens + elapsedSec * this.refillPerSec);
    this.last = now;
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return true;
    }
    return false;
  }
}

/**
 * Authorize a user against a channel via ChannelMember.
 * Fails CLOSED (returns false) on any DB error so a transient outage can never
 * accidentally grant access.
 */
async function isChannelMember(channelId: string, userId: string): Promise<boolean> {
  try {
    const member = await prisma.channelMember.findUnique({
      where: { channelId_userId: { channelId, userId } },
      select: { id: true },
    });
    return member !== null;
  } catch (err) {
    console.error('[socket] membership check failed', err);
    return false;
  }
}

// ---------------------------------------------------------------------------
// Auth middleware: verify the HMAC ticket BEFORE any event handlers run.
// handshake.query.userId is ignored entirely — identity comes from the ticket.
// ---------------------------------------------------------------------------
io.use((socket, next) => {
  try {
    const ticket = socket.handshake.auth?.ticket;
    if (typeof ticket !== 'string') {
      return next(new Error('unauthorized'));
    }

    const dot = ticket.indexOf('.');
    if (dot <= 0 || dot === ticket.length - 1) {
      return next(new Error('unauthorized'));
    }
    const payloadB64 = ticket.slice(0, dot);
    const sigB64 = ticket.slice(dot + 1);

    // Recompute the HMAC over the payload with the SAME secret the issuer used.
    const expectedSig = crypto
      .createHmac('sha256', TICKET_SECRET)
      .update(payloadB64)
      .digest();
    const providedSig = Buffer.from(sigB64, 'base64url');

    // timingSafeEqual throws on length mismatch — guard length first, and the
    // length guard itself prevents trivial truncation attacks.
    if (
      providedSig.length !== expectedSig.length ||
      !crypto.timingSafeEqual(providedSig, expectedSig)
    ) {
      return next(new Error('unauthorized'));
    }

    const payload = JSON.parse(
      Buffer.from(payloadB64, 'base64url').toString('utf8')
    ) as { userId?: unknown; exp?: unknown };

    if (
      typeof payload.userId !== 'string' ||
      payload.userId.length === 0 ||
      typeof payload.exp !== 'number' ||
      payload.exp <= Date.now()
    ) {
      return next(new Error('unauthorized'));
    }

    // Trusted, server-verified identity for the lifetime of this socket.
    socket.data.userId = payload.userId;
    return next();
  } catch {
    // Malformed ticket / bad base64 / bad JSON — reject.
    return next(new Error('unauthorized'));
  }
});

io.on('connection', (socket: Socket) => {
  // Set by the auth middleware above; guaranteed present here. Never read from
  // handshake.query.
  const userId: string = socket.data.userId;

  // Channels this socket has been AUTHORIZED to join (membership already
  // checked). Used to gate typing without a DB round-trip per keystroke, and
  // it's naturally freed when the socket disconnects.
  const joinedChannels = new Set<string>();

  // Per-socket rate limiters (GC'd with the connection on disconnect).
  const messageBucket = new TokenBucket(10, 5); // burst 10, ~5/s sustained
  const typingBucket = new TokenBucket(20, 10); // burst 20, ~10/s sustained

  // Presence uses the verified userId only.
  onlineUsers.set(userId, socket.id);
  // Send the full current roster ONCE, only to the joining socket. Avoids
  // fanning the whole roster to every connected socket on each connect.
  socket.emit('presence:init', { onlineUsers: Array.from(onlineUsers.keys()) });
  // Broadcast only a DELTA to everyone: this user just came online.
  io.emit('user:online', { userId, online: true });

  // Chat events --------------------------------------------------------------
  socket.on('chat:join', async (channelId: unknown) => {
    try {
      const parsed = channelIdSchema.safeParse(channelId);
      if (!parsed.success) return; // drop malformed
      // Authorize: only members may join (and thus receive) a channel's stream.
      if (!(await isChannelMember(parsed.data, userId))) return;
      socket.join(`channel:${parsed.data}`);
      joinedChannels.add(parsed.data);
    } catch (err) {
      console.error('[socket] chat:join error', err);
    }
  });

  socket.on('chat:leave', (channelId: unknown) => {
    try {
      const parsed = channelIdSchema.safeParse(channelId);
      if (!parsed.success) return;
      socket.leave(`channel:${parsed.data}`);
      joinedChannels.delete(parsed.data);
    } catch (err) {
      console.error('[socket] chat:leave error', err);
    }
  });

  socket.on('chat:message', async (data: unknown) => {
    try {
      if (!messageBucket.tryConsume()) return; // rate limit
      const parsed = messageSchema.safeParse(data);
      if (!parsed.success) return; // drop malformed
      const { channelId, message } = parsed.data;

      // Authorize freshly against the DB — do not rely on join state alone.
      if (!(await isChannelMember(channelId, userId))) return;

      // Stamp the server-known sender; NEVER trust a client-supplied sender id.
      // This prevents a member from broadcasting a live message attributed to
      // someone else.
      const safeMessage =
        message && typeof message === 'object'
          ? { ...(message as Record<string, unknown>), senderId: userId }
          : message;

      io.to(`channel:${channelId}`).emit('chat:message', safeMessage);
    } catch (err) {
      console.error('[socket] chat:message error', err);
    }
  });

  socket.on('chat:typing', (data: unknown) => {
    try {
      if (!typingBucket.tryConsume()) return; // rate limit
      const parsed = typingSchema.safeParse(data);
      if (!parsed.success) return;
      // Only broadcast typing into channels this socket actually joined (which
      // required a verified membership). Identity is the verified userId, not
      // any client-supplied value.
      if (!joinedChannels.has(parsed.data.channelId)) return;
      socket.to(`channel:${parsed.data.channelId}`).emit('chat:typing', {
        userId,
        userName: parsed.data.userName,
      });
    } catch (err) {
      console.error('[socket] chat:typing error', err);
    }
  });

  socket.on('chat:stop-typing', (data: unknown) => {
    try {
      const parsed = stopTypingSchema.safeParse(data);
      if (!parsed.success) return;
      if (!joinedChannels.has(parsed.data.channelId)) return;
      socket.to(`channel:${parsed.data.channelId}`).emit('chat:stop-typing', {
        userId,
      });
    } catch (err) {
      console.error('[socket] chat:stop-typing error', err);
    }
  });

  // Notification events ------------------------------------------------------
  // REMOVED: the old `notification:send` client-to-client relay.
  //
  // It let ANY connected client emit a notification to ANY other user with a
  // fully attacker-controlled payload — i.e. forge/spoof notifications. There
  // is no safe way to authorize "user A may notify user B" purely from a socket
  // event. Notifications must be created server-side (persisted + emitted) via
  // tRPC in the Next app, which already owns authorization and the data model.
  // The client still LISTENS for 'notification:new' (emitted by trusted
  // server-side code); we only drop the untrusted inbound relay.

  // Disconnect ---------------------------------------------------------------
  socket.on('disconnect', () => {
    // Only clear presence if THIS socket is the one currently recorded, so a
    // stale tab closing doesn't wipe out a newer tab's presence. Bounds the map.
    if (onlineUsers.get(userId) === socket.id) {
      onlineUsers.delete(userId);
      // Broadcast only a DELTA to everyone: this user just went offline.
      io.emit('user:offline', { userId, online: false });
    }
  });
});

// Health check
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', uptime: process.uptime(), connections: onlineUsers.size });
});

server.listen(PORT, () => {
  console.log(`\n🚀 DevFathom Socket Server running on port ${PORT}`);
  console.log(`   Frontend: ${FRONTEND_URL}`);
  console.log(`   Health: http://localhost:${PORT}/health\n`);
});
