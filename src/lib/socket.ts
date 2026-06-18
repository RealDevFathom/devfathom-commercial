'use client';

import { useEffect, useRef, useCallback } from 'react';
import { io, type Socket } from 'socket.io-client';

const SOCKET_URL = process.env.NEXT_PUBLIC_SOCKET_URL || 'http://localhost:3001';

// Refresh a ticket once it is within this window of its embedded expiry. The
// server mints tickets with a ~60s TTL, so we keep a small safety margin to
// avoid presenting one that expires mid-handshake.
const TICKET_REFRESH_MARGIN_MS = 5_000;

let socket: Socket | null = null;

// Module-scoped ticket cache so reconnect attempts reuse a still-valid ticket
// instead of hitting /api/realtime-token on every attempt. `expMs` is the
// ticket's own embedded expiry (parsed from its payload); `inFlight`
// deduplicates concurrent fetches.
let cachedTicket: string | null = null;
let cachedTicketExpMs = 0;
let inFlightTicket: Promise<string | null> | null = null;

/**
 * Parse the embedded expiry (ms epoch) from a ticket's base64url payload.
 *
 * Ticket shape is `base64url(JSON.stringify({ userId, exp })).hmac`. We only
 * read `exp` to decide when to refresh; the HMAC is verified server-side. Any
 * malformed input returns 0 so the ticket is treated as already expired.
 */
function parseTicketExpMs(ticket: string): number {
  try {
    const dot = ticket.indexOf('.');
    const payloadB64 = dot > 0 ? ticket.slice(0, dot) : ticket;
    const json = atob(payloadB64.replace(/-/g, '+').replace(/_/g, '/'));
    const exp = (JSON.parse(json) as { exp?: unknown })?.exp;
    return typeof exp === 'number' ? exp : 0;
  } catch {
    return 0;
  }
}

/**
 * Fetch a short-lived, HMAC-signed realtime ticket from the Next app.
 *
 * Identity is NO LONGER sent via `query.userId` (which was client-controlled
 * and trivially spoofable). The ticket is minted server-side from the NextAuth
 * session and verified by the socket server.
 *
 * Returns null on any failure so the caller can degrade gracefully instead of
 * throwing (e.g. logged-out user, network blip, socket server unreachable).
 */
async function fetchTicket(): Promise<string | null> {
  try {
    const res = await fetch('/api/realtime-token', {
      // Always hit the network; tickets are short-lived and must not be cached.
      cache: 'no-store',
      credentials: 'include',
    });
    if (!res.ok) return null;
    const data: unknown = await res.json();
    const ticket = (data as { ticket?: unknown })?.ticket;
    return typeof ticket === 'string' ? ticket : null;
  } catch {
    return null;
  }
}

/**
 * Return a valid realtime ticket, reusing the module-scoped cache while it has
 * more than TICKET_REFRESH_MARGIN_MS left before expiry. Only fetches a new one
 * when the cache is missing or near-expiry, and dedups concurrent refreshes.
 */
async function getTicket(): Promise<string | null> {
  if (cachedTicket && Date.now() < cachedTicketExpMs - TICKET_REFRESH_MARGIN_MS) {
    return cachedTicket;
  }
  if (inFlightTicket) return inFlightTicket;

  inFlightTicket = fetchTicket()
    .then((ticket) => {
      if (ticket) {
        cachedTicket = ticket;
        cachedTicketExpMs = parseTicketExpMs(ticket);
      }
      return ticket;
    })
    .finally(() => {
      inFlightTicket = null;
    });

  return inFlightTicket;
}

