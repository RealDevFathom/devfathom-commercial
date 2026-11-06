'use client';

import { useState, type FormEvent } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { PHARMACY_COUNT_MAX_VARIANCE_THRESHOLD_UNITS as MAX_UNITS } from '@/lib/pharmacy/count-variance-policy';
import { trpc } from '@/lib/trpc';

export function CountVarianceThresholdSettings({ initialUnits }: { initialUnits: number }) {
  const [saved, setSaved] = useState(initialUnits);
  const [units, setUnits] = useState(String(initialUnits));
  const [pin, setPin] = useState('');
  const [notice, setNotice] = useState<{ text: string; error: boolean } | null>(null);
  const mutation = trpc.pharmacyOperatingMode.setCountVarianceThreshold.useMutation({
    onSuccess: (result) => {
      setSaved(result.pharmacyCountVarianceThresholdUnits);
      setPin('');
      setNotice({ text: 'Count threshold saved and recorded in the audit log.', error: false });
    },
    onError: (error) => {
      setPin('');
      setNotice({ text: error.message, error: true });
    },
  });
  const parsed = /^\d{1,2}$/.test(units) ? Number(units) : NaN;
  const valid = Number.isSafeInteger(parsed) && parsed <= MAX_UNITS && /^\d{4,8}$/.test(pin);

  function submit(event: FormEvent) {
    event.preventDefault();
    setNotice(null);
    mutation.mutate({ thresholdUnits: parsed, pin });
  }

  return (
    <form className="space-y-5" onSubmit={submit}>
      <p className="max-w-2xl text-sm text-text-body">
        A stock count whose variance on any line is above{' '}
        <span className="font-medium tabular-nums">{saved} units</span> needs a second person (or
        the solo owner&apos;s PIN) to approve it. Counters cannot change this. Choose 0 (strictest)
        to {MAX_UNITS}.
      </p>
      <div className="grid max-w-xl gap-4 sm:grid-cols-2">
        <div>
          <Label htmlFor="count-variance-threshold">Threshold (units)</Label>
          <p id="count-variance-threshold-help" className="sr-only">
            Whole number from 0 to {MAX_UNITS}.
          </p>
          <Input
            id="count-variance-threshold"
            className="mt-1 min-h-11"
            type="number"
            inputMode="numeric"
            min={0}
            max={MAX_UNITS}
            step={1}
            required
            value={units}
            aria-invalid={!(parsed <= MAX_UNITS) || undefined}
            aria-describedby="count-variance-threshold-help"
            onChange={(event) => setUnits(event.target.value)}
          />
        </div>
        <div>
          <Label htmlFor="count-variance-pin">Owner PIN</Label>
          <Input
            id="count-variance-pin"
            className="mt-1 min-h-11"
            type="password"
            inputMode="numeric"
            autoComplete="off"
            pattern="[0-9]{4,8}"
            required
            value={pin}
            onChange={(event) => setPin(event.target.value)}
          />
        </div>
      </div>
      <Button type="submit" disabled={mutation.isPending || !valid}>
        {mutation.isPending ? 'Saving…' : 'Save threshold'}
      </Button>
      {notice ? (
        <p
          role={notice.error ? 'alert' : 'status'}
          className={notice.error ? 'text-sm text-destructive' : 'text-sm text-text-body'}
        >
          {notice.text}
        </p>
      ) : null}
    </form>
  );
}
