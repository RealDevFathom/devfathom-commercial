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
import {
  PurchasingOutcome,
  usePurchasingOutcome,
  operationKey,
  allocationOperation,
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
  financialOperation?: 'supplier-credit-allocation';
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
  financialOperation,
}: ActionFormProps & { operation: PurchasingOperation }) {
  const router = useRouter();
  const ready = useSyncExternalStore(subscribe, clientReady, serverReady);
  const [selection, setSelection] = useState<PurchasingOperation | null>(null);
  const { store, shared, attempt, blocked } = usePurchasingOutcome(selection ?? operation);
  const [, startTransition] = useTransition();
  const formRef = useRef<HTMLFormElement>(null);
  const errorRef = useRef<HTMLParagraphElement>(null);
  const errorId = useId();
  const clientInvalidSeen = useRef(false);
  const [clientInvalid, setClientInvalid] = useState<{ field: string; message: string } | null>(
    null
  );
  const rejected = attempt?.phase === 'rejected' ? attempt : null;
  // A native constraint failure is shown inline just like a server rejection, so the
  // field is marked invalid and linked to its message instead of relying on a tooltip.
  // The newest feedback wins: a retained rejection must not mask a fresh client error.
  const notice = clientInvalid ?? rejected;

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
      onInvalidCapture={(event) => {
        const control = event.target;
        if (
          !(
            control instanceof HTMLInputElement ||
            control instanceof HTMLTextAreaElement ||
            control instanceof HTMLSelectElement
          )
        ) {
          return;
        }
        // Take over the native bubble: keep the first failing control, focus it and
        // explain the fix in the page. Submission is already blocked by the browser.
        event.preventDefault();
        if (clientInvalidSeen.current) return;
        clientInvalidSeen.current = true;
        // One validation pass fires an invalid event per failing control.
        queueMicrotask(() => {
          clientInvalidSeen.current = false;
        });
        const label = control.labels?.[0]?.textContent?.trim() || 'This field';
        setClientInvalid({
          field: control.name,
          message: control.validity.valueMissing
            ? `${label} is required.`
            : control.validationMessage || `${label} is not valid.`,
        });
        control.focus();
      }}
      onChange={(event) => {
        setClientInvalid(null);
        if (financialOperation) {
          setSelection(allocationOperation(new FormData(event.currentTarget)));
        }
      }}
      onSubmit={(event) => {
        event.preventDefault();
        setClientInvalid(null);
        if (!financialOperation && blocked) return;
        // Capture before disabling controls; include named submit buttons (decisions).
        const form = new FormData(
          event.currentTarget,
          (event.nativeEvent as SubmitEvent).submitter
        );
        // Re-read live selections immediately before claiming the shared lock;
        // rendered state, alternate forms and stale closures are not authority.
        const attemptOperation = financialOperation ? allocationOperation(form) : operation;
        if (financialOperation) setSelection(attemptOperation);
        if (!store.begin(attemptOperation)) return;
        startTransition(async () => {
          try {
            const destination = await action(form);
            const target = new URL(destination, window.location.origin);
            if (
              target.origin !== window.location.origin ||
              !/^\/pharmacy\/purchasing\/(suppliers|orders|reorder|receiving|returns)$/.test(
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
                attemptOperation,
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
              store.fail(attemptOperation);
              return;
            }
            // Outcome delivery does not depend on navigation or refresh completion.
            // refresh() merges the current route's RSC payload; it returns no success
            // acknowledgement. Keep this attempt locked even if the refresh fails.
            store.commit(
              attemptOperation,
              target.searchParams.get('notice') || 'The change was saved.',
              target.href
            );
            router.refresh();
          } catch {
            // A lost response may follow a committed write. Never retry it automatically.
            store.fail(attemptOperation);
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
