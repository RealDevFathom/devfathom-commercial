'use client';

import { useCallback, useLayoutEffect, useRef, useState, type ComponentProps } from 'react';
import { Input } from '@/components/ui/input';

type Props = Omit<ComponentProps<typeof Input>, 'value' | 'defaultValue' | 'ref'> & {
  value: string;
  resetVersion: number;
  inputRef?: ComponentProps<typeof Input>['ref'];
  onDebouncedChange: (value: string) => void;
};

/** Keep per-character edits local; a scanner burst must not repaint the whole bill. */
export function CounterScanInput({
  value,
  resetVersion,
  inputRef,
  onDebouncedChange,
  onChange,
  onKeyDown,
  ...props
}: Props) {
  const [draft, setDraft] = useState(value);
  const [seenReset, setSeenReset] = useState(resetVersion);
  const timer = useRef<number | null>(null);
  const publish = useRef(onDebouncedChange);
  useLayoutEffect(() => {
    publish.current = onDebouncedChange;
  }, [onDebouncedChange]);
  // Parent query echoes are not resets: they may arrive after the next character.
  // Only an explicit clear, branch change or selection command replaces the draft.
  if (seenReset !== resetVersion) {
    setSeenReset(resetVersion);
    setDraft(value);
  }
  const cancel = useCallback(() => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = null;
  }, []);
  useLayoutEffect(() => {
    cancel();
    return cancel;
  }, [resetVersion, cancel]);
  return (
    <Input
      {...props}
      ref={inputRef}
      value={draft}
      onChange={(event) => {
        const next = event.target.value;
        setDraft(next);
        cancel();
        onChange?.(event);
        if (
          next.trim().length < 2 ||
          next.trim().startsWith(']d2') ||
          next.trim().startsWith('(01)')
        )
          return;
        timer.current = window.setTimeout(() => {
          timer.current = null;
          publish.current(next);
        }, 150);
      }}
      onKeyDown={(event) => {
        if (event.key === 'Enter') cancel();
        onKeyDown?.(event);
      }}
    />
  );
}
