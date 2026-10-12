'use client';

/**
 * Ephemeral realtime state — presence + typing.
 *
 * Lives in memory only (zustand), fed by the RealtimeProvider from socket
 * events. NEVER persisted. The RealtimeProvider calls the setters; UI
 * indicators read via the hooks below.
 */
import { useMemo } from 'react';
import { create } from 'zustand';
import type { PresenceStatus } from '@/lib/chat/contract';

interface TypingEntry {
  userName: string;
  at: number;
}

interface RealtimeState {
  onlineUserIds: Set<string>;
  /** channelId -> (userId -> typing entry) */
  typing: Record<string, Record<string, TypingEntry>>;
  setOnlineRoster: (ids: string[]) => void;
  setUserOnline: (userId: string) => void;
  setUserOffline: (userId: string) => void;
  setTyping: (channelId: string, userId: string, userName: string) => void;
  clearTyping: (channelId: string, userId: string) => void;
}

export const useRealtimeStore = create<RealtimeState>((set) => ({
  onlineUserIds: new Set<string>(),
  typing: {},
  setOnlineRoster: (ids) => set({ onlineUserIds: new Set(ids) }),
  setUserOnline: (userId) =>
    set((s) => {
      if (s.onlineUserIds.has(userId)) return s;
      const next = new Set(s.onlineUserIds);
      next.add(userId);
      return { onlineUserIds: next };
    }),
  setUserOffline: (userId) =>
    set((s) => {
      if (!s.onlineUserIds.has(userId)) return s;
      const next = new Set(s.onlineUserIds);
      next.delete(userId);
      return { onlineUserIds: next };
    }),
  setTyping: (channelId, userId, userName) =>
    set((s) => ({
      typing: {
        ...s.typing,
        [channelId]: {
          ...(s.typing[channelId] ?? {}),
          [userId]: { userName, at: Date.now() },
        },
      },
    })),
  clearTyping: (channelId, userId) =>
    set((s) => {
      const chan = s.typing[channelId];
      if (!chan || !chan[userId]) return s;
      const nextChan = { ...chan };
      delete nextChan[userId];
      return { typing: { ...s.typing, [channelId]: nextChan } };
    }),
}));

/** Presence status for a single user (online if in the live roster). */
export function usePresence(userId: string | null | undefined): PresenceStatus {
  return useRealtimeStore((s) => (userId && s.onlineUserIds.has(userId) ? 'online' : 'offline'));
}

/** Whether a user is currently online. */
export function useIsOnline(userId: string | null | undefined): boolean {
  return useRealtimeStore((s) => !!userId && s.onlineUserIds.has(userId));
}

/** Users currently typing in a channel. Caller should filter out themselves. */
export function useTypingUsers(
  channelId: string | null | undefined
): { userId: string; userName: string }[] {
  const rec = useRealtimeStore((s) => (channelId ? s.typing[channelId] : undefined));
  return useMemo(
    () => (rec ? Object.entries(rec).map(([userId, v]) => ({ userId, userName: v.userName })) : []),
    [rec]
  );
}
