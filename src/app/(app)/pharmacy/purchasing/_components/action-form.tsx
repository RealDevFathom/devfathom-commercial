'use client';

import {
  useSyncExternalStore,
  useRef,
  useState,
  useTransition,
  useEffect,
  useId,
  type ReactNode,
} from 'react';

import { useRouter } from 'next/navigation';

import { cn } from '@/lib/utils';

const subscribe = () => () => {};
const clientReady = () => true;
const serverReady = () => false;

/**
 * WHA-1344: consume the action result explicitly. The affected client loses
 * x-action-redirect outcomes; render the result locally and refresh the current
 * route without replacing the document, selection or unrelated form drafts.
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
  const router = useRouter();
  const [success, setSuccess] = useState<string | null>(null);
  const ready = useSyncExternalStore(subscribe, clientReady, serverReady);
  const [submitted, setSubmitted] = useState(false);
  const [failed, setFailed] = useState(false);
  const [, startTransition] = useTransition();
  const locked = useRef(false);
  const formRef = useRef<HTMLFormElement>(null);
  const errorRef = useRef<HTMLParagraphElement>(null);
  const errorId = useId();
  const [notice, setNotice] = useState<{ message: string; field: string | null } | null>(null);

  useEffect(() => {
    if (!notice) return;
    const control = notice.field ? formRef.current?.elements.namedItem(notice.field) : null;
    if (
      !(control instanceof HTMLElement) ||
      (control instanceof HTMLInputElement && control.type === 'hidden')
    ) {
      errorRef.current?.focus();
      return;
    }
    const invalid = control.getAttribute('aria-invalid');
    const describedBy = control.getAttribute('aria-describedby');
    control.setAttribute('aria-invalid', 'true');
    control.setAttribute('aria-describedby', [describedBy, errorId].filter(Boolean).join(' '));
    control.focus();
    return () => {
      if (invalid === null) control.removeAttribute('aria-invalid');
      else control.setAttribute('aria-invalid', invalid);
      if (describedBy === null) control.removeAttribute('aria-describedby');
      else control.setAttribute('aria-describedby', describedBy);
    };
  }, [notice, errorId]);

  return (
    <form
      ref={formRef}
      aria-busy={submitted && !failed && !success}
      onSubmit={(event) => {
        event.preventDefault();
        if (locked.current) return;
        // Capture before disabling controls; include named submit buttons (decisions).
        const form = new FormData(
          event.currentTarget,
          (event.nativeEvent as SubmitEvent).submitter
        );
        locked.current = true;
        setNotice(null);
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
            if (
              target.searchParams.get('kind') === 'error' &&
              target.searchParams.get('outcome') === 'rejected'
            ) {
              // Keep the live controls and selected record; do not reset entered values.
              setNotice({
                message: target.searchParams.get('notice') || 'The change could not be saved.',
                field: target.searchParams.get('field'),
              });
              locked.current = false;
              setSubmitted(false);
              return;
            }
            if (
              target.searchParams.get('kind') !== 'success' ||
              target.searchParams.get('outcome') !== 'committed'
            ) {
              // Missing/unknown classification, including post-write failures, never unlocks.
              setFailed(true);
              return;
            }
            // Outcome delivery does not depend on navigation or refresh completion.
            // refresh() merges the current route's RSC payload; it returns no success
            // acknowledgement. Keep this attempt locked even if the refresh fails.
            setSuccess(target.searchParams.get('notice') || 'The change was saved.');
            router.refresh();
          } catch {
            // A lost response may follow a committed write. Never retry it automatically.
            setFailed(true);
          }
        });
      }}
    >
      {/* Layout utilities must target real child boxes, including space-y selectors.
          Disable until hydration: no native GET or unhandled POST fallback is safe
          for this explicit-result protocol. No-JS submission is intentionally unavailable. */}
      <fieldset className={cn('min-w-0', className)} disabled={!ready || submitted}>
        {children}
      </fieldset>
      {!ready ? (
        <p role="status">Preparing purchasing form. If controls stay disabled, reload this page.</p>
      ) : null}
      {notice ? (
        <p
          ref={errorRef}
          id={errorId}
          role="alert"
          tabIndex={-1}
          className="text-sm text-destructive"
        >
          {notice.message}
        </p>
      ) : null}
      <noscript>Enable JavaScript to submit purchasing changes.</noscript>
      {success ? (
        <p role="status" className="text-sm text-success">
          {success} Check the updated record before starting another change.
        </p>
      ) : null}
      {submitted && !failed && !success ? (
        <p role="status">Saving and loading the outcome…</p>
      ) : null}
      {failed ? (
        <p role="alert" className="text-sm text-destructive">
          {success
            ? 'The change was saved, but the records could not be refreshed. Check the record before retrying.'
            : 'Could not confirm the outcome. Reload this page and check the record before retrying.'}
        </p>
      ) : null}
    </form>
  );
}
