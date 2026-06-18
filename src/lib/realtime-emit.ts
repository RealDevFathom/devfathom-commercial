/**
 * Backend → socket bridge.
 *
 * After a chat mutation persists, the router calls these helpers to broadcast
 * the change to connected clients via the standalone Socket.IO server's
 * authenticated `/emit` endpoint (shared-secret).
 *
 * Fire-and-forget: never throws into the caller — the user's write already
 * succeeded, so a failed broadcast must not surface an error (mirrors notify()).
 * If the socket bridge isn't configured (no secret), every call is a silent
 * no-op, so local web-only dev still works.
 */
import { channelRoom, userRoom } from '@/lib/chat/contract';

const SOCKET_URL =
  process.env.SOCKET_INTERNAL_URL || process.env.NEXT_PUBLIC_SOCKET_URL || 'http://localhost:3001';

const SECRET = process.env.SOCKET_SHARED_SECRET || process.env.AUTH_SECRET || '';

interface EmitBody {
  room: string;
  event: string;
  payload: unknown;
}

/** Broadcast an event to a raw socket room. */
export function emitToRoom(room: string, event: string, payload: unknown): void {
  void post({ room, event, payload }).catch((err) =>
    console.error('[realtime-emit] failed', event, room, err)
  );
}

/** Broadcast to everyone in a channel (`channel:{id}` room). */
export function emitToChannel(channelId: string, event: string, payload: unknown): void {
  emitToRoom(channelRoom(channelId), event, payload);
}

/** Broadcast to one user across all their devices (`user:{id}` room). */
export function emitToUser(userId: string, event: string, payload: unknown): void {
  emitToRoom(userRoom(userId), event, payload);
}

/** Broadcast to several users' personal rooms (deduped). */
export function emitToUsers(userIds: string[], event: string, payload: unknown): void {
  for (const id of new Set(userIds.filter(Boolean))) emitToUser(id, event, payload);
}

async function post(body: EmitBody): Promise<void> {
  if (!SECRET) return; // bridge not configured → no-op
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 2000);
  try {
    const res = await fetch(`${SOCKET_URL}/emit`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-emit-secret': SECRET },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`emit responded ${res.status}`);
  } finally {
    clearTimeout(timeout);
  }
}
