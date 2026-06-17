/**
 * Company Hub — realtime socket server.
 *
 * Lives in this repo alongside the Next.js app, but runs as its OWN process:
 * Next.js (on Vercel) is serverless and can't hold open websocket connections,
 * so this stateful Socket.IO relay must run on a long-running host
 * (Railway / Render / Fly / a VM) in production.
 *
 * Dev: started together with the web app via `npm run dev` (see package.json).
 * It relays chat / typing / notification / presence events between clients;
 * persistence happens in the Next app via tRPC, this only broadcasts live.
 */
import 'dotenv/config';
import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import cors from 'cors';

const app = express();
const server = createServer(app);

const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:3000';
// Dedicated port var so it never collides with Next.js's own PORT.
const PORT = process.env.SOCKET_PORT || 3001;

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

// Track online users
const onlineUsers = new Map<string, string>(); // userId -> socketId

io.on('connection', (socket) => {
  const userId = socket.handshake.query.userId as string;

  if (userId) {
    onlineUsers.set(userId, socket.id);
    io.emit('user:online', { userId, onlineUsers: Array.from(onlineUsers.keys()) });
  }

  // Chat events
  socket.on('chat:join', (channelId: string) => {
    socket.join(`channel:${channelId}`);
  });

  socket.on('chat:leave', (channelId: string) => {
    socket.leave(`channel:${channelId}`);
  });

  socket.on('chat:message', (data: { channelId: string; message: unknown }) => {
    io.to(`channel:${data.channelId}`).emit('chat:message', data.message);
  });

  socket.on('chat:typing', (data: { channelId: string; userId: string; userName: string }) => {
    socket.to(`channel:${data.channelId}`).emit('chat:typing', {
      userId: data.userId,
      userName: data.userName,
    });
  });

  socket.on('chat:stop-typing', (data: { channelId: string; userId: string }) => {
    socket.to(`channel:${data.channelId}`).emit('chat:stop-typing', {
      userId: data.userId,
    });
  });

  // Notification events
  socket.on('notification:send', (data: { userId: string; notification: unknown }) => {
    const targetSocket = onlineUsers.get(data.userId);
    if (targetSocket) {
      io.to(targetSocket).emit('notification:new', data.notification);
    }
  });

  // Disconnect
  socket.on('disconnect', () => {
    if (userId) {
      onlineUsers.delete(userId);
      io.emit('user:offline', { userId, onlineUsers: Array.from(onlineUsers.keys()) });
    }
  });
});

// Health check
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', uptime: process.uptime(), connections: onlineUsers.size });
});

server.listen(PORT, () => {
  console.log(`\n🚀 Company Hub Socket Server running on port ${PORT}`);
  console.log(`   Frontend: ${FRONTEND_URL}`);
  console.log(`   Health: http://localhost:${PORT}/health\n`);
});
