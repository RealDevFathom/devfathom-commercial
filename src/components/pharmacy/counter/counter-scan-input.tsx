'use client';

import { useEffect, useRef, useState, type ComponentProps } from 'react';
import { Input } from '@/components/ui/input';

/** Keep scanner digits local so every keystroke does not repaint the bill. */
export function CounterScanInput({
  value,
  resetVersion,
  debounceMs,
  isScan,
  onDraftChange,
  onSearch,
  onKeyDown,
  ...props
}: Omit<ComponentProps<typeof Input>, 'value' | 'onChange'> & {
  value: string;
  resetVersion: number;
  debounceMs: number;
  isScan: (text: string) => boolean;
  onDraftChange: () => void;
  onSearch: (text: string) => void;
}) {
  const [state, setState] = useState({ value, resetVersion, draft: value });
  if (state.value !== value || state.resetVersion !== resetVersion) {
    setState({ value, resetVersion, draft: value });
  }
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cancel = () => {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
  };
  useEffect(() => cancel(), [value, resetVersion]);
  useEffect(() => cancel, []);

  return (
    <Input
      {...props}
      value={state.draft}
      onChange={(event) => {
        const text = event.currentTarget.value;
        setState({ value, resetVersion, draft: text });
        cancel();
        onDraftChange();
        if (text.trim().length >= 2 && !isScan(text.trim())) {
          timer.current = setTimeout(() => onSearch(text), debounceMs);
        }
      }}
      onKeyDown={(event) => {
        if (event.key === 'Enter') cancel();
        onKeyDown?.(event);
      }}
    />
  );
}
