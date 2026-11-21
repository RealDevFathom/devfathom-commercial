'use client';

import { useState, type ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { SelectField } from '@/components/ui/select-field';
import { trpc } from '@/lib/trpc';
import { counterErrorMessage } from '@/lib/pharmacy/counter-messages';
import { formatMinor } from '@/lib/pharmacy/counter-receipt';
import type { readReturnHistory } from '@/lib/pharmacy/sales';
import { batchPhrase } from '@/lib/pharmacy/unrecorded-batch';
type History = Awaited<ReturnType<typeof readReturnHistory>>;
export type GroupLine = {
  saleLineId: string;
  canonicalUnits: number;
  lotId?: string;
  disposition: 'RESTOCK' | 'QUARANTINE';
  quarantineLocationId?: string;
  integrityDecision: string;
};
type Draft = { quantity: string; lot: string; disposition: '' | 'RESTOCK' | 'QUARANTINE' };
export function CounterMultiReturn({
  branchId,
  data,
  disabled,
  approval,
  approvalReady,
  onWitnessChange,
  confirm,
}: {
  branchId: string;
  data: History;
  disabled: boolean;
  approval: ReactNode;
  approvalReady: boolean;
  onWitnessChange: (controlled: boolean) => void;
  confirm: (
    lines: GroupLine[],
    reason: string,
    refund?: { originalTenderId: string; amountMinor: number; manualCashFallback: boolean }
  ) => void;
}) {
  const [rows, setRows] = useState<Record<string, Draft>>({});
  const [reason, setReason] = useState('');
  const [location, setLocation] = useState('');
  const [tenderId, setTender] = useState('');
  const [manual, setManual] = useState(false);
  const [review, setReview] = useState<{ lines: GroupLine[]; total: number } | null>(null);
  const [pricing, setPricing] = useState(false);
  const [error, setError] = useState('');
  const api = trpc.useUtils();
  const tender = data.tenders.find((t) => t.id === tenderId);
  const fallback = tender && !tender.prepaid && ['CARD', 'WALLET'].includes(tender.type);
  const update = (next: Record<string, Draft>) => {
    setReview(null);
    setRows(next);
    onWitnessChange(data.lines.some((l) => l.controlled && next[l.id]));
  };
  const needsLocation = Object.values(rows).some((r) => r.disposition === 'QUARANTINE');
  const lines: GroupLine[] = Object.entries(rows).map(([id, row]) => ({
    saleLineId: id,
    canonicalUnits: Number(row.quantity),
    lotId: row.lot || undefined,
    disposition: row.disposition || 'QUARANTINE',
    quarantineLocationId: row.disposition === 'QUARANTINE' ? location : undefined,
    integrityDecision:
      row.disposition === 'RESTOCK'
        ? 'Inspected and suitable to restock'
        : 'Set aside for inspection',
  }));
  const valid =
    lines.length >= 2 &&
    reason.trim().length > 0 &&
    tenderId &&
    (!needsLocation || location) &&
    (!fallback || manual) &&
    lines.every((l) => {
      const sold = data.lines.find((s) => s.id === l.saleLineId);
      const lot = sold?.lots.find((i) => i.lotId === l.lotId);
      return (
        sold &&
        rows[l.saleLineId]?.disposition &&
        Number.isSafeInteger(l.canonicalUnits) &&
        l.canonicalUnits > 0 &&
        l.canonicalUnits <=
          Math.min(sold.canonicalUnits - sold.returnedUnits, lot?.returnableUnits ?? Infinity) &&
        (l.disposition !== 'RESTOCK' || lot?.restockAllowed)
      );
    });
  const refundMinor =
    review && tender ? Math.min(review.total, tender.amountMinor - tender.refundedMinor) : 0;
  return (
    <div className="space-y-3">
      <fieldset disabled={disabled || pricing || !!review} className="space-y-3">
        <legend className="font-semibold">Choose returned lines</legend>
        {data.lines
          .filter((l) => l.returnedUnits < l.canonicalUnits)
          .map((line) => {
            const row = rows[line.id];
            const edit = (patch: Partial<Draft>) =>
              update({ ...rows, [line.id]: { ...row!, ...patch } });
            return (
              <div key={line.id} className="space-y-2 border-b border-border-subtle py-2">
                <label className="flex min-h-11 items-center gap-2">
                  <input
                    type="checkbox"
                    checked={!!row}
                    onChange={(e) => {
                      const next = { ...rows };
                      if (e.target.checked)
                        next[line.id] = { lot: '', quantity: '1', disposition: '' };
                      else delete next[line.id];
                      update(next);
                    }}
                  />
                  {line.name} · {line.canonicalUnits - line.returnedUnits} units available
                </label>
                {row && (
                  <div className="grid gap-2 sm:grid-cols-3">
                    <div>
                      <Label htmlFor={'qty-' + line.id}>Units of {line.name}</Label>
                      <Input
                        id={'qty-' + line.id}
                        type="number"
                        min={1}
                        max={line.canonicalUnits - line.returnedUnits}
                        value={row.quantity}
                        onChange={(e) => edit({ quantity: e.target.value })}
                      />
                    </div>
                    <div>
                      <Label htmlFor={'lot-' + line.id}>Batch of {line.name}</Label>
                      <SelectField
                        id={'lot-' + line.id}
                        value={row.lot}
                        onChange={(e) => edit({ lot: e.target.value, disposition: '' })}
                      >
                        <option value="">Unidentified batch</option>
                        {line.lots
                          .filter((l) => l.returnableUnits > 0)
                          .map((l) => (
                            <option key={l.lotId} value={l.lotId}>
                              {batchPhrase(l.batchNumber)} · {l.returnableUnits} units
                            </option>
                          ))}
                      </SelectField>
                    </div>
                    <div>
                      <Label htmlFor={'outcome-' + line.id}>Stock outcome for {line.name}</Label>
                      <SelectField
                        id={'outcome-' + line.id}
                        value={row.disposition}
                        onChange={(e) =>
                          edit({ disposition: e.target.value as Draft['disposition'] })
                        }
                      >
                        <option value="">Choose outcome</option>
                        <option
                          value="RESTOCK"
                          disabled={!line.lots.find((l) => l.lotId === row.lot)?.restockAllowed}
                        >
                          Restock inspected pack
                        </option>
                        <option value="QUARANTINE">Keep aside</option>
                      </SelectField>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        {needsLocation && (
          <>
            <Label htmlFor="group-location">Keep-aside location</Label>
            <SelectField
              id="group-location"
              value={location}
              onChange={(e) => setLocation(e.target.value)}
            >
              <option value="">Choose location</option>
              {data.locations.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name}
                </option>
              ))}
            </SelectField>
          </>
        )}
        <Label htmlFor="group-reason">Reason for return</Label>
        <Input
          id="group-reason"
          maxLength={500}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
        />
        <Label htmlFor="group-tender">Refund to</Label>
        <SelectField
          id="group-tender"
          value={tenderId}
          onChange={(e) => {
            setTender(e.target.value);
            setManual(false);
          }}
        >
          <option value="">Choose refund destination</option>
          <option value="none">Record return only</option>
          {data.tenders
            .filter((t) => t.amountMinor > t.refundedMinor)
            .map((t) => (
              <option key={t.id} value={t.id}>
                {t.prepaid ? 'Prepaid balance' : t.type} · PKR{' '}
                {formatMinor(t.amountMinor - t.refundedMinor)}
              </option>
            ))}
        </SelectField>
        {fallback && (
          <label className="flex min-h-11 items-center gap-2">
            <input type="checkbox" checked={manual} onChange={(e) => setManual(e.target.checked)} />
            Issue cash from the drawer and reconcile the original provider separately.
          </label>
        )}
        {!review && (
          <Button
            type="button"
            variant="outline"
            size="touch"
            disabled={!valid || pricing}
            onClick={async () => {
              setPricing(true);
              setError('');
              try {
                const amounts = await Promise.all(
                  lines.map((l) =>
                    api.client.pharmacySales.returnQuote.query({
                      branchId,
                      saleLineId: l.saleLineId,
                      canonicalUnits: l.canonicalUnits,
                      lotId: l.lotId,
                    })
                  )
                );
                setReview({ lines, total: amounts.reduce((n, a) => n + a.valueMinor, 0) });
              } catch (e) {
                setError(counterErrorMessage(e));
              } finally {
                setPricing(false);
              }
            }}
          >
            {pricing ? 'Pricing…' : 'Review selected lines'}
          </Button>
        )}
      </fieldset>
      {review && (
        <>
          <p role="status">
            {review.lines.length} lines · Returned value PKR {formatMinor(review.total)}
            {tender
              ? ` · Refund PKR ${formatMinor(refundMinor)} to ${tender.prepaid ? 'prepaid balance' : tender.type}`
              : ' · No refund now'}
          </p>
          {approval}
          <Button
            type="button"
            size="touch"
            variant="outline"
            disabled={disabled}
            onClick={() => setReview(null)}
          >
            Change selection
          </Button>
          <Button
            type="button"
            size="touch"
            disabled={disabled || !approvalReady || !valid || (!!tender && refundMinor <= 0)}
            onClick={() =>
              confirm(
                review.lines,
                reason.trim(),
                tender
                  ? {
                      originalTenderId: tender.id,
                      amountMinor: refundMinor,
                      manualCashFallback: Boolean(fallback && manual),
                    }
                  : undefined
              )
            }
          >
            Confirm selected returns
          </Button>
        </>
      )}
      {error && (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}
