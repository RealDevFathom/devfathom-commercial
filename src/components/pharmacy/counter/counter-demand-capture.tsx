'use client';

import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import type { LostSaleOutcome } from '@/lib/pharmacy/lost-sales';

export type DemandCaptureOptions = {
  notifyOptIn: boolean;
  notifyPhone?: string;
  notifyConsentRecorded?: true;
  visitType?: 'PARTIAL' | 'WALK_OUT';
};

/** Mount with a branch/sale/customer/item key so consent never crosses visits. */
export function CounterDemandCapture({
  disabled,
  units,
  hasBasket,
  onCapture,
}: {
  disabled: boolean;
  units: number;
  hasBasket: boolean;
  onCapture: (outcome: LostSaleOutcome, options: DemandCaptureOptions) => Promise<boolean>;
}) {
  const [open, setOpen] = useState(false);
  const [armed, setArmed] = useState(false);
  const [notify, setNotify] = useState(false);
  const [phone, setPhone] = useState('');
  const [visitType, setVisitType] = useState<'PARTIAL' | 'WALK_OUT' | ''>('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const capture = useRef(onCapture);
  useEffect(() => {
    capture.current = onCapture;
  }, [onCapture]);

  async function save(outcome: LostSaleOutcome, explicit: boolean) {
    if (savingRef.current) return;
    setArmed(false);
    if (explicit && notify && (phone.trim().length < 7 || phone.trim().length > 32)) {
      setError('Enter a phone number between 7 and 32 characters.');
      return;
    }
    savingRef.current = true;
    setSaving(true);
    setError(null);
    // The automatic default saves only the demand. Sending contact details
    // requires the operator to explicitly save this customer's opt-in.
    try {
      const saved = await capture.current(outcome, {
        notifyOptIn: explicit && notify,
        ...(explicit && notify ? { notifyPhone: phone.trim(), notifyConsentRecorded: true } : {}),
        ...(visitType ? { visitType } : {}),
      });
      if (!saved) {
        setError('Capture failed. Choose an outcome to retry.');
        setOpen(true);
        return;
      }
      setOpen(false);
      setNotify(false);
      setPhone('');
      setVisitType('');
    } catch {
      setError('Capture failed. Choose an outcome to retry.');
      setOpen(true);
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  }
  const saveDefault = useRef(() => save('UNKNOWN', false));
  useEffect(() => {
    saveDefault.current = () => save('UNKNOWN', false);
  });
  useEffect(() => {
    if (!armed) return;
    const timer = window.setTimeout(() => void saveDefault.current(), 5_000);
    return () => window.clearTimeout(timer);
  }, [armed]);

  return (
    <>
      <Button
        type="button"
        variant="outline"
        className="h-auto min-h-11 whitespace-normal"
        disabled={disabled || saving}
        onClick={() => {
          setOpen(true);
          setArmed(true);
        }}
      >
        {saving ? 'Capturing…' : `Capture shortfall: ${units} canonical units`}
      </Button>
      <Sheet open={open} onOpenChange={setOpen} modal={false}>
        <SheetContent
          side="bottom"
          className="max-h-[80dvh] overflow-y-auto p-4"
          showOverlay={false}
          aria-busy={saving}
        >
          <SheetHeader className="p-0">
            <SheetTitle>What happened at the counter?</SheetTitle>
            <SheetDescription>
              Choose an outcome. Unknown is saved after five seconds, even if you close this sheet.
              Tender stays available.
            </SheetDescription>
          </SheetHeader>
          <div
            className="flex flex-wrap gap-2"
            role="group"
            aria-label="Unfulfilled demand outcome"
          >
            {(
              [
                ['SUBSTITUTE_TAKEN', 'Substitute taken'],
                ['WILL_RETURN', 'Will return'],
                ['WENT_ELSEWHERE', 'Went elsewhere'],
                ['ORDERED_FOR_CUSTOMER', 'Ordered for customer'],
                ['UNKNOWN', 'Save as unknown'],
              ] as const
            ).map(([outcome, label]) => (
              <Button
                key={outcome}
                type="button"
                variant="outline"
                disabled={disabled || saving}
                onClick={() => void save(outcome, true)}
              >
                {label}
              </Button>
            ))}
          </div>
          {hasBasket ? (
            <label className="flex flex-wrap items-center gap-2">
              Basket outcome
              <select
                aria-label="Basket outcome"
                className="min-h-11 rounded-md border border-input bg-surface-card px-3"
                value={visitType}
                disabled={disabled || saving}
                onChange={(event) => setVisitType(event.target.value as typeof visitType)}
              >
                <option value="">Determine from completed purchase</option>
                <option value="PARTIAL">Customer is buying part of the basket</option>
                <option value="WALK_OUT">Customer abandoned the whole basket</option>
              </select>
            </label>
          ) : null}
          <label className="flex min-h-11 items-center gap-2">
            <input
              type="checkbox"
              checked={notify}
              disabled={disabled || saving}
              onChange={(event) => setNotify(event.target.checked)}
            />
            Notify when back (opt-in)
          </label>
          {notify ? (
            <div className="space-y-1.5">
              <Label htmlFor="demand-notification-phone">Notification phone</Label>
              <Input
                id="demand-notification-phone"
                inputMode="tel"
                placeholder="Phone number"
                value={phone}
                disabled={disabled || saving}
                onChange={(event) => setPhone(event.target.value)}
                aria-invalid={!!error}
                aria-describedby={error ? 'demand-capture-error' : undefined}
              />
            </div>
          ) : null}
          {error ? (
            <p id="demand-capture-error" role="alert" className="text-destructive">
              {error}
            </p>
          ) : null}
        </SheetContent>
      </Sheet>
    </>
  );
}
