'use client';

import { formatDistanceToNow } from 'date-fns';
import { PinOffIcon } from 'lucide-react';
import { toast } from 'sonner';
import { trpc } from '@/lib/trpc';
import type { ChatMessage } from '@/lib/chat/contract';
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from '@/components/ui/sheet';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Button } from '@/components/ui/button';
import { Avatar, AvatarImage, AvatarFallback } from '@/components/ui/avatar';
import { Skeleton } from '@/components/ui/skeleton';

// ---------------------------------------------------------------------------
// PinsPanel
// ---------------------------------------------------------------------------

export function PinsPanel({
  channelId,
  open,
  onOpenChange,
}: {
  channelId: string;
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const utils = trpc.useUtils();

  const { data: pins = [], isLoading } = trpc.chat.getPins.useQuery(
    { channelId },
    { enabled: open }
  );

  const togglePin = trpc.chat.togglePin.useMutation({
    onSuccess: () => {
      void utils.chat.getPins.invalidate({ channelId });
      toast.success('Message unpinned');
    },
    onError: () => {
      toast.error('Failed to unpin message');
    },
  });

  const pinCount = (pins as ChatMessage[]).length;

  return (
    <Sheet open={open} onOpenChange={(o) => onOpenChange(o)}>
      <SheetContent side="right" className="flex w-[360px] flex-col gap-0 p-0 sm:max-w-[360px]">
        <SheetHeader className="border-b border-border/60 px-4 pb-3 pt-4">
          <SheetTitle>Pinned messages</SheetTitle>
          <SheetDescription>{pinCount > 0 ? `${pinCount} pinned` : 'No pins yet'}</SheetDescription>
        </SheetHeader>

        <ScrollArea className="flex-1">
          {/* Loading */}
          {isLoading && (
            <div className="space-y-3 p-4">
              {[0, 1, 2].map((i) => (
                <div key={i} className="flex gap-2">
                  <Skeleton className="size-7 shrink-0 rounded-full" />
                  <div className="flex-1 space-y-1.5 pt-0.5">
                    <Skeleton className="h-2.5 w-24" />
                    <Skeleton className="h-2.5 w-full" />
                    <Skeleton className="h-2.5 w-3/4" />
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* Empty */}
          {!isLoading && pinCount === 0 && (
            <p className="p-6 text-center text-sm text-muted-foreground">
              No pinned messages in this channel
            </p>
          )}

          {/* Pin list */}
          {!isLoading && pinCount > 0 && (
            <ul>
              {(pins as ChatMessage[]).map((msg) => (
                <li
                  key={msg.id}
                  className="group/pin border-b border-border/40 px-4 py-3 transition-colors last:border-0 hover:bg-muted/40"
                >
                  <div className="flex items-start gap-2">
                    <Avatar size="sm" className="mt-0.5 shrink-0">
                      {msg.sender.avatar && (
                        <AvatarImage src={msg.sender.avatar} alt={msg.sender.name} />
                      )}
                      <AvatarFallback>{msg.sender.name[0].toUpperCase()}</AvatarFallback>
                    </Avatar>

                    <div className="min-w-0 flex-1">
                      <div className="flex items-baseline gap-1.5">
                        <span className="text-xs font-medium text-foreground">
                          {msg.sender.name}
                        </span>
                        <span className="text-xs text-muted-foreground">
                          {formatDistanceToNow(new Date(msg.createdAt), { addSuffix: true })}
                        </span>
                      </div>
                      <p className="mt-0.5 line-clamp-3 text-sm text-muted-foreground">
                        {msg.content}
                      </p>
                    </div>

                    <Button
                      variant="ghost"
                      size="icon-xs"
                      title="Unpin message"
                      aria-label="Unpin message"
                      disabled={togglePin.isPending}
                      onClick={() => togglePin.mutate({ messageId: msg.id })}
                      className="mt-0.5 shrink-0 text-muted-foreground opacity-0 transition-opacity hover:text-destructive focus-visible:opacity-100 group-hover/pin:opacity-100"
                    >
                      <PinOffIcon className="size-3.5" />
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </ScrollArea>
      </SheetContent>
    </Sheet>
  );
}
