'use client';

import { useState, useSyncExternalStore, useTransition, type ReactNode } from 'react';

import { cn } from '@/lib/utils';

import { loadTransfersPage } from './transfer-navigation';

export const TRANSFERS_ROUTE = '/pharmacy/inventory/transfers';

/** The page's Server Function answers with where to go, never by redirecting. */
export type TransferStepAction = (data: FormData) => Promise<string>;

const subscribe = () => () => {};
const clientReady = () => true;
const serverReady = () => false;

/** True once React owns the page; server HTML and pre-hydration clicks are inert. */
export function useHydrated() {
  return useSyncExternalStore(subscribe, clientReady, serverReady);
}

/**
 * Submits one transfer step and loads the destination it returns. The affected
 * client loses `x-action-redirect` outcomes (WHA-1344), so the result is
 * consumed explicitly, as the purchasing console does. Controls stay disabled
 * until hydration, while a step is in flight and while the next page loads: a
 * native POST fallback or a double click could repeat a stock movement.
 */
export function TransferActionForm({
  action,
  children,
  className,
  label,
}: {
  action: TransferStepAction;
  children: ReactNode;
  className?: string;
  label?: string;
}) {
  const ready = useHydrated();
  const [pending, startTransition] = useTransition();
  const [leaving, setLeaving] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const busy = pending || leaving;

  return (
    <form
      aria-busy={busy}
      aria-label={label}
      onSubmit={(event) => {
        event.preventDefault();
        if (busy) return;
        const data = new FormData(
          event.currentTarget,
          (event.nativeEvent as SubmitEvent).submitter
        );
        setFailure(null);
        startTransition(async () => {
          try {
            const target = new URL(await action(data), window.location.origin);
            if (target.origin !== window.location.origin || target.pathname !== TRANSFERS_ROUTE)
              throw new Error('Unexpected transfers destination');
            setLeaving(true);
            loadTransfersPage(`${target.pathname}${target.search}`);
          } catch {
            // A lost response may follow a committed step; never retry it blindly.
            setFailure(
              'The server did not confirm this step. Reload the page before trying again.'
            );
          }
        });
      }}
    >
      <fieldset className={cn('min-w-0', className)} disabled={!ready || busy}>
        {children}
      </fieldset>
      {failure ? (
        <p className="mt-2 text-sm text-destructive" role="alert">
          {failure}
        </p>
      ) : null}
    </form>
  );
}
