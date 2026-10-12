/**
 * Backend → realtime bridge (Ably REST).
 *
 * After a chat mutation persists, the router calls these helpers to broadcast
 * the change to connected clients by publishing to an Ably channel. The Next
 * app holds the Ably API key (full capability), so it — and only it — publishes
 * to the subscribe-only `channel:{id}` / `user:{id}` channels. Clients can never
 * forge these events.
 *
 * Fire-and-forget: never throws into the caller — the user's write already
 * succeeded, so a failed broadcast must not surface an error (mirrors notify()).
 * If Ably isn't configured (no API key), every call is a silent no-op, so local
 * web-only dev still works.
 */
import * as Ably from 'ably';
import { channelRoom, userRoom } from '@/lib/chat/contract';

const ABLY_API_KEY = process.env.ABLY_API_KEY;

let rest: Ably.Rest | null = null;
function getRest(): Ably.Rest | null {
  if (!ABLY_API_KEY) return null;
  if (!rest) rest = new Ably.Rest(ABLY_API_KEY);
  return rest;
}

/** Broadcast an event to a raw channel name. */
export function emitToRoom(room: string, event: string, payload: unknown): void {
  const client = getRest();
  if (!client) return; // bridge not configured → no-op
  void client.channels
    .get(room)
    .publish(event, payload)
    .catch((err) => console.error('[realtime-emit] failed', event, room, err));
}

/** Broadcast to everyone subscribed to a channel (`channel:{id}`). */
export function emitToChannel(channelId: string, event: string, payload: unknown): void {
  emitToRoom(channelRoom(channelId), event, payload);
}

/** Broadcast to one user across all their devices (`user:{id}`). */
export function emitToUser(userId: string, event: string, payload: unknown): void {
  emitToRoom(userRoom(userId), event, payload);
}

/** Broadcast to several users' personal channels (deduped). */
export function emitToUsers(userIds: string[], event: string, payload: unknown): void {
  for (const id of new Set(userIds.filter(Boolean))) emitToUser(id, event, payload);
}
