'use client';

import { useEffect, useRef, useState, type ComponentProps } from 'react';
import { Input } from '@/components/ui/input';

type DraftState = {
  value: string;
  resetVersion: number;
  draft: string;
  /** Typed while a line was saving; a completed add's clear must not erase it. */
  buffered: boolean;
  /** A buffered draft handed to the counter once the save finished. */
  handover: { text: string } | null;
};

/**
 * Keep scanner digits local so every keystroke does not repaint the bill.
 *
 * DEV-575: while `buffering` (a line is saving) the field stays live. Scanner digits
 * are held here without cancelling the save, and a complete scan ending in Enter is
 * handed to `onQueueScan` so the next scan is never dropped. The parent's post-add
 * clear (`value` becoming empty) never erases a scan typed during the save. Any other
 * edit behaves as it does when idle.
 */
export function CounterScanInput({
  value,
  resetVersion,
  debounceMs,
  buffering = false,
  isScan,
  isScanPrefix,
  onDraftChange,
  onSearch,
  onQueueScan,
  onKeyDown,
  ...props
}: Omit<ComponentProps<typeof Input>, 'value' | 'onChange'> & {
  value: string;
  resetVersion: number;
  debounceMs: number;
  buffering?: boolean;
  isScan: (text: string) => boolean;
  isScanPrefix: (text: string) => boolean;
  onDraftChange: (text: string) => void;
  onSearch: (text: string) => void;
  onQueueScan?: (code: string) => void;
}) {
  const [state, setState] = useState<DraftState>({
    value,
    resetVersion,
    draft: value,
    buffered: false,
    handover: null,
  });
  let next = state;
  if (next.value !== value || next.resetVersion !== resetVersion) {
    // A post-add clear (an empty or unchanged value) keeps a scan typed during the save;
    // a new value set by the counter (a suggestion, a key typed over a receipt) replaces it.
    const keep = next.buffered && (value === '' || value === next.value);
    next = { ...next, value, resetVersion, draft: keep ? next.draft : value, buffered: keep };
  }
  // The save finished: anything typed meanwhile becomes a normal edit, which clears
  // the previous selection and searches typed text.
  if (!buffering && next.buffered) {
    next = { ...next, buffered: false, handover: next.draft ? { text: next.draft } : null };
  }
  if (next !== state) setState(next);

  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cancel = () => {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
  };
  const schedule = (text: string) => {
    cancel();
    if (text.trim().length >= 2 && !isScan(text.trim())) {
      timer.current = setTimeout(() => onSearch(text), debounceMs);
    }
  };
  useEffect(() => cancel(), [value, resetVersion]);
  useEffect(() => cancel, []);

  const latest = useRef({ onDraftChange, schedule });
  useEffect(() => {
    latest.current = { onDraftChange, schedule };
  });
  const handover = state.handover;
  useEffect(() => {
    if (!handover) return;
    latest.current.onDraftChange(handover.text);
    latest.current.schedule(handover.text);
  }, [handover]);

  return (
    <Input
      {...props}
      value={state.draft}
      onChange={(event) => {
        const text = event.currentTarget.value;
        // Only a scanner burst is held during a save; a human edit (a name, a cleared
        // field) is a normal edit and still cancels the pending scan.
        const hold = buffering && isScanPrefix(text.trim());
        setState({ value, resetVersion, draft: text, buffered: hold, handover: null });
        cancel();
        if (hold) return;
        onDraftChange(text);
        schedule(text);
      }}
      onKeyDown={(event) => {
        if (event.key === 'Enter') {
          cancel();
          if (buffering) {
            event.preventDefault();
            const code = event.currentTarget.value.trim();
            // Only a scan typed during this save is queued. A repeated Enter on the
            // code already being saved is a duplicate press, not a second item.
            if (state.buffered && isScan(code)) {
              onQueueScan?.(code);
              setState({ value, resetVersion, draft: '', buffered: false, handover: null });
            }
            return;
          }
        }
        onKeyDown?.(event);
        // The submitted code stays visible while it is added, selected so the next
        // scanner burst replaces it instead of appending to it.
        if (event.key === 'Enter' && isScan(event.currentTarget.value.trim()))
          event.currentTarget.select();
      }}
    />
  );
}
