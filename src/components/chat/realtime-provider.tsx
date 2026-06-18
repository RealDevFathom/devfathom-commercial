'use client';

/**
 * RealtimeProvider — plugs the Socket.IO live layer into the UI.
 *
 * Mounted once near the app root (inside TRPCProvider). It:
 *  - joins every channel the user belongs to, so background channels update live
 *  - listens for server broadcast events and PATCHES the React Query cache
 *    (no refetch) so messages, reactions, reads, threads appear instantly
 *  - feeds presence + typing into the ephemeral realtime store
 *
 * It renders children unchanged; all work happens in effects. For logged-out
 * users it is a no-op (no socket, no queries).
 */
import { useEffect, useRef, type ReactNode } from 'react';
import { useSession } from 'next-auth/react';
import { trpc } from '@/lib/trpc';
import { useSocket } from '@/lib/socket';
import {
  RT,
  type ChatMessage,
  type ChatReaction,
  type RTMessageNew,
  type RTMessageUpdate,
  type RTMessageDelete,
  type RTReaction,
  type RTRead,
  type RTThreadReply,
  type RTTyping,
} from '@/lib/chat/contract';
import { useRealtimeStore } from '@/lib/chat/realtime-store';

const TYPING_AUTOCLEAR_MS = 4000;

export function RealtimeProvider({ children }: { children: ReactNode }) {
  const { data: session } = useSession();
  const userId = session?.user?.id;
  const myId = userId ?? '';
  const utils = trpc.useUtils();
  const { on, joinChannel, isConnected } = useSocket(userId);

  // Know every channel so we can join its room (live updates everywhere).
  const channelsQuery = trpc.chat.getChannels.useQuery(undefined, { enabled: !!userId });
  const channelIds = channelsQuery.data?.map((c) => c.id);
  const idsKey = (channelIds ?? []).join(',');
  const joinedRef = useRef<Set<string>>(new Set());
  const typingTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  // Join rooms whenever the set of channels (or the connection) changes.
  useEffect(() => {
    if (!userId || !channelIds) return;
    for (const id of channelIds) {
      joinChannel(id);
      joinedRef.current.add(id);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId, idsKey, isConnected, joinChannel]);

  useEffect(() => {
    if (!userId) return;
    const store = useRealtimeStore.getState;

    const patchMessage = (
      channelId: string,
      messageId: string,
      updater: (m: ChatMessage) => ChatMessage
    ) => {
      utils.chat.getMessages.setInfiniteData({ channelId }, (old) =>
        old
          ? {
              ...old,
              pages: old.pages.map((p) => ({
                ...p,
                items: p.items.map((m) => (m.id === messageId ? updater(m) : m)),
              })),
            }
          : old
      );
    };

    const unsubs: Array<() => void> = [];

    unsubs.push(
      on(RT.MESSAGE_NEW, (raw) => {
        const { channelId, message } = (raw ?? {}) as RTMessageNew;
        if (!message?.id || message.parentId) return; // replies handled by THREAD_REPLY
        utils.chat.getMessages.setInfiniteData({ channelId }, (old) => {
          if (!old || old.pages.length === 0) return old;
          if (old.pages.some((p) => p.items.some((m) => m.id === message.id))) return old;
          // page 0 holds the newest block (items ascending) — append the new message there.
          const pages = old.pages.slice();
          pages[0] = { ...pages[0], items: [...pages[0].items, message] };
          return { ...old, pages };
        });
        utils.chat.getChannels.setData(undefined, (old) =>
          old?.map((c) =>
            c.id === channelId
              ? {
                  ...c,
                  lastMessagePreview: message.content,
                  lastMessageAt: message.createdAt,
                  unreadCount: message.sender.id === myId ? c.unreadCount : c.unreadCount + 1,
                  mentionCount:
                    message.sender.id !== myId && (message.mentionIds ?? []).includes(myId)
                      ? c.mentionCount + 1
                      : c.mentionCount,
                }
              : c
          )
        );
      })
    );

    unsubs.push(
      on(RT.MESSAGE_UPDATE, (raw) => {
        const { channelId, message } = (raw ?? {}) as RTMessageUpdate;
        if (message?.id) patchMessage(channelId, message.id, () => message);
      })
    );

    unsubs.push(
      on(RT.MESSAGE_DELETE, (raw) => {
        const { channelId, messageId } = (raw ?? {}) as RTMessageDelete;
        if (messageId)
          patchMessage(channelId, messageId, (m) => ({
            ...m,
            deletedAt: new Date().toISOString(),
            content: '',
            contentJson: null,
          }));
      })
    );

    unsubs.push(
      on(RT.REACTION, (raw) => {
        const { channelId, messageId, reactions } = (raw ?? {}) as RTReaction;
        if (messageId)
          patchMessage(channelId, messageId, (m) => ({
            ...m,
            reactions: (reactions ?? []) as ChatReaction[],
          }));
      })
    );

    unsubs.push(
      on(RT.READ, (raw) => {
        const { channelId, userId: who } = (raw ?? {}) as RTRead;
        if (who !== myId) return;
        utils.chat.getChannels.setData(undefined, (old) =>
          old?.map((c) => (c.id === channelId ? { ...c, unreadCount: 0, mentionCount: 0 } : c))
        );
      })
    );

    unsubs.push(
      on(RT.THREAD_REPLY, (raw) => {
        const { channelId, parentId, message, replyCount } = (raw ?? {}) as RTThreadReply;
        if (!parentId || !message?.id) return;
        patchMessage(channelId, parentId, (m) => ({
          ...m,
          replyCount: replyCount ?? m.replyCount + 1,
          lastReplyAt: message.createdAt,
        }));
        utils.chat.getThread.setData({ parentId }, (old) =>
          old && !old.replies.some((r) => r.id === message.id)
            ? { ...old, replies: [...old.replies, message] }
            : old
        );
      })
    );

    unsubs.push(
      on(RT.TYPING, (raw) => {
        const { channelId, userId: who, userName } = (raw ?? {}) as RTTyping;
        if (!who || who === myId) return;
        store().setTyping(channelId, who, userName);
        const key = `${channelId}:${who}`;
        const prev = typingTimers.current.get(key);
        if (prev) clearTimeout(prev);
        typingTimers.current.set(
          key,
          setTimeout(() => store().clearTyping(channelId, who), TYPING_AUTOCLEAR_MS)
        );
      })
    );

    unsubs.push(
      on(RT.STOP_TYPING, (raw) => {
        const { channelId, userId: who } = (raw ?? {}) as { channelId: string; userId: string };
        if (who) store().clearTyping(channelId, who);
      })
    );

    unsubs.push(
      on('presence:init', (raw) => {
        const { onlineUsers } = (raw ?? {}) as { onlineUsers: string[] };
        if (Array.isArray(onlineUsers)) store().setOnlineRoster(onlineUsers);
      })
    );
    unsubs.push(
      on(RT.PRESENCE_ONLINE, (raw) => {
        const who = (raw as { userId?: string })?.userId;
        if (who) store().setUserOnline(who);
      })
    );
    unsubs.push(
      on(RT.PRESENCE_OFFLINE, (raw) => {
        const who = (raw as { userId?: string })?.userId;
        if (who) store().setUserOffline(who);
      })
    );

    unsubs.push(
      on(RT.NOTIFICATION, () => {
        // Toast / desktop handled by useChatNotifications(); refresh the badge.
        void utils.team.getNotifications.invalidate();
      })
    );

    // Re-join rooms after a reconnect so we keep receiving.
    unsubs.push(
      on('connect', () => {
        for (const id of joinedRef.current) joinChannel(id);
      })
    );

    const timers = typingTimers.current;
    return () => {
      for (const u of unsubs) u();
      for (const t of timers.values()) clearTimeout(t);
      timers.clear();
    };
     
  }, [userId, myId, on, joinChannel, utils]);

  return <>{children}</>;
}
