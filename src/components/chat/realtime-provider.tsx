'use client';

/**
 * RealtimeProvider — plugs the Ably live layer into the UI.
 *
 * Mounted once near the app root (inside TRPCProvider). It:
 *  - subscribes to every channel the user belongs to, so background channels
 *    update live, and PATCHES the React Query cache (no refetch) so messages,
 *    reactions, reads, threads appear instantly
 *  - relays typing via the per-channel `typing:{id}` channel
 *  - feeds presence (Ably presence on the tenant's `presence:org:{orgId}`) into
 *    the realtime store
 *
 * It renders children unchanged; all work happens in effects. For logged-out
 * users it is a no-op (no client, no queries).
 */
import { useEffect, useRef, type ReactNode } from 'react';
import { useSession } from 'next-auth/react';
import type * as Ably from 'ably';
import { trpc } from '@/lib/trpc';
import { useAbly } from '@/lib/ably';
import {
  RT,
  channelRoom,
  userRoom,
  typingRoom,
  presenceRoom,
  type ChatMessage,
  type ChatReaction,
  type RTMessageNew,
  type RTMessageUpdate,
  type RTMessageDelete,
  type RTReaction,
  type RTRead,
  type RTThreadReply,
} from '@/lib/chat/contract';
import { useRealtimeStore } from '@/lib/chat/realtime-store';

const TYPING_AUTOCLEAR_MS = 4000;

