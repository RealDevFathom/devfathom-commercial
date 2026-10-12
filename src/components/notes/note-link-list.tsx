'use client';

import { forwardRef, useEffect, useImperativeHandle, useState } from 'react';
import { FileText, Plus } from 'lucide-react';
import { cn } from '@/lib/utils';

export interface NoteLinkItem {
  id: string;
  title: string;
  isCreate?: boolean;
}

interface NoteLinkListProps {
  items: NoteLinkItem[];
  query: string;
  command: (item: NoteLinkItem) => void;
}

export interface NoteLinkListHandle {
  onKeyDown: (e: KeyboardEvent) => boolean;
}

/**
 * Suggestion popup shown when the user types `[[` inside the editor.
 * Renders a list of matching notes; pressing Enter or clicking inserts a noteLink node.
 * The first item is always a "Create new note" affordance using the current query.
 */
export const NoteLinkList = forwardRef<NoteLinkListHandle, NoteLinkListProps>(
  ({ items, query, command }, ref) => {
    const [selected, setSelected] = useState(0);

    // Build the full list with the synthetic "create new" entry on top.
    const fullList: NoteLinkItem[] = [
      ...(query.trim().length > 0
        ? [{ id: '__create__', title: query.trim(), isCreate: true } as NoteLinkItem]
        : []),
      ...items,
    ];

    useEffect(() => setSelected(0), [items, query]);

    useImperativeHandle(ref, () => ({
      onKeyDown: (e: KeyboardEvent) => {
        if (e.key === 'ArrowDown') {
          setSelected((s) => (s + 1) % Math.max(fullList.length, 1));
          return true;
        }
        if (e.key === 'ArrowUp') {
          setSelected((s) => (s - 1 + Math.max(fullList.length, 1)) % Math.max(fullList.length, 1));
          return true;
        }
        if (e.key === 'Enter') {
          const item = fullList[selected];
          if (item) command(item);
          return true;
        }
        return false;
      },
    }));

    if (fullList.length === 0) {
      return (
        <div className="rounded-xl border border-border bg-popover p-3 text-xs text-muted-foreground shadow-lg">
          Type to search notes…
        </div>
      );
    }

    return (
      <div className="w-72 overflow-hidden rounded-xl border border-border bg-popover shadow-lg">
        <ul className="max-h-72 overflow-y-auto py-1">
          {fullList.map((item, i) => (
            <li key={item.id + i}>
              <button
                type="button"
                onMouseDown={(e) => {
                  e.preventDefault();
                  command(item);
                }}
                onMouseEnter={() => setSelected(i)}
                className={cn(
                  'flex w-full items-center gap-2 px-3 py-2 text-left text-sm transition-colors',
                  i === selected
                    ? 'bg-primary/10 text-foreground'
                    : 'text-muted-foreground hover:bg-secondary hover:text-foreground'
                )}
              >
                {item.isCreate ? (
                  <Plus className="h-3.5 w-3.5 shrink-0 text-primary" />
                ) : (
                  <FileText className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                )}
                <span className="truncate">
                  {item.isCreate ? <>Create &ldquo;{item.title}&rdquo;</> : item.title}
                </span>
              </button>
            </li>
          ))}
        </ul>
      </div>
    );
  }
);

NoteLinkList.displayName = 'NoteLinkList';
