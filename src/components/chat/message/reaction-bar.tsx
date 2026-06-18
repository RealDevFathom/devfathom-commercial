'use client';

/**
 * Reaction pills under a message + the shared optimistic toggle hook.
 *
 * `useToggleReaction` patches the `getMessages` infinite cache immediately so a
 * tap feels instant, then reconciles on settle. It's exported so the hover
 * action bar's quick-reactions share the exact same optimism.
 */
import { useSession } from 'next-auth/react';
import { Plus } from 'lucide-react';
import { toast } from 'sonner';

import type { ChatMessage, ChatReaction } from '@/lib/chat/contract';
import { trpc } from '@/lib/trpc';
import { cn } from '@/lib/utils';
import { EmojiPicker } from '@/components/chat/composer/emoji-picker';

/** Pure optimistic transform of one emoji toggle for the current viewer. */
function applyToggle(reactions: ChatReaction[], emoji: string, myId: string): ChatReaction[] {
  const existing = reactions.find((r) => r.emoji === emoji);
  if (!existing) {
    return [...reactions, { emoji, count: 1, userIds: myId ? [myId] : [], reactedByMe: true }];
  }
  if (existing.reactedByMe) {
    return reactions
      .map((r) =>
        r.emoji === emoji
          ? {
              ...r,
              count: r.count - 1,
              userIds: r.userIds.filter((u) => u !== myId),
              reactedByMe: false,
            }
          : r
      )
      .filter((r) => r.count > 0);
  }
  return reactions.map((r) =>
    r.emoji === emoji
      ? { ...r, count: r.count + 1, userIds: [...r.userIds, myId], reactedByMe: true }
      : r
  );
}

export function useToggleReaction(channelId: string) {
  const utils = trpc.useUtils();
  const { data: session } = useSession();
  const myId = session?.user?.id ?? '';

  return trpc.chat.toggleReaction.useMutation({
    onMutate: async ({ messageId, emoji }: { messageId: string; emoji: string }) => {
      await utils.chat.getMessages.cancel({ channelId });
      const prev = utils.chat.getMessages.getInfiniteData({ channelId });
      utils.chat.getMessages.setInfiniteData({ channelId }, (data) => {
        if (!data) return data;
        return {
          ...data,
          pages: data.pages.map((pg) => ({
            ...pg,
            items: pg.items.map((m) =>
              m.id === messageId ? { ...m, reactions: applyToggle(m.reactions, emoji, myId) } : m
            ),
          })),
        };
      });
      return { prev };
    },
    onError: (_err, _vars, ctx) => {
      if (ctx?.prev) utils.chat.getMessages.setInfiniteData({ channelId }, ctx.prev);
      toast.error('Could not update reaction');
    },
    onSuccess: (reactions, { messageId }) => {
      // Reconcile with the server's authoritative set (no full-history refetch);
      // the optimistic onMutate already moved the UI, the realtime patch covers others.
      utils.chat.getMessages.setInfiniteData({ channelId }, (data) =>
        data
          ? {
              ...data,
              pages: data.pages.map((pg) => ({
                ...pg,
                items: pg.items.map((m) => (m.id === messageId ? { ...m, reactions } : m)),
              })),
            }
          : data
      );
    },
    onSettled: () => {
      // Threads are small; keep them fresh without touching the channel history.
      utils.chat.getThread.invalidate();
    },
  });
}

export function ReactionBar({ message, channelId }: { message: ChatMessage; channelId: string }) {
  const toggle = useToggleReaction(channelId);

  // The add-reaction affordance lives in the hover action bar; nothing to show
  // here until at least one reaction exists.
  if (!message.reactions.length) return null;

  return (
    <div className="mt-1 flex flex-wrap items-center gap-1">
      {message.reactions.map((r) => (
        <button
          key={r.emoji}
          type="button"
          onClick={() => toggle.mutate({ messageId: message.id, emoji: r.emoji })}
          aria-pressed={r.reactedByMe}
          aria-label={`${r.emoji} reaction, ${r.count}${r.reactedByMe ? ', you reacted' : ''}`}
          title={r.reactedByMe ? 'Remove reaction' : 'React'}
          className={cn(
            'inline-flex h-6 items-center gap-1 rounded-full border px-2 text-xs transition-colors',
            r.reactedByMe
              ? 'border-primary/30 bg-primary/10 text-primary'
              : 'border-border/60 bg-muted/40 text-muted-foreground hover:border-border hover:bg-muted'
          )}
        >
          <span className="text-[0.95em] leading-none">{r.emoji}</span>
          <span className="font-medium tabular-nums">{r.count}</span>
        </button>
      ))}

      <EmojiPicker onPick={(emoji) => toggle.mutate({ messageId: message.id, emoji })}>
        <button
          type="button"
          aria-label="Add reaction"
          className="inline-flex h-6 items-center rounded-full border border-border/60 bg-muted/30 px-1.5 text-muted-foreground transition-colors hover:border-border hover:bg-muted hover:text-foreground"
        >
          <Plus className="h-3.5 w-3.5" />
        </button>
      </EmojiPicker>
    </div>
  );
}
