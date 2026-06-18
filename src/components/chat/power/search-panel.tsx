'use client';

import { useState, useDeferredValue } from 'react';
import { formatDistanceToNow } from 'date-fns';
import { SearchIcon } from 'lucide-react';
import { trpc } from '@/lib/trpc';
import type { ChatMessage } from '@/lib/chat/contract';
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { Input } from '@/components/ui/input';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Avatar, AvatarImage, AvatarFallback } from '@/components/ui/avatar';
import { cn } from '@/lib/utils';

// ---------------------------------------------------------------------------
// Inline highlight helper — marks the matched query span in plaintext
// ---------------------------------------------------------------------------

function HighlightedSnippet({
  text,
  query,
}: {
  text: string;
  query: string;
}) {
  if (!query) return <>{text}</>;
  const lower = text.toLowerCase();
  const idx = lower.indexOf(query.toLowerCase());
  if (idx === -1) return <>{text}</>;
  return (
    <>
      {text.slice(0, idx)}
      <mark className="rounded-[2px] bg-primary/20 text-foreground not-italic">
        {text.slice(idx, idx + query.length)}
      </mark>
      {text.slice(idx + query.length)}
    </>
  );
}

// ---------------------------------------------------------------------------
// SearchPanel
// ---------------------------------------------------------------------------

export function SearchPanel({
  open,
  onOpenChange,
  channelId,
  onJump,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  channelId?: string | null;
  onJump?: (m: ChatMessage) => void;
}) {
  const [rawQuery, setRawQuery] = useState('');
  // useDeferredValue gives React room to interrupt the render while the user
  // keeps typing, keeping the input snappy without a manual setTimeout debounce.
  const query = useDeferredValue(rawQuery.trim());

  const { data: results = [], isFetching } = trpc.chat.searchMessages.useQuery(
    { query, channelId: channelId ?? undefined },
    { enabled: query.length > 1 }
  );

  function handleSelect(msg: ChatMessage) {
    onJump?.(msg);
    onOpenChange(false);
  }

  return (
    <Sheet open={open} onOpenChange={(o) => onOpenChange(o)}>
      <SheetContent
        side="right"
        className="flex w-[360px] flex-col gap-0 p-0 sm:max-w-[360px]"
      >
        <SheetHeader className="border-b border-border/60 px-4 pb-3 pt-4">
          <SheetTitle>Search messages</SheetTitle>
          <div className="relative mt-2">
            <SearchIcon className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={rawQuery}
              onChange={(e) => setRawQuery(e.target.value)}
              placeholder="Search…"
              className="pl-8"
               
              autoFocus
            />
          </div>
        </SheetHeader>

        <ScrollArea className="flex-1">
          {/* Idle state */}
          {query.length <= 1 && (
            <p className="p-6 text-center text-sm text-muted-foreground">
              Type at least 2 characters to search
            </p>
          )}

          {/* Loading skeletons */}
          {query.length > 1 && isFetching && results.length === 0 && (
            <div className="space-y-2 p-4">
              {[0, 1, 2].map((i) => (
                <div key={i} className="flex animate-pulse gap-2">
                  <div className="size-7 shrink-0 rounded-full bg-muted" />
                  <div className="flex-1 space-y-1.5 pt-0.5">
                    <div className="h-2.5 w-24 rounded bg-muted" />
                    <div className="h-2.5 w-full rounded bg-muted" />
                    <div className="h-2.5 w-4/5 rounded bg-muted" />
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* Empty state */}
          {query.length > 1 && !isFetching && results.length === 0 && (
            <p className="p-6 text-center text-sm text-muted-foreground">
              No messages found for &ldquo;{query}&rdquo;
            </p>
          )}

          {/* Results */}
          {results.length > 0 && (
            <ul>
              {(results as ChatMessage[]).map((msg) => (
                <li key={msg.id} className="border-b border-border/40 last:border-0">
                  <button
                    type="button"
                    onClick={() => handleSelect(msg)}
                    className={cn(
                      'w-full px-4 py-2.5 text-left transition-colors',
                      'hover:bg-muted/60 focus-visible:bg-muted/60 focus-visible:outline-none'
                    )}
                  >
                    <div className="mb-1 flex items-center gap-2">
                      <Avatar size="sm">
                        {msg.sender.avatar && (
                          <AvatarImage src={msg.sender.avatar} alt={msg.sender.name} />
                        )}
                        <AvatarFallback>
                          {msg.sender.name[0].toUpperCase()}
                        </AvatarFallback>
                      </Avatar>
                      <span className="text-xs font-medium text-foreground">
                        {msg.sender.name}
                      </span>
                      <span className="ml-auto shrink-0 text-xs text-muted-foreground">
                        {formatDistanceToNow(new Date(msg.createdAt), { addSuffix: true })}
                      </span>
                    </div>
                    <p className="line-clamp-2 pl-9 text-sm text-muted-foreground">
                      <HighlightedSnippet text={msg.content} query={query} />
                    </p>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </ScrollArea>
      </SheetContent>
    </Sheet>
  );
}
