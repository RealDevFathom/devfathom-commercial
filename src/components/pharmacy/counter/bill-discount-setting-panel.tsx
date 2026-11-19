'use client';

import { useState } from 'react';
import { PinAwareMessage } from '@/components/pharmacy/pin-aware-message';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { SectionCard } from '@/components/ui/section-card';
import { StatusPill } from '@/components/ui/status-pill';
import { trpc } from '@/lib/trpc';

/**
 * DEV-956 — the owner's switch for one whole-bill discount at the counter. Off by default; with
 * it off the counter shows no bill discount at all. It follows the same maximum discount, cost
 * floor, minimum margin and approvals as an item discount. Every change needs the owner's PIN.
 */
export function BillDiscountSettingPanel({ branchId }: { branchId: string }) {
  const query = trpc.pharmacySales.billDiscountSetting.useQuery({ branchId });
  const save = trpc.pharmacySales.saveBillDiscountSetting.useMutation();
  const [pin, setPin] = useState('');
  const [notice, setNotice] = useState('');
  const enabled = query.data?.enabled === true;
  const canChange = query.data?.canChange === true;
  const disabled = query.isLoading || query.isError || save.isPending || !canChange;
  const pinId = `bill-discount-pin-${branchId}`;
  const helpId = `bill-discount-help-${branchId}`;
  return (
    <SectionCard
      title="Whole-bill discount"
      eyebrow="Owner setting · all branches"
      actions={
        query.data ? (
          <StatusPill
            status={enabled ? 'active' : 'off'}
            tone={enabled ? 'success' : 'neutral'}
            label={enabled ? 'On' : 'Off'}
          />
        ) : null
      }
    >
      <p id={helpId} className="mb-4 text-sm text-text-muted">
        When on, the cashier can give one discount on the whole bill, as a percentage or an amount,
        before taking payment. It is shared over the bill&apos;s items by price, and the same limits
        apply as for an item discount: your maximum discount, the cost floor and the branch&apos;s
        minimum margin, and a manager&apos;s PIN unless the cashier&apos;s role may give discounts.
        Prescription, restricted and controlled medicines, and items with their own discount,
        voucher or promotion, are left out and the cashier is told. When off, nothing at the counter
        changes.
      </p>
      {query.isLoading ? <p role="status">Loading the whole-bill discount setting…</p> : null}
      {query.isError ? (
        <div role="alert" className="space-y-2">
          <p>The whole-bill discount setting is unavailable. Check your access to this branch.</p>
          <Button variant="outline" className="min-h-11" onClick={() => void query.refetch()}>
            Retry
          </Button>
        </div>
      ) : null}
      {query.data && canChange ? (
        <form
          className="flex flex-wrap items-end gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            if (disabled || !pin) return;
            void (async () => {
              try {
                const saved = await save.mutateAsync({ branchId, enabled: !enabled, pin });
                setPin('');
                const refreshed = await query.refetch();
                setNotice(
                  refreshed.error
                    ? 'Saved. Reload the page before making further changes.'
                    : saved.enabled
                      ? 'The whole-bill discount is on.'
                      : 'The whole-bill discount is off.'
                );
              } catch (error) {
                setPin('');
                setNotice(
                  error instanceof Error && error.message
                    ? error.message
                    : 'Could not save. Only the owner can change this setting.'
                );
              }
            })();
          }}
        >
          <div className="space-y-2">
            <Label htmlFor={pinId}>Your PIN</Label>
            <Input
              id={pinId}
              className="min-h-11 w-32"
              type="password"
              inputMode="numeric"
              autoComplete="off"
              disabled={disabled}
              aria-describedby={helpId}
              value={pin}
              onChange={(event) => {
                setNotice('');
                setPin(event.target.value);
              }}
            />
          </div>
          <Button
            type="submit"
            variant={enabled ? 'outline' : 'default'}
            className="min-h-11"
            disabled={disabled || !pin}
          >
            {save.isPending
              ? 'Saving…'
              : enabled
                ? 'Turn off whole-bill discount'
                : 'Turn on whole-bill discount'}
          </Button>
        </form>
      ) : null}
      {query.data && !canChange ? (
        <p className="text-sm text-text-muted">Only the owner can change this setting.</p>
      ) : null}
      {notice ? (
        <p role="status" className="mt-3 text-sm text-text-body">
          <PinAwareMessage message={notice} />
        </p>
      ) : null}
    </SectionCard>
  );
}