export function RealtimeProvider({
  children,
  enabled = true,
}: {
  children: ReactNode;
  enabled?: boolean;
}) {
  const { data: session } = useSession();
  const userId = session?.user?.id;
  const organizationId = session?.user?.organizationId;
  const myId = userId ?? '';
  const utils = trpc.useUtils();
  const { client } = useAbly(enabled ? userId : undefined);

  // Know every channel so we can subscribe to its rooms (live updates everywhere).
  const channelsQuery = trpc.chat.getChannels.useQuery(undefined, { enabled: enabled && !!userId });
  const channelIds = channelsQuery.data?.map((c) => c.id);
  const idsKey = (channelIds ?? []).join(',');

  const typingTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  // Channel ids already covered by the current Ably token's capability. When a
  // newly-joined channel appears we re-authorize so the token grants it.
  const authorizedRef = useRef<Set<string>>(new Set());

  // --- Presence: enter this tenant's roster, track enter/leave -------------
  useEffect(() => {
    if (!client || !userId || !organizationId) return;
    const store = useRealtimeStore.getState;
    const pc = client.channels.get(presenceRoom(organizationId));
    let cancelled = false;

    const onEnter = (m: Ably.PresenceMessage) => {
      if (m.clientId) store().setUserOnline(m.clientId);
    };
    const onLeave = (m: Ably.PresenceMessage) => {
      if (m.clientId) store().setUserOffline(m.clientId);
    };

    void (async () => {
      try {
        // Register listeners synchronously BEFORE any await so cleanup's
        // unsubscribe() always removes them (no orphaned handler if we unmount
        // mid-await). 'present' replays the current roster on attach.
        void pc.presence.subscribe(['enter', 'present'], onEnter).catch(() => {});
        void pc.presence.subscribe('leave', onLeave).catch(() => {});
        await pc.presence.enter();
        const members = await pc.presence.get();
        if (cancelled) return;
        store().setOnlineRoster(members.map((m) => m.clientId).filter((id): id is string => !!id));
      } catch (err) {
        console.error('[realtime] presence init failed', err);
      }
    })();

    return () => {
      cancelled = true;
      pc.presence.unsubscribe(onEnter);
      pc.presence.unsubscribe(onLeave);
      void pc.presence.leave().catch(() => {});
    };
  }, [client, userId, organizationId]);

  // --- Channel + typing subscriptions (re-run when the channel set changes) -
  useEffect(() => {
    if (!client || !userId || !channelIds) return;
    const store = useRealtimeStore.getState;
    const timers = typingTimers.current;
    const channels: Ably.RealtimeChannel[] = [];
    const logSubErr = (err: unknown) => console.error('[realtime] subscribe failed', err);
    let cancelled = false;

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

    const onMessageNew = (raw: unknown) => {
      const { channelId, message } = (raw ?? {}) as RTMessageNew;
      if (!message?.id || message.parentId) return; // replies handled by THREAD_REPLY
      utils.chat.getMessages.setInfiniteData({ channelId }, (old) => {
        if (!old || old.pages.length === 0) return old;
        if (old.pages.some((p) => p.items.some((m) => m.id === message.id))) return old;
        // page 0 holds the newest block (items ascending) — append there.
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
    };

    const onMessageUpdate = (raw: unknown) => {
      const { channelId, message } = (raw ?? {}) as RTMessageUpdate;
      if (message?.id) patchMessage(channelId, message.id, () => message);
    };

    const onMessageDelete = (raw: unknown) => {
      const { channelId, messageId } = (raw ?? {}) as RTMessageDelete;
      if (messageId)
        patchMessage(channelId, messageId, (m) => ({
          ...m,
          deletedAt: new Date().toISOString(),
          content: '',
          contentJson: null,
        }));
    };

    const onReaction = (raw: unknown) => {
      const { channelId, messageId, reactions } = (raw ?? {}) as RTReaction;
      if (messageId)
        patchMessage(channelId, messageId, (m) => ({
          ...m,
          reactions: (reactions ?? []) as ChatReaction[],
        }));
    };

    const onRead = (raw: unknown) => {
      const { channelId, userId: who } = (raw ?? {}) as RTRead;
      if (who !== myId) return;
      utils.chat.getChannels.setData(undefined, (old) =>
        old?.map((c) => (c.id === channelId ? { ...c, unreadCount: 0, mentionCount: 0 } : c))
      );
    };

    const onThreadReply = (raw: unknown) => {
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
    };

    void (async () => {
      // Ensure the token grants any channel we joined since it was minted.
      const needsAuth = channelIds.some((id) => !authorizedRef.current.has(id));
      if (needsAuth) {
        try {
          await client.auth.authorize();
          // Mark authorized ONLY on success — otherwise a failed refresh would
          // permanently skip re-auth and leave new channels silently unreachable.
          for (const id of channelIds) authorizedRef.current.add(id);
        } catch {
          // Leave authorizedRef unchanged so the next effect run retries auth.
        }
      }
      if (cancelled) return;

      for (const channelId of channelIds) {
        // Message channel (server-published, subscribe-only).
        const ch = client.channels.get(channelRoom(channelId));
        channels.push(ch);
        void ch.subscribe(RT.MESSAGE_NEW, (m) => onMessageNew(m.data)).catch(logSubErr);
        void ch.subscribe(RT.MESSAGE_UPDATE, (m) => onMessageUpdate(m.data)).catch(logSubErr);
        void ch.subscribe(RT.MESSAGE_DELETE, (m) => onMessageDelete(m.data)).catch(logSubErr);
        void ch.subscribe(RT.REACTION, (m) => onReaction(m.data)).catch(logSubErr);
        void ch.subscribe(RT.READ, (m) => onRead(m.data)).catch(logSubErr);
        void ch.subscribe(RT.THREAD_REPLY, (m) => onThreadReply(m.data)).catch(logSubErr);

        // Typing channel (client-published). Identity is the message clientId.
        const tch = client.channels.get(typingRoom(channelId));
        channels.push(tch);
        void tch
          .subscribe(RT.TYPING, (m) => {
            const who = m.clientId;
            if (!who || who === myId) return;
            const userName = (m.data as { userName?: string } | undefined)?.userName ?? 'Someone';
            store().setTyping(channelId, who, userName);
            const key = `${channelId}:${who}`;
            const prev = timers.get(key);
            if (prev) clearTimeout(prev);
            timers.set(
              key,
              setTimeout(() => store().clearTyping(channelId, who), TYPING_AUTOCLEAR_MS)
            );
          })
          .catch(logSubErr);
        void tch
          .subscribe(RT.STOP_TYPING, (m) => {
            const who = m.clientId;
            if (who) store().clearTyping(channelId, who);
          })
          .catch(logSubErr);
      }
    })();

    return () => {
      cancelled = true;
      for (const ch of channels) ch.unsubscribe();
      for (const t of timers.values()) clearTimeout(t);
      timers.clear();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- idsKey captures channelIds; utils/client/myId are stable refs
  }, [client, userId, myId, idsKey]);

  // --- Membership revocation (RT-02) ---------------------------------------
  // When this user is removed from (or leaves) a channel, the server pushes
  // MEMBERSHIP_CHANGED to their personal room. Refetching the channel set drops
  // the revoked channel from `channelIds`, so the subscription effect above
  // unsubscribes it live; re-authorizing refreshes the Ably token capability.
  useEffect(() => {
    if (!client || !myId) return;
    const room = client.channels.get(userRoom(myId));
    const onMembershipChanged = () => {
      void utils.chat.getChannels.invalidate();
      void client.auth.authorize().catch(() => {});
    };
    // RT-09: own read receipts now arrive on the personal room (was broadcast to
    // the whole channel, exposing everyone's read times to any subscriber).
    const onRead = (m: Ably.Message) => {
      const { channelId, userId: who } = (m.data ?? {}) as RTRead;
      if (who !== myId || !channelId) return;
      utils.chat.getChannels.setData(undefined, (old) =>
        old?.map((c) => (c.id === channelId ? { ...c, unreadCount: 0, mentionCount: 0 } : c))
      );
    };
    void room.subscribe(RT.MEMBERSHIP_CHANGED, onMembershipChanged).catch(() => {});
    void room.subscribe(RT.READ, onRead).catch(() => {});
    return () => {
      room.unsubscribe(RT.MEMBERSHIP_CHANGED, onMembershipChanged);
      room.unsubscribe(RT.READ, onRead);
    };
  }, [client, myId, utils]);

  return <>{children}</>;
}
