'use client';

import { useSyncExternalStore, useRef, useState, useTransition, type ReactNode } from 'react';

const subscribe = () => () => {};
const clientReady = () => true;
const serverReady = () => false;

/**
 * WHA-1344: consume the action result explicitly. The affected client loses
 * x-action-redirect outcomes; a document navigation loads the existing notice
 * and selected record without depending on the client router's redirect path.
 */
export function PurchasingActionForm({
  action,
  children,
  className,
}: {
  action: (form: FormData) => Promise<string>;
  children: ReactNode;
  className?: string;
}) {
  const ready = useSyncExternalStore(subscribe, clientReady, serverReady);
  const [submitted, setSubmitted] = useState(false);
  const [failed, setFailed] = useState(false);
  const [, startTransition] = useTransition();
  const locked = useRef(false);

  return (
    <form
      className={className}
      aria-busy={submitted && !failed}
      onSubmit={(event) => {
        event.preventDefault();
        if (locked.current) return;
        // Capture before disabling controls; include named submit buttons (decisions).
        const form = new FormData(
          event.currentTarget,
          (event.nativeEvent as SubmitEvent).submitter
        );
        locked.current = true;
        setSubmitted(true);
        startTransition(async () => {
          try {
            const destination = await action(form);
            const target = new URL(destination, window.location.origin);
            if (
              target.origin !== window.location.origin ||
              !/^\/pharmacy\/purchasing\/(suppliers|orders|receiving|returns)$/.test(
                target.pathname
              )
            ) {
              throw new Error('Invalid purchasing destination');
            }
            window.location.replace(target.href);
          } catch {
            // A lost response may follow a committed write. Never retry it automatically.
            setFailed(true);
          }
        });
      }}
    >
      <fieldset className="contents" disabled={!ready || submitted}>
        {children}
      </fieldset>
      <noscript>Enable JavaScript to submit purchasing changes.</noscript>
      {submitted && !failed ? <p role="status">Saving and loading the outcome…</p> : null}
      {failed ? (
        <p role="alert" className="text-sm text-destructive">
          Could not confirm the outcome. Reload this page and check the record before retrying.
        </p>
      ) : null}
    </form>
  );
}
