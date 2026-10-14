'use client';

/**
 * Right-side thread Sheet: the parent message, a reply-count divider, the
 * replies, and a composer pinned to the bottom that posts into the thread.
 *
 * Parent + replies reuse <MessageItem inThread> so reactions/edit/delete all
 * work, while the nested thread affordance is suppressed.
 */
import * as React from 'react';
import { Loader2, MessageSquare } from 'lucide-react';
import { differenceInMinutes } from 'date-fns';

import { trpc } from '@/lib/trpc';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { MessageItem } from './message-item';
import { MessageComposer } from '@/components/chat/composer/message-composer';

export function ThreadPanel({
  channelId,
  parentId,
  open,
  onOpenChange,
}: {
  channelId: string;
  parentId: string | null;
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const utils = trpc.useUtils();
  const { data, isLoading } = trpc.chat.getThread.useQuery(
    { parentId: parentId ?? '' },
    { enabled: open && !!parentId }
  );

  const bottomRef = React.useRef<HTMLDivElement | null>(null);
  const replyCount = data?.replies.length ?? 0;

  // Keep the latest reply in view on open and as replies arrive.
  React.useEffect(() => {
    if (!open) return;
    bottomRef.current?.scrollIntoView({ block: 'end' });
  }, [open, replyCount]);

  // Group replies with the same 5-minute/sender rule as the main timeline.
  const groupedReplies = React.useMemo(() => {
    const replies = data?.replies ?? [];
    return replies.map((m, i) => {
      const prev = replies[i - 1];
      const grouped =
        !!prev &&
        prev.sender.id === m.sender.id &&
        !prev.deletedAt &&
        differenceInMinutes(new Date(m.createdAt), new Date(prev.createdAt)) < 5;
      return { message: m, grouped };
    });
  }, [data]);

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        className="flex w-full flex-col gap-0 p-0 sm:max-w-md data-[side=right]:sm:max-w-md"
      >
        <SheetHeader className="flex-row items-center gap-2 border-b border-border/60 p-0 px-4 py-3 pr-12">
          <MessageSquare className="h-4 w-4 text-muted-foreground" />
          <SheetTitle>Thread</SheetTitle>
        </SheetHeader>

        <div className="flex-1 overflow-y-auto overscroll-contain">
          {isLoading || !data ? (
            <div className="flex items-center justify-center py-10 text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
            </div>
          ) : (
            <>
              <div className="py-1">
                <MessageItem message={data.parent} grouped={false} channelId={channelId} inThread />
              </div>

              <div className="flex items-center gap-3 px-4 py-2">
                <span className="text-xs font-medium text-muted-foreground">
                  {replyCount === 0
                    ? 'No replies yet'
                    : `${replyCount} ${replyCount === 1 ? 'reply' : 'replies'}`}
                </span>
                <div className="h-px flex-1 bg-border/60" />
              </div>

              <div className="pb-2">
                {groupedReplies.map(({ message, grouped }) => (
                  <MessageItem
                    key={message.id}
                    message={message}
                    grouped={grouped}
                    channelId={channelId}
                    inThread
                  />
                ))}
              </div>
              <div ref={bottomRef} />
            </>
          )}
        </div>

        <div className="border-t border-border/60 p-3">
          {parentId && (
            <MessageComposer
              channelId={channelId}
              parentId={parentId}
              placeholder="Reply…"
              autoFocus
              onSent={() => {
                utils.chat.getThread.invalidate({ parentId });
                utils.chat.getMessages.invalidate({ channelId });
              }}
            />
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
