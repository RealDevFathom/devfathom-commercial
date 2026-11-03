'use client';

import { Plus } from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Button } from '@/components/ui/button';

export type ProgressiveLine = {
  key: string;
  selector: ReactNode;
  fields: ReactNode;
  initiallySelected?: boolean;
};

/** Blank rows stay compact; revealed drafts survive clearing a medicine choice. */
export function ProgressiveLineSlots({
  addLabel = 'Add line',
  lines,
}: {
  addLabel?: string;
  lines: ProgressiveLine[];
}) {
  const initialCount = Math.max(
    Math.min(1, lines.length),
    ...lines.map((line, index) => (line.initiallySelected ? index + 1 : 0))
  );
  const [visibleCount, setVisibleCount] = useState(initialCount);
  const [selected, setSelected] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(lines.map((line) => [line.key, Boolean(line.initiallySelected)]))
  );
  const [revealed, setRevealed] = useState(selected);
  const root = useRef<HTMLDivElement>(null);
  const focusAdded = useRef(false);
  useEffect(() => {
    if (!focusAdded.current) return;
    focusAdded.current = false;
    root.current
      ?.querySelectorAll('[data-line-selector]')
      [visibleCount - 1]?.querySelector('select')
      ?.focus();
  }, [visibleCount]);

  return (
    <div ref={root} className="space-y-3">
      {lines.slice(0, visibleCount).map((line) => (
        <div className="space-y-3" key={line.key}>
          <div
            data-line-selector
            onChange={(event) => {
              const control = event.target;
              if (!(control instanceof HTMLSelectElement)) return;
              const chosen = control.value !== '';
              setSelected((current) => ({ ...current, [line.key]: chosen }));
              if (chosen) setRevealed((current) => ({ ...current, [line.key]: true }));
            }}
          >
            {line.selector}
          </div>
          {revealed[line.key] ? (
            <fieldset
              className="min-w-0"
              hidden={!selected[line.key]}
              disabled={!selected[line.key]}
            >
              {line.fields}
            </fieldset>
          ) : null}
        </div>
      ))}
      {visibleCount < lines.length ? (
        <Button
          type="button"
          size="touch"
          variant="outline"
          onClick={() => {
            focusAdded.current = true;
            setVisibleCount((count) => Math.min(count + 1, lines.length));
          }}
        >
          <Plus aria-hidden="true" />
          {addLabel}
        </Button>
      ) : null}
    </div>
  );
}
