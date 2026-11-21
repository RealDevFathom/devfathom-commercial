'use client';

import { SelectField as StudioSelect } from '@/components/ui/select-field';

import { useActionState, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';

import { Button, buttonVariants } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

export type ReceivingState = {
  status: 'idle' | 'invalid' | 'rejected' | 'uncertain' | 'denied' | 'success';
  values: Record<string, string>;
  errors: Record<string, string>;
  idempotencyKey: string;
  message: string;
  retryAllowed?: boolean;
  receiptId?: string;
};

type ReceivingFormProps = {
  purchaseOrderId: string;
  lines: { id: string; name: string; unitCost: string }[];
  canReceive: boolean;
  initialState: ReceivingState;
  action: (previous: ReceivingState, form: FormData) => Promise<ReceivingState>;
};

const lineFields = [
  ['receivedQuantity', 'Received quantity'],
  ['unitCost', 'Unit cost'],
  ['batchCode', 'Batch'],
  ['expiryDate', 'Expiry'],
  ['discrepancyKind', 'Discrepancy kind'],
  ['discrepancyNote', 'Discrepancy note'],
] as const;

export function ReceivingForm({
  purchaseOrderId,
  lines,
  canReceive,
  initialState,
  action,
}: ReceivingFormProps) {
  const router = useRouter();
  // A background RSC refresh may supply a newly bound default location. Keep
  // this draft's original action until order identity remounts the form.
  const [receiveAction] = useState(() => action);
  const [values, setValues] = useState(initialState.values);
  const submitting = useRef(false);
  const formRef = useRef<HTMLFormElement>(null);
  const feedback = useRef<HTMLDivElement>(null);
  const [state, formAction, pending] = useActionState(
    async (previous: ReceivingState, form: FormData): Promise<ReceivingState> => {
      if (!canReceive || previous.status === 'denied' || previous.retryAllowed === false) {
        submitting.current = false;
        return previous;
      }
      let result: ReceivingState;
      try {
        result = await receiveAction(previous, form);
      } catch {
        // A lost response cannot establish whether the server committed. Keep
        // the exact submitted intent, including its opaque key, for replay.
        result = {
          ...previous,
          status: 'uncertain',
          values: Object.fromEntries(
            Object.keys(initialState.values).map((name) => [name, String(form.get(name) ?? '')])
          ),
          idempotencyKey: String(form.get('idempotencyKey') ?? previous.idempotencyKey),
          errors: {},
          message: 'The receipt result could not be confirmed. Your entries are preserved.',
        };
      }
      setValues(result.values);
      submitting.current = false;
      if (result.status === 'success') {
        // Only identifiers and a fixed success notice enter navigation. Receipt
        // fields and retry keys stay in the action body/state.
        const params = new URLSearchParams({
          selected: purchaseOrderId,
          notice: 'Receipt posted.',
          kind: 'success',
        });
        router.replace(`/restaurant/purchasing?${params}#receipt-${result.receiptId}`);
      }
      return result;
    },
    initialState
  );

  useEffect(() => {
    const form = formRef.current;
    if (!form) return;
    // React can suppress synthetic events during its post-action native reset.
    // Cancel on the form itself so failed actions retain every controlled value;
    // confirmed success clears the draft explicitly through action state.
    const preventNativeReset = (event: Event) => event.preventDefault();
    form.addEventListener('reset', preventNativeReset);
    return () => form.removeEventListener('reset', preventNativeReset);
  }, []);

  useEffect(() => {
    if (state.status !== 'idle') feedback.current?.focus();
  }, [state]);

  const uncertain = state.status === 'uncertain';
  const disabled =
    !canReceive || pending || state.status === 'denied' || state.retryAllowed === false;

  const fieldProps = (name: string) => ({
    id: `receiving-${name}`,
    name,
    value: values[name] ?? '',
    onChange: (event: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
      // React can replay an updater during the action transition. Capture the
      // input now rather than rereading a mutable DOM target during that replay.
      const value = event.target.value;
      setValues((current) => ({ ...current, [name]: value }));
    },
    'aria-invalid': Boolean(state.errors[name]),
    'aria-describedby': state.errors[name] ? `receiving-error-${name}` : undefined,
  });
  const fieldError = (name: string) =>
    state.errors[name] ? (
      <span id={`receiving-error-${name}`} className="mt-1 block text-sm text-destructive">
        {state.errors[name]}
      </span>
    ) : null;

  return (
    <form
      ref={formRef}
      action={formAction}
      aria-label="Receive stock"
      aria-busy={pending}
      className="mt-6 space-y-4"
      onSubmit={(event) => {
        if (submitting.current || disabled || state.status === 'success') event.preventDefault();
        else submitting.current = true;
      }}
    >
      <input type="hidden" name="purchaseOrderId" value={purchaseOrderId} />
      <input type="hidden" name="idempotencyKey" value={state.idempotencyKey} />
      <div>
        <h3 className="font-semibold text-text-strong">Receive stock</h3>
        <p className="mt-1 text-sm text-text-muted">
          Enter only quantities arriving in this receipt.
        </p>
      </div>
      {state.message && (
        <div
          ref={feedback}
          tabIndex={-1}
          role={state.status === 'success' ? 'status' : 'alert'}
          className="space-y-2 rounded-[var(--radius-sm)] border border-border-default bg-surface-raised p-4 text-sm text-text-body focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <p>{state.message}</p>
          {uncertain && (
            <>
              <p>
                This receipt may already be posted. Keep this form open. Check this order’s receipt
                history in a new tab before starting another receipt. Retry sends the same entries;
                editing stays locked until the result is confirmed.
              </p>
              <a
                className={buttonVariants({ variant: 'secondary', className: 'min-h-11' })}
                href={`/restaurant/purchasing?selected=${encodeURIComponent(purchaseOrderId)}#receipt-history`}
                target="_blank"
                rel="noopener noreferrer"
              >
                Check receipt history (new tab)
              </a>
            </>
          )}
          {state.receiptId && (
            <div className="flex flex-wrap items-center gap-3">
              <a className="underline" href={`#receipt-${state.receiptId}`}>
                View posted receipt
              </a>
              <a
                className={buttonVariants({ variant: 'secondary', className: 'min-h-11' })}
                href={`/restaurant/purchasing?selected=${encodeURIComponent(purchaseOrderId)}`}
              >
                Start another receipt
              </a>
            </div>
          )}
        </div>
      )}
      {state.status !== 'success' && (
        <>
          {lines.map((line) => (
            <fieldset
              className="grid gap-3 rounded-[var(--radius-sm)] border border-border-subtle p-4 sm:grid-cols-2"
              disabled={disabled}
              key={line.id}
            >
              <legend className="px-1 text-sm font-medium text-text-strong">{line.name}</legend>
              {lineFields.map(([field, label]) => {
                const name = `${field}:${line.id}`;
                return (
                  <label
                    key={field}
                    htmlFor={`receiving-${name}`}
                    className="text-sm text-text-body"
                  >
                    {label}
                    {field === 'discrepancyKind' ? (
                      <>
                        <StudioSelect
                          {...fieldProps(name)}
                          disabled={uncertain || disabled}
                          className="mt-1 min-h-11 w-full rounded-[var(--radius-sm)] border border-border-default bg-surface-raised px-3 text-text-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
                        >
                          <option value="">None</option>
                          <option value="SHORTAGE">Shortage</option>
                          <option value="OVERAGE">Overage</option>
                          <option value="DAMAGED">Damaged</option>
                          <option value="EXPIRED">Expired</option>
                          <option value="REJECTED">Rejected</option>
                          <option value="OTHER">Other</option>
                        </StudioSelect>
                        {uncertain && <input type="hidden" name={name} value={values[name]} />}
                      </>
                    ) : (
                      <Input
                        {...fieldProps(name)}
                        type={field === 'expiryDate' ? 'date' : 'text'}
                        inputMode={
                          field === 'receivedQuantity' || field === 'unitCost'
                            ? 'decimal'
                            : undefined
                        }
                        readOnly={uncertain}
                        className="mt-1 min-h-11"
                      />
                    )}
                    {fieldError(name)}
                  </label>
                );
              })}
            </fieldset>
          ))}
          <label htmlFor="receiving-reference" className="block text-sm text-text-body">
            Receipt reference
            <Input
              {...fieldProps('reference')}
              disabled={disabled}
              readOnly={uncertain}
              className="mt-1 min-h-11"
            />
            {fieldError('reference')}
          </label>
          <Button type="submit" disabled={disabled} className="min-h-11">
            {pending ? 'Receiving…' : uncertain ? 'Retry same receipt' : 'Receive purchase order'}
          </Button>
        </>
      )}
    </form>
  );
}
