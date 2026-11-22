'use client';

import { SelectField as StudioSelect } from '@/components/ui/select-field';
import { useWorkspaceTimeZone } from '@/components/entitlements-provider';
import { useId, useState } from 'react';

import { Button } from '@/components/ui/button';
import type { CounterReceiptFormat } from '@/lib/pharmacy/counter-browser-print';

import { PACKING_SLIP_FORMATS, printPackingSlip, type PackingSlip } from './packing-slip';
import { useHydrated } from './transfer-action-form';

/** Requests the OS print dialog for one slip; it cannot confirm paper came out. */
export function PackingSlipPrintButton({ slip }: { slip: PackingSlip }) {
  const timeZone = useWorkspaceTimeZone();
  const [format, setFormat] = useState<CounterReceiptFormat>('A4');
  const [error, setError] = useState<string | null>(null);
  const selectId = useId();
  const errorId = useId();
  // A click before hydration would be silently dropped; say so by being disabled.
  const ready = useHydrated();

  return (
    <div className="flex flex-wrap items-center gap-2">
      <label className="sr-only" htmlFor={selectId}>
        Packing slip paper for {slip.reference}
      </label>
      <StudioSelect
        className="min-h-9 rounded-[var(--radius-sm)] border border-border-default bg-surface-raised px-2 text-sm text-text-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        id={selectId}
        onChange={(event) => setFormat(event.target.value as CounterReceiptFormat)}
        value={format}
      >
        {PACKING_SLIP_FORMATS.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </StudioSelect>
      <Button
        aria-describedby={error ? errorId : undefined}
        disabled={!ready}
        onClick={async () => {
          try {
            setError(null);
            await printPackingSlip({ ...slip, timeZone }, format);
          } catch (failure) {
            setError(
              failure instanceof Error ? failure.message : 'The packing slip could not be printed.'
            );
          }
        }}
        size="sm"
        type="button"
        variant="outline"
      >
        Print packing slip
      </Button>
      {error ? (
        <p className="basis-full text-xs text-destructive" id={errorId} role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
