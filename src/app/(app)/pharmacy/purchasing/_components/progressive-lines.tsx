'use client';

import { useState, type ReactNode } from 'react';

type Line = { selector: ReactNode; fields: ReactNode; selected?: boolean };

/** Keep field values mounted when a selection is cleared so they can be restored. */
export function ProgressiveLines({ lines }: { lines: Line[] }) {
  const [count, setCount] = useState(1);
  const [selected, setSelected] = useState(() => lines.map((line) => !!line.selected));

  return (
    <div className="space-y-3">
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