function getSocket(): Socket {
  if (!socket) {
    socket = io(SOCKET_URL, {
      // `auth` as a FUNCTION is invoked by Socket.IO on every (re)connection
      // attempt, so we always present a still-valid ticket. `getTicket` reuses
      // the module-scoped cache and only refetches when missing/near-expiry, so
      // rapid reconnect attempts don't hammer /api/realtime-token.
      // On fetch failure we send an empty payload; the server rejects it and
      // the client surfaces a `connect_error` instead of crashing.
      auth: (cb: (data: { ticket?: string }) => void) => {
        void getTicket().then((ticket) => cb(ticket ? { ticket } : {}));
      },
      transports: ['websocket', 'polling'],
      reconnection: true,
      // Jittered exponential backoff: delay grows from 1s up to 5s, and
      // `randomizationFactor` spreads each attempt by ±50% so a fleet of
      // clients reconnecting after an outage doesn't thunder simultaneously.
      reconnectionDelay: 1000,
      reconnectionDelayMax: 5000,
      randomizationFactor: 0.5,
      reconnectionAttempts: 5,
    });
  }
  return socket;
}

// Idle window after the last keystroke before we emit a single `chat:stop-typing`.
const TYPING_IDLE_MS = 1000;

export function useSocket(userId: string | undefined) {
  const socketRef = useRef<Socket | null>(null);
  // Per-channel idle timers + a flag for whether we've already emitted a
  // `chat:typing` start, so emitTyping debounces keystrokes into one start +
  // one trailing stop instead of one event per keypress.
  const typingTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  const typingActiveRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    if (!userId) return;

    socketRef.current = getSocket();

    const timers = typingTimersRef.current;
    const active = typingActiveRef.current;
    return () => {
      // Don't disconnect on unmount — keep alive for app lifetime.
      // Do clear any pending typing timers so they don't fire after unmount.
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
      active.clear();
    };
  }, [userId]);

  const joinChannel = useCallback((channelId: string) => {
    socketRef.current?.emit('chat:join', channelId);
  }, []);

  const leaveChannel = useCallback((channelId: string) => {
    socketRef.current?.emit('chat:leave', channelId);
  }, []);

  const sendMessage = useCallback((channelId: string, message: unknown) => {
    socketRef.current?.emit('chat:message', { channelId, message });
  }, []);

  const onMessage = useCallback((callback: (message: unknown) => void) => {
    socketRef.current?.on('chat:message', callback);
    return () => {
      socketRef.current?.off('chat:message', callback);
    };
  }, []);

  const emitTyping = useCallback(
    (channelId: string, userName: string) => {
      if (!userId) return;

      // Emit a single `chat:typing` start on the first keystroke, then debounce:
      // each subsequent keystroke just resets the idle timer. After
      // TYPING_IDLE_MS of silence we emit one `chat:stop-typing`.
      if (!typingActiveRef.current.has(channelId)) {
        typingActiveRef.current.add(channelId);
        // NOTE: the server authoritatively stamps the typist from the verified
        // ticket; any userId we send here is ignored. Kept in the payload only
        // to preserve the existing event shape.
        socketRef.current?.emit('chat:typing', { channelId, userId, userName });
      }

      const timers = typingTimersRef.current;
      const existing = timers.get(channelId);
      if (existing) clearTimeout(existing);
      timers.set(
        channelId,
        setTimeout(() => {
          timers.delete(channelId);
          typingActiveRef.current.delete(channelId);
          socketRef.current?.emit('chat:stop-typing', { channelId });
        }, TYPING_IDLE_MS)
      );
    },
    [userId]
  );

  const onTyping = useCallback((callback: (data: { userId: string; userName: string }) => void) => {
    socketRef.current?.on('chat:typing', callback);
    return () => {
      socketRef.current?.off('chat:typing', callback);
    };
  }, []);

  const onNotification = useCallback((callback: (notification: unknown) => void) => {
    socketRef.current?.on('notification:new', callback);
    return () => {
      socketRef.current?.off('notification:new', callback);
    };
  }, []);

  return {
    socket: socketRef.current,
    joinChannel,
    leaveChannel,
    sendMessage,
    onMessage,
    emitTyping,
    onTyping,
    onNotification,
    isConnected: socketRef.current?.connected ?? false,
  };
}
