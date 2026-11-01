'use client';
import { useState } from 'react';
import { trpc } from '@/lib/trpc';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
export function PointsAdjustment({
  branchId,
  customerId,
  saleId,
}: {
  branchId: string;
  customerId: string;
  saleId: string;
}) {
  const mutation = trpc.pharmacySales.adjustPoints.useMutation();
  const [points, setPoints] = useState('');
  const [reason, setReason] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [key, setKey] = useState<string | null>(null);
  return (
    <form
      className="mt-5 space-y-3 border-t border-border-subtle pt-4"
      onKeyDown={(event) => {
        if (event.key === 'Escape') setConfirming(false);
      }}
      onSubmit={async (event) => {
        event.preventDefault();
        if (Number(points) < 0 && !confirming) {
          setConfirming(true);
          return;
        }
        const idempotencyKey = key ?? crypto.randomUUID();
        setKey(idempotencyKey);
        try {
          await mutation.mutateAsync({
            branchId,
            customerId,
            saleId,
            points: Number(points),
            reason,
            idempotencyKey,
          });
          window.location.reload();
        } catch {
          /* retained fields and key allow safe retry */
        }
      }}
    >
      <p className="text-sm text-text-muted">
        Owner/admin correction. Signed points and a reason are recorded permanently against this
        customer’s receipt.
      </p>
      <div className="flex flex-wrap items-end gap-3">
        <label className="grid gap-2 text-sm">
          Points to add or remove
          <Input
            type="number"
            min={-1000000}
            max={1000000}
            step={1}
            required
            value={points}
            disabled={mutation.isPending}
            onChange={(e) => {
              setPoints(e.target.value);
              setKey(null);
              setConfirming(false);
            }}
          />
        </label>
        <label className="grid flex-1 gap-2 text-sm">
          Adjustment reason
          <Input
            required
            minLength={3}
            maxLength={500}
            value={reason}
            disabled={mutation.isPending}
            onChange={(e) => {
              setReason(e.target.value);
              setKey(null);
              setConfirming(false);
            }}
          />
        </label>
        <Button
          className="min-h-11"
          variant={confirming ? 'destructive' : 'outline'}
          type="submit"
          disabled={mutation.isPending || !Number(points) || reason.trim().length < 3}
        >
          {mutation.isPending
            ? 'Recording…'
            : confirming
              ? 'Confirm points removal'
              : 'Record points correction'}
        </Button>
      </div>
      {confirming && (
        <div className="space-y-2 text-sm">
          <p role="alert">
            Remove {Math.abs(Number(points))} points? This correction and its reason remain in the
            audit ledger.
          </p>
          <Button
            type="button"
            variant="outline"
            className="min-h-11"
            disabled={mutation.isPending}
            onClick={() => setConfirming(false)}
          >
            Cancel removal
          </Button>
        </div>
      )}
      {mutation.isError && (
        <p role="alert" className="text-destructive">
          {mutation.error.message}
        </p>
      )}
    </form>
  );
}
