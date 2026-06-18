'use client';

import { useEffect, useRef, useCallback } from 'react';
import { io, type Socket } from 'socket.io-client';

const SOCKET_URL = process.env.NEXT_PUBLIC_SOCKET_URL || 'http://localhost:3001';

let socket: Socket | null = null;

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

function getSocket(): Socket {
  if (!socket) {
    socket = io(SOCKET_URL, {
      // `auth` as a FUNCTION is invoked by Socket.IO on every (re)connection
      // attempt, so we always present a FRESH ticket. With a static object the
      // ticket would expire (~60s) and reconnects would silently fail.
      // On fetch failure we send an empty payload; the server rejects it and
      // the client surfaces a `connect_error` instead of crashing.
      auth: (cb: (data: { ticket?: string }) => void) => {
        void fetchTicket().then((ticket) => cb(ticket ? { ticket } : {}));
      },
      transports: ['websocket', 'polling'],
      reconnection: true,
      reconnectionDelay: 1000,
      reconnectionAttempts: 5,
    });
  }
  return socket;
}

export function useSocket(userId: string | undefined) {
  const socketRef = useRef<Socket | null>(null);

  useEffect(() => {
    if (!userId) return;

    socketRef.current = getSocket();

    return () => {
      // Don't disconnect on unmount — keep alive for app lifetime
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
      // NOTE: the server authoritatively stamps the typist from the verified
      // ticket; any userId we send here is ignored. Kept in the payload only to
      // preserve the existing event shape.
      socketRef.current?.emit('chat:typing', { channelId, userId, userName });
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
