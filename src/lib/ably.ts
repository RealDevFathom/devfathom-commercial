'use client';

/**
 * Ably realtime client (browser).
 *
 * Replaces the self-hosted Socket.IO client. Vercel can't hold persistent
 * websockets, so realtime runs on Ably's managed pub/sub instead of a
 * standalone relay.
 *
 * SECURITY MODEL (unchanged in spirit):
 *  - The browser never sees the Ably API key. It authenticates via the
 *    same-origin /api/ably-token endpoint, which mints a short-lived,
 *    capability-scoped token whose `clientId` is the verified NextAuth user id.
 *  - Message channels (`channel:{id}`) are SUBSCRIBE-only for clients — only
 *    the server publishes to them (after persistence) via Ably REST. Clients
 *    can therefore never forge a message/reaction/read event.
 *  - Typing rides a separate `typing:{id}` channel that clients may publish to;
 *    the typist's identity is the token `clientId`, so it cannot be spoofed.
 *  - Presence rides Ably's built-in presence on the tenant-scoped
 *    `presence:org:{orgId}` channel.
 */
import { useCallback, useEffect, useRef, useSyncExternalStore } from 'react';
import * as Ably from 'ably';
import { RT, typingRoom } from '@/lib/chat/contract';

let client: Ably.Realtime | null = null;

/**
 * Process-wide singleton Realtime client. Auth is delegated to the token
 * endpoint; Ably auto-renews the token through the same URL as it nears expiry.
 * `echoMessages: false` keeps a client from receiving its own typing pings.
 */
export function getAblyClient(): Ably.Realtime {
  if (!client) {
    client = new Ably.Realtime({
      authUrl: '/api/ably-token',
      authMethod: 'GET',
      echoMessages: false,
    });
  }
  return client;
}

/**
 * Resolve the singleton (client-only) + track connection state via
 * useSyncExternalStore — the React-blessed way to read a live external source
 * without setState-in-effect, and it reports "already connected" correctly when
 * the singleton was established on a previous page. No-op for logged-out users.
 */
export function useAbly(userId: string | undefined): {
  client: Ably.Realtime | null;
  isConnected: boolean;
} {
  const client = userId && typeof window !== 'undefined' ? getAblyClient() : null;

  const subscribe = useCallback(
    (onChange: () => void) => {
      if (!client) return () => {};
      const handler = () => onChange();
      client.connection.on(handler);
      return () => client.connection.off(handler);
    },
    [client]
  );

  const isConnected = useSyncExternalStore(
    subscribe,
    () => (client ? client.connection.state === 'connected' : false),
    () => false
  );

  return { client, isConnected };
}

// Idle window after the last keystroke before emitting a single stop-typing,
// plus a heartbeat so a sustained typist keeps resetting the receiver's clear.
const TYPING_IDLE_MS = 1000;
const TYPING_HEARTBEAT_MS = 2500;

/**
 * Debounced typing publisher. Emits one `chat:typing` on the first keystroke of
 * a burst (and a heartbeat every ~2.5s), then one `chat:stop-typing` after
 * TYPING_IDLE_MS of silence — mirroring the old socket behaviour. Publishes to
 * the per-channel `typing:{id}` channel; identity comes from the token clientId.
 */
export function useChatTyping(userId: string | undefined): {
  emitTyping: (channelId: string, userName: string) => void;
} {
  const { client } = useAbly(userId);
  const timers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  const active = useRef<Set<string>>(new Set());
  const lastEmit = useRef<Map<string, number>>(new Map());

  const emitTyping = useCallback(
    (channelId: string, userName: string) => {
      if (!client || !userId) return;
      const ch = client.channels.get(typingRoom(channelId));
      const now = Date.now();
      const last = lastEmit.current.get(channelId) ?? 0;
      if (!active.current.has(channelId) || now - last > TYPING_HEARTBEAT_MS) {
        active.current.add(channelId);
        lastEmit.current.set(channelId, now);
        void ch.publish(RT.TYPING, { userName }).catch(() => {});
      }
      const existing = timers.current.get(channelId);
      if (existing) clearTimeout(existing);
      timers.current.set(
        channelId,
        setTimeout(() => {
          timers.current.delete(channelId);
          active.current.delete(channelId);
          lastEmit.current.delete(channelId);
          void ch.publish(RT.STOP_TYPING, {}).catch(() => {});
        }, TYPING_IDLE_MS)
      );
    },
    [client, userId]
  );

  useEffect(() => {
    const t = timers.current;
    return () => {
      for (const x of t.values()) clearTimeout(x);
      t.clear();
    };
  }, []);

  return { emitTyping };
}
