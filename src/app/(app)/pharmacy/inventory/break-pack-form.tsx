'use client';

import { useId, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { inferRouterInputs } from '@trpc/server';

import { browserUuid } from '@/lib/browser-uuid';
import { BATCH_NOT_RECORDED } from '@/lib/pharmacy/unrecorded-batch';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { trpc } from '@/lib/trpc';
import type { AppRouter } from '@/server/routers/_app';

type BreakPackInput = inferRouterInputs<AppRouter>['pharmacyInventory']['breakPack'];

export type BreakPackFormProps = Pick<
  BreakPackInput,
  'branchId' | 'inventoryLotId' | 'stockLocationId'
> & {
  medicineName: string;
  /** DEV-853: null when the batch number was never recorded. */
  batchNumber: string | null;
  locationName: string;
  sealedPacks: number;
  looseUnits: number;
  unitsPerPack: number;
  onHandUnits: number;
  /** DEV-853: null when the expiry was never recorded; that is never "expired". */
  expiresAt: string | null;
  observedAt: number;
  unavailableReason: string | null;
};

type Stage = 'closed' | 'editing' | 'confirming' | 'pending' | 'success' | 'error' | 'unknown';

export function BreakPackForm(props: BreakPackFormProps) {
  const router = useRouter();
  const mutation = trpc.pharmacyInventory.breakPack.useMutation({ retry: false });
  const id = useId();
  const submitted = useRef(false);
  const [stage, setStage] = useState<Stage>('closed');
  const [count, setCount] = useState('1');
  const [message, setMessage] = useState('');
  const [confirmation, setConfirmation] = useState<{
    input: BreakPackInput;
    sealedPacks: number;
    looseUnits: number;
    onHandUnits: number;
    unitsPerPack: number;
  } | null>(null);

  const validArrangement =
    [props.sealedPacks, props.looseUnits, props.onHandUnits, props.unitsPerPack].every(
      (value) => Number.isSafeInteger(value) && value >= 0
    ) &&
    props.unitsPerPack > 0 &&
    props.onHandUnits === props.sealedPacks * props.unitsPerPack + props.looseUnits;
  const unavailable =
    props.unavailableReason ??
    (props.expiresAt !== null &&
    (!Number.isFinite(Date.parse(props.expiresAt)) ||
      Date.parse(props.expiresAt) <= props.observedAt)
      ? 'Batch is expired or its expiry is unavailable.'
      : !validArrangement
        ? 'Stock arrangement is unavailable. Refresh Inventory before opening packs.'
        : props.sealedPacks === 0
          ? 'No sealed packs available.'
          : null);
  const packCount = Number(count);
  const requiredLooseUnits = props.looseUnits + packCount * props.unitsPerPack;
  const countError =
    !/^[0-9]+$/.test(count) || !Number.isSafeInteger(packCount) || packCount < 1
      ? 'Enter a positive whole number of sealed packs.'
      : packCount > props.sealedPacks
        ? `Only ${props.sealedPacks} sealed packs are available.`
        : !Number.isSafeInteger(requiredLooseUnits)
          ? 'This count is too large.'
          : null;
  const changed =
    confirmation !== null &&
    (confirmation.sealedPacks !== props.sealedPacks ||
      confirmation.looseUnits !== props.looseUnits ||
      confirmation.onHandUnits !== props.onHandUnits ||
      confirmation.unitsPerPack !== props.unitsPerPack ||
      confirmation.input.branchId !== props.branchId ||
      confirmation.input.inventoryLotId !== props.inventoryLotId ||
      confirmation.input.stockLocationId !== props.stockLocationId);

  async function confirm() {
    if (submitted.current || !confirmation || unavailable || changed || stage !== 'confirming')
      return;
    if (props.expiresAt !== null && Date.parse(props.expiresAt) <= Date.now()) {
      setMessage('Batch has expired. No pack break submitted.');
      setStage('error');
      return;
    }
    // Keep the guard after an uncertain outcome: this API does not expose a status lookup.
    submitted.current = true;
    setStage('pending');
    try {
      const result = await mutation.mutateAsync(confirmation.input);
      if (
        !result ||
        !Number.isSafeInteger(result.packsToBreak) ||
        result.packsToBreak < 0 ||
        result.sealedPackDelta !== -result.packsToBreak ||
        result.looseUnitDelta !== result.packsToBreak * confirmation.unitsPerPack ||
        (result.packsToBreak > 0 && !result.movement?.id)
      ) {
        throw new Error('Unconfirmed response');
      }
      setMessage(
        result.packsToBreak === 0
          ? 'No packs opened: stock already meets the requested loose-unit total. Refreshing Inventory.'
          : `Pack break recorded: ${result.packsToBreak} sealed packs opened, ${result.looseUnitDelta} loose units released. Total units unchanged. Refreshing Inventory.`
      );
      setStage('success');
    } catch (error) {
      const code = (error as { data?: { code?: string } } | null)?.data?.code;
      if (code && ['FORBIDDEN', 'UNAUTHORIZED', 'BAD_REQUEST', 'NOT_FOUND'].includes(code)) {
        setMessage(
          `Pack break rejected. ${error instanceof Error ? error.message : 'Permission or stock validation failed.'} Refresh Inventory before trying again.`
        );
        setStage('error');
      } else {
        setMessage(
          'Outcome unknown. Do not submit another pack break. Reconcile this lot and location with the stock movement history before trying again.'
        );
        setStage('unknown');
      }
      return;
    }
    // Inventory uses uncached Server Component reads; refresh that source once after success.
    router.refresh();
  }

  return (
    <div className="ml-auto w-72 max-w-full space-y-3 text-left text-sm">
      <Button
        type="button"
        variant="secondary"
        className="min-h-11"
        aria-expanded={stage !== 'closed'}
        aria-controls={id}
        aria-describedby={unavailable ? `${id}-unavailable` : undefined}
        disabled={
          Boolean(unavailable) || ['pending', 'success', 'error', 'unknown'].includes(stage)
        }
        onClick={() => setStage(stage === 'closed' ? 'editing' : 'closed')}
      >
        Break pack
      </Button>
      {unavailable ? (
        <p id={`${id}-unavailable`} className="text-text-muted">
          {unavailable}
        </p>
      ) : null}
      <div id={id}>
        {stage !== 'closed' ? (
          <div className="space-y-3 rounded-[var(--radius-sm)] border border-border-subtle bg-surface-sunken p-3">
            <p className="text-text-strong">
              {props.medicineName} ·{' '}
              {props.batchNumber === null ? BATCH_NOT_RECORDED : `Batch ${props.batchNumber}`} ·{' '}
              {props.locationName}
            </p>
            <p className="tabular-nums text-text-body">
              {props.sealedPacks} sealed + {props.looseUnits} loose · {props.unitsPerPack} units per
              pack · {props.onHandUnits} total units
            </p>
            {stage === 'editing' ? (
              <form
                noValidate
                onSubmit={(event) => {
                  event.preventDefault();
                  if (unavailable || countError || submitted.current) return;
                  setConfirmation({
                    input: {
                      branchId: props.branchId,
                      inventoryLotId: props.inventoryLotId,
                      stockLocationId: props.stockLocationId,
                      requiredLooseUnits,
                      idempotencyKey: `inventory-break-pack:${browserUuid()}`,
                    },
                    sealedPacks: props.sealedPacks,
                    looseUnits: props.looseUnits,
                    onHandUnits: props.onHandUnits,
                    unitsPerPack: props.unitsPerPack,
                  });
                  setStage('confirming');
                }}
                className="space-y-3"
              >
                <label htmlFor={`${id}-count`} className="block text-text-body">
                  Sealed packs to open
                </label>
                <Input
                  id={`${id}-count`}
                  className="min-h-11"
                  inputMode="numeric"
                  type="number"
                  min={1}
                  max={props.sealedPacks}
                  step={1}
                  value={count}
                  onChange={(event) => setCount(event.target.value)}
                  aria-invalid={Boolean(countError)}
                  aria-describedby={countError ? `${id}-count-error` : undefined}
                />
                {countError ? (
                  <p id={`${id}-count-error`} role="alert" className="text-destructive">
                    {countError}
                  </p>
                ) : null}
                <Button
                  type="submit"
                  className="min-h-11"
                  disabled={Boolean(unavailable || countError)}
                >
                  Review break
                </Button>
              </form>
            ) : null}
            {stage === 'confirming' && confirmation ? (
              <div className="space-y-3">
                <p className="text-text-strong">
                  Open {packCount} sealed packs? Result: {confirmation.sealedPacks - packCount}{' '}
                  sealed + {confirmation.input.requiredLooseUnits} loose. Total stays{' '}
                  {confirmation.onHandUnits} units.
                </p>
                {changed ? (
                  <p role="alert" className="text-destructive">
                    Stock changed. Review the updated arrangement before confirming.
                  </p>
                ) : null}
                <div className="flex flex-wrap gap-2">
                  <Button
                    type="button"
                    className="min-h-11"
                    disabled={Boolean(unavailable) || changed}
                    onClick={confirm}
                  >
                    Confirm break pack
                  </Button>
                  <Button
                    type="button"
                    className="min-h-11"
                    variant="secondary"
                    onClick={() => setStage('editing')}
                  >
                    Back
                  </Button>
                </div>
              </div>
            ) : null}
            {stage === 'pending' ? (
              <p role="status">Recording pack break. Wait for confirmation.</p>
            ) : null}
            {stage === 'success' ? <p role="status">{message}</p> : null}
            {stage === 'error' || stage === 'unknown' ? (
              <p role="alert" className="text-destructive">
                {message}
              </p>
            ) : null}
            {stage === 'unknown' && confirmation ? (
              <p className="break-all font-mono text-xs text-text-muted">
                Reference: {confirmation.input.idempotencyKey}
              </p>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}
