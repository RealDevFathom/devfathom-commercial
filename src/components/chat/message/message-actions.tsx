'use client';

/**
 * Floating hover toolbar for a message: quick reactions, add-other-reaction,
 * reply-in-thread, and an overflow menu (edit / delete / pin / save / copy).
 *
 * Reaction toggles share the optimistic hook from ReactionBar. Delete optimis-
 * tically drops a tombstone; pin/save just fire and reconcile.
 */
import * as React from 'react';
import { useSession } from 'next-auth/react';
import {
  SmilePlus,
  MoreHorizontal,
  Reply,
  Pencil,
  Trash2,
  Pin,
  PinOff,
  Bookmark,
  BookmarkCheck,
  Copy,
} from 'lucide-react';
import { toast } from 'sonner';

import type { ChatMessage } from '@/lib/chat/contract';
import { QUICK_REACTIONS } from '@/lib/chat/contract';
import { trpc } from '@/lib/trpc';
import { cn } from '@/lib/utils';
import { EmojiPicker } from '@/components/chat/composer/emoji-picker';
import { useToggleReaction } from '@/components/chat/message/reaction-bar';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

export function MessageActions({
  message,
  channelId,
  onReplyInThread,
  onEdit,
  hideReplyInThread = false,
}: {
  message: ChatMessage;
  channelId: string;
  onReplyInThread: () => void;
  onEdit: () => void;
  /** Suppress the thread reply affordance (e.g. inside the thread panel). */
  hideReplyInThread?: boolean;
}) {
  const { data: session } = useSession();
  const utils = trpc.useUtils();
  const myId = session?.user?.id ?? '';
  const isAdmin = session?.user?.role === 'ADMIN';
  const isOwn = message.sender.id === myId;
  const canDelete = isOwn || isAdmin;

  const [menuOpen, setMenuOpen] = React.useState(false);
  const toggle = useToggleReaction(channelId);

  const deleteMessage = trpc.chat.deleteMessage.useMutation({
    onMutate: async ({ messageId }: { messageId: string }) => {
      await utils.chat.getMessages.cancel({ channelId });
      const prev = utils.chat.getMessages.getInfiniteData({ channelId });
      const now = new Date().toISOString();
      utils.chat.getMessages.setInfiniteData({ channelId }, (data) => {
        if (!data) return data;
        return {
          ...data,
          pages: data.pages.map((pg) => ({
            ...pg,
            items: pg.items.map((m) => (m.id === messageId ? { ...m, deletedAt: now } : m)),
          })),
        };
      });
      return { prev };
    },
    onError: (_err, _vars, ctx) => {
      if (ctx?.prev) utils.chat.getMessages.setInfiniteData({ channelId }, ctx.prev);
      toast.error('Could not delete message');
    },
    onSettled: () => {
      // Optimistic tombstone + realtime MESSAGE_DELETE reconcile the timeline;
      // only the (small) thread needs a refresh.
      utils.chat.getThread.invalidate();
    },
  });

  const togglePin = trpc.chat.togglePin.useMutation({
    onSuccess: (res) => {
      toast.success(res.isPinned ? 'Pinned to channel' : 'Unpinned');
      utils.chat.getMessages.invalidate({ channelId });
      utils.chat.getPins.invalidate({ channelId });
    },
    onError: () => toast.error('Could not update pin'),
  });

  const toggleSave = trpc.chat.toggleSave.useMutation({
    onSuccess: (res) => {
      toast.success(res.isSaved ? 'Saved for later' : 'Removed from saved');
      utils.chat.getMessages.invalidate({ channelId });
      utils.chat.getSaved.invalidate();
    },
    onError: () => toast.error('Could not update saved items'),
  });

  const copyText = async () => {
    try {
      await navigator.clipboard.writeText(message.content);
      toast.success('Copied to clipboard');
    } catch {
      toast.error('Could not copy');
    }
  };

  const confirmDelete = () => {
    if (window.confirm('Delete this message? This cannot be undone.')) {
      deleteMessage.mutate({ messageId: message.id });
    }
  };

  const iconBtn =
    'flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground';

  return (
    <div
      className={cn(
        'absolute -top-4 right-2 z-10 flex items-center gap-0.5 rounded-lg border border-border/60 bg-popover p-0.5 shadow-sm',
        'opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100',
        menuOpen && 'opacity-100'
      )}
    >
      {QUICK_REACTIONS.map((emoji) => (
        <button
          key={emoji}
          type="button"
          aria-label={`React with ${emoji}`}
          title={`React ${emoji}`}
          onClick={() => toggle.mutate({ messageId: message.id, emoji })}
          className="flex size-7 items-center justify-center rounded-md text-base leading-none transition-colors hover:bg-muted"
        >
          <span aria-hidden>{emoji}</span>
        </button>
      ))}

      <EmojiPicker onPick={(emoji) => toggle.mutate({ messageId: message.id, emoji })}>
        <button type="button" aria-label="Add reaction" title="Add reaction" className={iconBtn}>
          <SmilePlus className="h-4 w-4" />
        </button>
      </EmojiPicker>

      {!hideReplyInThread && (
        <button
          type="button"
          aria-label="Reply in thread"
          title="Reply in thread"
          onClick={onReplyInThread}
          className={iconBtn}
        >
          <Reply className="h-4 w-4" />
        </button>
      )}

      <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
        <DropdownMenuTrigger
          aria-label="More actions"
          className={cn(iconBtn, 'aria-expanded:bg-muted aria-expanded:text-foreground')}
        >
          <MoreHorizontal className="h-4 w-4" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-44">
          {isOwn && (
            <DropdownMenuItem onClick={onEdit}>
              <Pencil />
              Edit
            </DropdownMenuItem>
          )}
          <DropdownMenuItem onClick={() => togglePin.mutate({ messageId: message.id })}>
            {message.isPinned ? <PinOff /> : <Pin />}
            {message.isPinned ? 'Unpin' : 'Pin to channel'}
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => toggleSave.mutate({ messageId: message.id })}>
            {message.isSaved ? <BookmarkCheck /> : <Bookmark />}
            {message.isSaved ? 'Remove from saved' : 'Save for later'}
          </DropdownMenuItem>
          <DropdownMenuItem onClick={copyText}>
            <Copy />
            Copy text
          </DropdownMenuItem>
          {canDelete && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem variant="destructive" onClick={confirmDelete}>
                <Trash2 />
                Delete
              </DropdownMenuItem>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
