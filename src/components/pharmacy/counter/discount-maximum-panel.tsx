'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { SectionCard } from '@/components/ui/section-card';
import { PERMISSION_LABELS } from '@/lib/abac/permission-labels';
import { BPS, NO_MAXIMUM_DISCOUNT_BPS } from '@/lib/pharmacy/smart-discount';
import { trpc } from '@/lib/trpc';

/** "12.5" → 1250 bps; null unless 0–100 with at most two decimal places. */
export function percentToBps(text: string): number | null {
  const trimmed = text.trim();
  if (!/^\d{1,3}(\.\d{1,2})?$/.test(trimmed)) return null;
  const bps = Math.round(Number(trimmed) * 100);
  return bps >= 0 && bps <= BPS ? bps : null;
}

const asPercent = (bps: number) => String(bps / 100);

const DISCOUNT_RIGHT_LABEL = PERMISSION_LABELS['pharmacy:discount'];

/**
 * DEV-66 — the owner's maximum discount for the whole organization. Until the owner sets
 * one, no maximum applies (the stored default), so nothing that worked before changes. Once
 * set, it binds everyone, the owner included, on every manual discount, promotion, voucher
 * and prepaid tier. Who may give a discount without a manager's PIN is a role permission,
 * not part of this form. Every change needs the owner's own PIN.
 */
export function DiscountMaximumPanel({ branchId }: { branchId: string }) {
  const query = trpc.pharmacySales.discountMaximum.useQuery({ branchId });
  const save = trpc.pharmacySales.saveDiscountMaximum.useMutation();
  const [draft, setDraft] = useState<string | null>(null);
  const [pin, setPin] = useState('');
  const [notice, setNotice] = useState('');
  const [invalid, setInvalid] = useState(false);
  const unset = query.data?.maxDiscountBps === NO_MAXIMUM_DISCOUNT_BPS;
  const loaded = query.data && !unset ? asPercent(query.data.maxDiscountBps) : '';
  const value = draft ?? loaded;
  const canChange = query.data?.canChange === true;
  const disabled = query.isLoading || query.isError || save.isPending || !canChange;
  const submit = async (maxDiscountBps: number, savedNotice: string) => {
    try {
      await save.mutateAsync({ branchId, maxDiscountBps, pin });
      setPin('');
      const refreshed = await query.refetch();
      if (refreshed.error) {
        setNotice('Saved. Reload the page before making further changes.');
        return;
      }
      setDraft(null);
      setInvalid(false);
      setNotice(savedNotice);
    } catch (error) {
      setPin('');
      setNotice(
        error instanceof Error && error.message
          ? error.message
          : 'Could not save. Only the owner can change the maximum discount.'
      );
    }
  };
  const inputId = `discount-maximum-${branchId}`;
  const pinId = `discount-maximum-pin-${branchId}`;
  return (
    <SectionCard title="Maximum discount" eyebrow="Owner setting · all branches">
      <p className="mb-4 text-sm text-text-muted">
        Once you set a maximum, no discount on a line can be more than this share of its price,
        whoever gives or approves it. A discount also never takes a line below its cost or the
        branch&apos;s minimum margin, and prescription, restricted and controlled medicines are
        never discounted. By default a manager approves each discount with their PIN. To let a role
        give discounts up to your maximum without one, give that role the permission &ldquo;
        {DISCOUNT_RIGHT_LABEL}&rdquo; (pharmacy:discount) in a custom role.
      </p>
      {query.isLoading ? <p role="status">Loading maximum discount…</p> : null}
      {query.isError ? (
        <div role="alert" className="space-y-2">
          <p>The maximum discount is unavailable. Check your access to this branch.</p>
          <Button variant="outline" onClick={() => void query.refetch()}>
            Retry
          </Button>
        </div>
      ) : null}
      {query.data && unset ? (
        <p className="mb-4 text-sm text-text-body">
          No maximum discount is set yet, so only the cost floor and the minimum margin limit a
          discount.
          {canChange ? ' Set one below to cap every discount.' : ''}
        </p>
      ) : null}
      <div className="flex flex-wrap items-end gap-3">
        <div className="space-y-2">
          <Label htmlFor={inputId}>Maximum discount (%)</Label>
          <Input
            id={inputId}
            className="min-h-11 w-32"
            inputMode="decimal"
            placeholder={unset ? 'Not set' : undefined}
            disabled={disabled}
            aria-invalid={invalid || undefined}
            aria-describedby={canChange ? undefined : `${inputId}-owner-only`}
            value={value}
            onChange={(event) => {
              setNotice('');
              setInvalid(false);
              setDraft(event.target.value);
            }}
          />
        </div>
        {canChange ? (
          <>
            <div className="space-y-2">
              <Label htmlFor={pinId}>Your PIN</Label>
              <Input
                id={pinId}
                className="min-h-11 w-32"
                type="password"
                inputMode="numeric"
                autoComplete="off"
                disabled={disabled}
                value={pin}
                onChange={(event) => {
                  setNotice('');
                  setPin(event.target.value);
                }}
              />
            </div>
            <Button
              className="min-h-11"
              disabled={disabled || draft === null || !pin}
              onClick={() => {
                if (draft === null) return;
                const maxDiscountBps = percentToBps(draft);
                if (maxDiscountBps === null) {
                  setInvalid(true);
                  setNotice('Enter a percentage from 0 to 100, with at most two decimal places.');
                  return;
                }
                void submit(maxDiscountBps, 'Maximum discount saved.');
              }}
            >
              {save.isPending ? 'Saving…' : 'Save maximum discount'}
            </Button>
            {/* DEV-929: the owner can go back to no maximum, with the same PIN. */}
            {query.data && !unset ? (
              <Button
                variant="outline"
                className="min-h-11"
                disabled={disabled || !pin}
                onClick={() =>
                  void submit(
                    NO_MAXIMUM_DISCOUNT_BPS,
                    'Maximum discount removed. No maximum is set.'
                  )
                }
              >
                Remove maximum
              </Button>
            ) : null}
          </>
        ) : null}
      </div>
      {query.data && !canChange ? (
        <p id={`${inputId}-owner-only`} className="mt-3 text-sm text-text-muted">
          Only the owner can change the maximum discount.
        </p>
      ) : null}
      {notice ? (
        <p role="status" className="mt-3 text-sm text-text-body">
          {notice}
        </p>
      ) : null}
    </SectionCard>
  );
}
