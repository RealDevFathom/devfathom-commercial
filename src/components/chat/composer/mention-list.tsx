'use client';

import { forwardRef, useEffect, useImperativeHandle, useState } from 'react';
import { AtSign } from 'lucide-react';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { cn } from '@/lib/utils';
import type { ChatUserLite } from '@/lib/chat/contract';

interface MentionListProps {
  items: ChatUserLite[];
  query: string;
  command: (item: ChatUserLite) => void;
}

export interface MentionListHandle {
  onKeyDown: (e: KeyboardEvent) => boolean;
}

/**
 * Suggestion popup shown when the user types `@` inside the composer.
 * Renders the channel roster (avatar + name); Enter or click inserts a
 * `mention` node. Keyboard navigation mirrors NoteLinkList's handle pattern.
 */
export const MentionList = forwardRef<MentionListHandle, MentionListProps>(
  ({ items, query, command }, ref) => {
    const [selected, setSelected] = useState(0);

    // Reset the cursor whenever the candidate list changes.
    useEffect(() => setSelected(0), [items, query]);

    useImperativeHandle(ref, () => ({
      onKeyDown: (e: KeyboardEvent) => {
        if (items.length === 0) return false;
        if (e.key === 'ArrowDown') {
          setSelected((s) => (s + 1) % items.length);
          return true;
        }
        if (e.key === 'ArrowUp') {
          setSelected((s) => (s - 1 + items.length) % items.length);
          return true;
        }
        if (e.key === 'Enter') {
          const item = items[selected];
          if (item) command(item);
          return true;
        }
        return false;
      },
    }));

    if (items.length === 0) {
      return (
        <div aria-live="polite" className="w-64 rounded-xl border border-border/60 bg-popover p-3 text-xs text-muted-foreground shadow-lg ring-1 ring-foreground/5">
          {query.trim() ? (
            <>
              No people matching &ldquo;<span className="text-foreground">{query.trim()}</span>&rdquo;
            </>
          ) : (
            'Type a name to mention…'
          )}
        </div>
      );
    }

    return (
      <div className="w-64 overflow-hidden rounded-xl border border-border/60 bg-popover shadow-lg ring-1 ring-foreground/5">
        <ul role="listbox" className="max-h-72 overflow-y-auto py-1">
          {items.map((item, i) => (
            <li key={item.id}>
              <button
                type="button"
                role="option"
                id={`mention-option-${item.id}`}
                aria-selected={i === selected}
                onMouseDown={(e) => {
                  e.preventDefault();
                  command(item);
                }}
                onMouseEnter={() => setSelected(i)}
                className={cn(
                  'flex w-full items-center gap-2.5 px-2.5 py-1.5 text-left text-sm transition-colors',
                  i === selected
                    ? 'bg-primary/10 text-foreground'
                    : 'text-muted-foreground hover:bg-secondary hover:text-foreground'
                )}
              >
                <Avatar size="sm" className="shrink-0">
                  <AvatarImage src={item.avatar ?? undefined} alt={item.name} />
                  <AvatarFallback className="bg-secondary text-[10px] font-medium">
                    {item.name.slice(0, 1).toUpperCase()}
                  </AvatarFallback>
                </Avatar>
                <span className="flex min-w-0 flex-col">
                  <span className="truncate font-medium text-foreground">{item.name}</span>
                  {item.title && (
                    <span className="truncate text-[11px] text-muted-foreground">{item.title}</span>
                  )}
                </span>
                <AtSign
                  className={cn(
                    'ml-auto size-3 shrink-0 transition-colors',
                    i === selected ? 'text-primary' : 'text-muted-foreground/30'
                  )}
                />
              </button>
            </li>
          ))}
        </ul>
      </div>
    );
  }
);

MentionList.displayName = 'MentionList';
