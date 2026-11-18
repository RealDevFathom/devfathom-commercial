'use client';

/**
 * The scrolling message timeline for a channel.
 *
 * - Infinite history via keyset cursor; "load older" fires near the top and the
 *   viewport is kept anchored so it doesn't jump.
 * - Consecutive messages from the same sender within 5 minutes are grouped.
 * - Day dividers ("Today" / "Yesterday" / "MMM d") and a single brass
 *   "New messages" divider at the first message past `lastReadAt`.
 * - Auto-scrolls to the newest message only when already near the bottom.
 */
import * as React from 'react';
import { useSession } from 'next-auth/react';
import { format, isSameDay, isToday, isYesterday, differenceInMinutes } from 'date-fns';
import { Loader2, MessageSquare } from 'lucide-react';

import type { ChatMessage } from '@/lib/chat/contract';
import { trpc } from '@/lib/trpc';
import { Skeleton } from '@/components/ui/skeleton';
import { MessageItem } from './message-item';

function dateLabel(d: Date): string {
  if (isToday(d)) return 'Today';
  if (isYesterday(d)) return 'Yesterday';
  return format(d, d.getFullYear() === new Date().getFullYear() ? 'MMM d' : 'MMM d, yyyy');
}

type Row =
  | { kind: 'date'; key: string; label: string }
  | { kind: 'unread'; key: string }
  | { kind: 'msg'; key: string; message: ChatMessage; grouped: boolean };

