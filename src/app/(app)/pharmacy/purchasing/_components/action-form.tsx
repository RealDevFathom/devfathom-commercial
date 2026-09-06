'use client';

import {
  useSyncExternalStore,
  useRef,
  useTransition,
  useEffect,
  useId,
  type ReactNode,
} from 'react';

import { useRouter } from 'next/navigation';

import { cn } from '@/lib/utils';
import {
  PurchasingOutcome,
  usePurchasingOutcome,
  operationKey,
  type PurchasingOperation,
} from './action-outcomes';

const subscribe = () => () => {};
const clientReady = () => true;
const serverReady = () => false;

/**
 * WHA-1344: consume the action result explicitly. The affected client loses
 * x-action-redirect outcomes; render the result locally and refresh the current
 * route without replacing the document, selection or unrelated form drafts.
 */
type ActionFormProps = {
  action: (form: FormData) => Promise<string>;
  children: ReactNode;
  className?: string;
  operation?: PurchasingOperation;
};

export function PurchasingActionForm(props: ActionFormProps) {
  const fallbackId = useId();
  const operation = props.operation ?? { resource: fallbackId, action: 'submit' };
  // Only the explicit business operation changes form identity, never action props
  // or refresh completion. The page store retains the old operation's lock.
  return <ActionAttempt key={operationKey(operation)} {...props} operation={operation} />;
}

function ActionAttempt({
  action,
  children,
  className,
  operation,
}: ActionFormProps & { operation: PurchasingOperation }) {
  const router = useRouter();
  const ready = useSyncExternalStore(subscribe, clientReady, serverReady);
  const { store, shared, attempt, blocked } = usePurchasingOutcome(operation);
  const [, startTransition] = useTransition();
  const formRef = useRef<HTMLFormElement>(null);
  const errorRef = useRef<HTMLParagraphElement>(null);
  const errorId = useId();
  const notice = attempt?.phase === 'rejected' ? attempt : null;

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
      aria-busy={attempt?.phase === 'pending'}
      onSubmit={(event) => {
        event.preventDefault();
        if (blocked) return;
        // Capture before disabling controls; include named submit buttons (decisions).
        const form = new FormData(
          event.currentTarget,
          (event.nativeEvent as SubmitEvent).submitter
        );
        if (!store.begin(operation)) return;
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
              store.reject(
                operation,
                target.searchParams.get('notice') || 'The change could not be saved.',
                target.searchParams.get('field')
              );
              return;
            }
            if (
              target.searchParams.get('kind') !== 'success' ||
              target.searchParams.get('outcome') !== 'committed'
            ) {
              // Missing/unknown classification, including post-write failures, never unlocks.
              store.fail(operation);
              return;
            }
            // Outcome delivery does not depend on navigation or refresh completion.
            // refresh() merges the current route's RSC payload; it returns no success
            // acknowledgement. Keep this attempt locked even if the refresh fails.
            store.commit(
              operation,
              target.searchParams.get('notice') || 'The change was saved.',
              target.href
            );
            router.refresh();
          } catch {
            // A lost response may follow a committed write. Never retry it automatically.
            store.fail(operation);
          }
        });
      }}
    >
      {/* Layout utilities must target real child boxes, including space-y selectors.
          Disable until hydration: no native GET or unhandled POST fallback is safe
          for this explicit-result protocol. No-JS submission is intentionally unavailable. */}
      <fieldset className={cn('min-w-0', className)} disabled={!ready || blocked}>
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
      {!shared ? <PurchasingOutcome attempt={attempt} /> : null}
    </form>
  );
}
