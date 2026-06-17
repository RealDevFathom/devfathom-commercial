'use client';

import { useEffect, useRef, useCallback } from 'react';
import { io, type Socket } from 'socket.io-client';

const SOCKET_URL = process.env.NEXT_PUBLIC_SOCKET_URL || 'http://localhost:3001';

let socket: Socket | null = null;

function getSocket(userId: string): Socket {
  if (!socket) {
    socket = io(SOCKET_URL, {
      query: { userId },
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

    socketRef.current = getSocket(userId);

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

  const emitTyping = useCallback((channelId: string, userName: string) => {
    if (!userId) return;
    socketRef.current?.emit('chat:typing', { channelId, userId, userName });
  }, [userId]);

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
