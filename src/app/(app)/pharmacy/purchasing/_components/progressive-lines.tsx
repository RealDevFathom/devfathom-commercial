'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { flushSync } from 'react-dom';

type Line = { selector: ReactNode; fields: ReactNode; selected?: boolean };

/**
 * DEV-679: dispatched on the `[data-progressive-lines]` element by a reader that
 * fills several lines at once (`detail.count` = how many lines it needs). The
 * lines are mounted before `dispatchEvent` returns, so their fields can be filled.
 */
export const REVEAL_LINES_EVENT = 'progressive-lines:reveal';

/** Keep field values mounted when a selection is cleared so they can be restored. */
export function ProgressiveLines({ lines }: { lines: Line[] }) {
  const [count, setCount] = useState(1);
  const [selected, setSelected] = useState(() => lines.map((line) => !!line.selected));
  const root = useRef<HTMLDivElement>(null);
  const total = lines.length;

  useEffect(() => {
    const node = root.current;
    if (!node) return;
    const reveal = (event: Event) => {
      const wanted = (event as CustomEvent<{ count?: unknown }>).detail?.count;
      if (typeof wanted !== 'number' || !Number.isInteger(wanted) || wanted < 1) return;
      flushSync(() => setCount((current) => Math.min(total, Math.max(current, wanted))));
    };
    node.addEventListener(REVEAL_LINES_EVENT, reveal);
    return () => node.removeEventListener(REVEAL_LINES_EVENT, reveal);
  }, [total]);

  return (
    <div className="space-y-3" data-progressive-lines="" ref={root}>
      {lines.slice(0, count).map((line, index) => (
        <div className="space-y-3" key={index}>
          <div
            onChange={(event) => {
              if (event.target instanceof HTMLSelectElement) {
                const hasSelection = !!event.target.value;
                setSelected((previous) =>
                  previous.map((value, i) => (i === index ? hasSelection : value))
                );
              }
            }}
          >
            {line.selector}
          </div>
          <div hidden={!selected[index]}>{line.fields}</div>
        </div>
      ))}
      {count < lines.length && (
        <button
          className="inline-flex min-h-11 items-center justify-center rounded-[var(--radius-sm)] border border-border-default px-4 text-sm font-medium text-text-strong transition-colors hover:bg-muted focus-visible:ring-ring focus-visible:outline-none focus-visible:ring-2"
          onClick={() => setCount((current) => current + 1)}
          type="button"
        >
          Add line
        </button>
      )}
    </div>
  );
}
