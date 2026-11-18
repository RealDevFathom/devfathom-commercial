'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { SectionCard } from '@/components/ui/section-card';
import { BPS } from '@/lib/pharmacy/smart-discount';
import { trpc } from '@/lib/trpc';

/** "12.5" → 1250 bps; null unless 0–100 with at most two decimal places. */
export function percentToBps(text: string): number | null {
  const trimmed = text.trim();
  if (!/^\d{1,3}(\.\d{1,2})?$/.test(trimmed)) return null;
  const bps = Math.round(Number(trimmed) * 100);
  return bps >= 0 && bps <= BPS ? bps : null;
}

const asPercent = (bps: number) => String(bps / 100);

/**
 * DEV-66 — the owner's maximum discount for the whole organization. It binds everyone,
 * the owner included, on every manual discount, promotion, voucher and prepaid tier. Who
 * may give a discount without a manager's PIN is a role permission ("Give discounts
 * without manager approval"), not part of this form.
 */
export function DiscountMaximumPanel({ branchId }: { branchId: string }) {
  const query = trpc.pharmacySales.discountMaximum.useQuery({ branchId });
  const save = trpc.pharmacySales.saveDiscountMaximum.useMutation();
  const [draft, setDraft] = useState<string | null>(null);
  const [notice, setNotice] = useState('');
  const [invalid, setInvalid] = useState(false);
  const loaded = query.data ? asPercent(query.data.maxDiscountBps) : null;
  const value = draft ?? loaded ?? '';
  const canChange = query.data?.canChange === true;
  const disabled = query.isLoading || query.isError || save.isPending || !canChange;
  const inputId = `discount-maximum-${branchId}`;
  return (
    <SectionCard title="Maximum discount" eyebrow="Owner setting · all branches">
      <p className="mb-4 text-sm text-text-muted">
        No discount on a line can be more than this share of its price, whoever gives or approves
        it. A discount also never takes a line below its cost or the branch&apos;s minimum margin,
        and prescription, restricted and controlled medicines are never discounted. By default a
        manager approves each discount with their PIN; you can let a role give discounts up to this
        limit without one by granting it &ldquo;pharmacy:discount&rdquo;.
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
      <div className="flex flex-wrap items-end gap-3">
        <div className="space-y-2">
          <Label htmlFor={inputId}>Maximum discount (%)</Label>
          <Input
            id={inputId}
            className="min-h-11 w-32"
            inputMode="decimal"
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
          <Button
            className="min-h-11"
            disabled={disabled || draft === null}
            onClick={async () => {
              if (draft === null) return;
              const maxDiscountBps = percentToBps(draft);
              if (maxDiscountBps === null) {
                setInvalid(true);
                setNotice('Enter a percentage from 0 to 100, with at most two decimal places.');
                return;
              }
              try {
                await save.mutateAsync({ branchId, maxDiscountBps });
                const refreshed = await query.refetch();
                if (refreshed.error) {
                  setNotice('Saved. Reload the page before making further changes.');
                  return;
                }
                setDraft(null);
                setNotice('Maximum discount saved.');
              } catch {
                setNotice('Could not save. Only the owner can change the maximum discount.');
              }
            }}
          >
            {save.isPending ? 'Saving…' : 'Save maximum discount'}
          </Button>
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