export function MessageList({
  channelId,
  lastReadAt,
}: {
  channelId: string;
  lastReadAt?: string | null;
}) {
  const { data: session } = useSession();
  const myId = session?.user?.id ?? '';
  // Snapshot lastReadAt at mount. The page keys this component by channel, so it
  // re-captures per channel and the "New messages" divider stays put even after
  // markRead advances the real lastReadAt.
  const [initialLastRead] = React.useState(lastReadAt);

  const { data, isLoading, hasNextPage, fetchNextPage, isFetchingNextPage } =
    trpc.chat.getMessages.useInfiniteQuery(
      { channelId },
      { getNextPageParam: (p) => p.nextCursor }
    );

  // Flatten → dedupe → chronological. Sorting by createdAt keeps us correct
  // regardless of how the cursor orders pages/items. Only top-level messages
  // live in the timeline; replies are shown in the thread panel.
  const messages = React.useMemo(() => {
    const map = new Map<string, ChatMessage>();
    for (const page of data?.pages ?? []) {
      for (const m of page.items) {
        if (m.parentId === null) map.set(m.id, m);
      }
    }
    // RT-08: tiebreak by id when createdAt is identical (same-ms messages) so the
    // order is stable and matches the server's [createdAt, id] ordering — otherwise
    // same-ms messages could reshuffle between renders.
    return [...map.values()].sort((a, b) => {
      const d = new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
      return d !== 0 ? d : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });
  }, [data]);

  const scrollRef = React.useRef<HTMLDivElement | null>(null);
  const nearBottomRef = React.useRef(true);
  const prevScrollHeightRef = React.useRef<number | null>(null);
  const didInitialScrollRef = React.useRef(false);
  const lastIdRef = React.useRef<string | null>(null);
  const channelRef = React.useRef(channelId);

  const handleScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    nearBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
    if (el.scrollTop < 120 && hasNextPage && !isFetchingNextPage) {
      prevScrollHeightRef.current = el.scrollHeight;
      fetchNextPage();
    }
  };

  // Keep the viewport anchored when older messages prepend.
  React.useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el || prevScrollHeightRef.current == null) return;
    el.scrollTop += el.scrollHeight - prevScrollHeightRef.current;
    prevScrollHeightRef.current = null;
  }, [messages]);

  // Initial jump to bottom, channel-switch reset, and follow-on-new-message.
  React.useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;

    if (channelRef.current !== channelId) {
      channelRef.current = channelId;
      didInitialScrollRef.current = false;
      lastIdRef.current = null;
      nearBottomRef.current = true;
    }
    if (messages.length === 0) return;

    const lastId = messages[messages.length - 1].id;
    if (!didInitialScrollRef.current) {
      el.scrollTop = el.scrollHeight; // instant on first paint
      didInitialScrollRef.current = true;
      lastIdRef.current = lastId;
      return;
    }
    if (lastId !== lastIdRef.current) {
      lastIdRef.current = lastId;
      if (nearBottomRef.current) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
    }
  }, [messages, channelId]);

  const rows = React.useMemo<Row[]>(() => {
    const out: Row[] = [];
    const lastRead = initialLastRead ? new Date(initialLastRead).getTime() : null;
    let unreadDone = false;
    let prev: ChatMessage | null = null;

    for (const m of messages) {
      const d = new Date(m.createdAt);
      let breakGroup = false;

      if (!prev || !isSameDay(d, new Date(prev.createdAt))) {
        out.push({ kind: 'date', key: `date-${m.id}`, label: dateLabel(d) });
        breakGroup = true;
      }

      // First unread message that isn't ours → "New messages" boundary.
      if (!unreadDone && lastRead != null && d.getTime() > lastRead && m.sender.id !== myId) {
        out.push({ kind: 'unread', key: `unread-${m.id}` });
        unreadDone = true;
        breakGroup = true;
      }

      const grouped =
        !breakGroup &&
        !!prev &&
        prev.sender.id === m.sender.id &&
        !prev.deletedAt &&
        differenceInMinutes(d, new Date(prev.createdAt)) < 5;

      out.push({ kind: 'msg', key: m.id, message: m, grouped });
      prev = m;
    }
    return out;
  }, [messages, initialLastRead, myId]);

  if (isLoading) {
    return (
      <div className="flex-1 overflow-hidden px-4 py-4">
        <div className="space-y-5">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="flex gap-3">
              <Skeleton className="size-9 shrink-0 rounded-full" />
              <div className="flex-1 space-y-2">
                <Skeleton className="h-3.5 w-32" />
                <Skeleton className="h-3 w-2/3" />
                <Skeleton className="h-3 w-1/2" />
              </div>
            </div>
          ))}
        </div>
      </div>
    );
  }

  if (messages.length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center p-6">
        <div className="text-center">
          <div className="mx-auto flex size-12 items-center justify-center rounded-2xl bg-muted">
            <MessageSquare className="h-6 w-6 text-muted-foreground/50" />
          </div>
          <p className="mt-3 text-sm font-medium text-foreground">No messages yet</p>
          <p className="mt-1 text-xs text-muted-foreground">
            Say hello and start the conversation.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div
      ref={scrollRef}
      onScroll={handleScroll}
      role="log"
      aria-label="Channel messages"
      className="flex-1 overflow-y-auto overscroll-contain"
    >
      {/* min-h-full + mt-auto keeps short conversations pinned to the bottom
          without trapping the top out of reach once they overflow. */}
      <div className="flex min-h-full flex-col">
        <div className="mt-auto py-3">
          {isFetchingNextPage && (
            <div className="flex items-center justify-center py-2 text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
            </div>
          )}
          {!hasNextPage && (
            <div className="px-4 pt-1 pb-3 text-center text-[11px] text-muted-foreground/60">
              This is the very beginning of the conversation.
            </div>
          )}
          {rows.map((row) => {
            if (row.kind === 'date') return <DateDivider key={row.key} label={row.label} />;
            if (row.kind === 'unread') return <UnreadDivider key={row.key} />;
            return (
              <MessageItem
                key={row.key}
                message={row.message}
                grouped={row.grouped}
                channelId={channelId}
              />
            );
          })}
        </div>
      </div>
    </div>
  );
}

function DateDivider({ label }: { label: string }) {
  return (
    <div className="sticky top-2 z-[1] my-3 flex items-center justify-center">
      <span className="rounded-full border border-border/60 bg-background px-2.5 py-0.5 text-[11px] font-medium text-muted-foreground shadow-sm">
        {label}
      </span>
    </div>
  );
}

function UnreadDivider() {
  return (
    <div role="separator" aria-label="New messages below" className="relative my-2.5 px-4">
      <div className="h-px w-full bg-accent-brand/50" />
      <span className="absolute -top-2 right-4 bg-background px-2 text-[11px] font-semibold tracking-wider text-foreground uppercase">
        New messages
      </span>
    </div>
  );
}
