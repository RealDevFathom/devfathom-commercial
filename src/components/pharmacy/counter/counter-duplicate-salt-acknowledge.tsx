'use client';

import { useState } from 'react';

import { Button } from '@/components/ui/button';
import { StatusPill } from '@/components/ui/status-pill';
import { counterErrorMessage } from '@/lib/pharmacy/counter-messages';
import {
  duplicateSaltGroupFingerprint,
  type DuplicateSaltGroup,
} from '@/lib/pharmacy/duplicate-salt';
import { trpc } from '@/lib/trpc';

export type CounterDuplicateSaltAcknowledgeProps = {
  branchId: string;
  saleId: string;
  ingredientKey: string;
  medicines: DuplicateSaltGroup['medicines'];
  disabled?: boolean;
};

function identityFor({
  branchId,
  saleId,
  ingredientKey,
  medicines,
}: Omit<CounterDuplicateSaltAcknowledgeProps, 'disabled'>): string {
  return JSON.stringify([
    branchId,
    saleId,
    ingredientKey,
    duplicateSaltGroupFingerprint(medicines),
  ]);
}

/**
 * #724: acknowledge a duplicate-salt warning.
 *
 * The warning is advice, never a block: the sale can be tendered whether or not
 * this is pressed. Pressing it writes an audited acknowledgement (the server
 * re-derives the duplicate from the stored bill) so a later review can see the
 * operator read the warning.
 */
export function CounterDuplicateSaltAcknowledge({
  branchId,
  saleId,
  ingredientKey,
  medicines,
  disabled = false,
}: CounterDuplicateSaltAcknowledgeProps) {
  const acknowledge = trpc.pharmacySales.acknowledgeDuplicateSalt.useMutation();
  const [acknowledgedFor, setAcknowledgedFor] = useState<string | null>(null);
  const identity = identityFor({ branchId, saleId, ingredientKey, medicines });

  if (acknowledgedFor === identity) {
    return (
      <span className="mt-2 flex items-center gap-2" role="status">
        <StatusPill status="acknowledged" tone="success" label="Acknowledged" />
      </span>
    );
  }

  return (
    <span className="mt-2 flex flex-wrap items-center gap-2">
      <Button
        type="button"
        variant="outline"
        size="touch"
        disabled={disabled || acknowledge.isPending}
        onClick={() =>
          acknowledge.mutate(
            { branchId, saleId, ingredientKey },
            { onSuccess: (recorded) => setAcknowledgedFor(identityFor(recorded)) }
          )
        }
      >
        {acknowledge.isPending ? 'Recording…' : 'Acknowledge'}
      </Button>
      {acknowledge.error ? (
        <span role="alert" className="text-xs text-destructive">
          {counterErrorMessage(acknowledge.error)}
        </span>
      ) : null}
    </span>
  );
}
