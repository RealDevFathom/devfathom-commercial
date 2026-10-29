'use client';
import { useState } from 'react';
import { trpc } from '@/lib/trpc';
import { SectionCard } from '@/components/ui/section-card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

type Policy = {
  pointsEnabled: boolean;
  earnEveryMinor: number;
  pointValueMinor: number;
  minimumRedeemPoints: number;
};
export function PointsSettings() {
  const policy = trpc.pharmacySales.pointsPolicy.useQuery();
  const save = trpc.pharmacySales.savePointsPolicy.useMutation();
  const [draft, setDraft] = useState<Policy | null>(null);
  const [saved, setSaved] = useState(false);
  if (policy.isLoading)
    return (
      <SectionCard title="Loading loyalty settings">
        <p role="status">Loading policy…</p>
      </SectionCard>
    );
  if (policy.isError || !policy.data)
    return (
      <SectionCard title="Settings unavailable">
        <p role="alert">
          Owner or administrator loyalty permission is required. If you have access, retry.
        </p>
        <Button variant="outline" onClick={() => void policy.refetch()}>
          Retry
        </Button>
      </SectionCard>
    );
  const value = draft ?? policy.data;
  return (
    <SectionCard title="Points programme" titleLevel={2}>
      <form
        className="space-y-5"
        onSubmit={async (event) => {
          event.preventDefault();
          setSaved(false);
          try {
            await save.mutateAsync(value);
            await policy.refetch();
            setDraft(null);
            setSaved(true);
          } catch {
            /* visible mutation error */
          }
        }}
      >
        <label className="flex min-h-11 items-center gap-3">
          <input
            type="checkbox"
            checked={value.pointsEnabled}
            disabled={save.isPending}
            onChange={(event) => {
              setDraft({ ...value, pointsEnabled: event.target.checked });
              setSaved(false);
            }}
          />
          Enable earning and redemption
        </label>
        <p className="text-sm text-text-muted">
          Only customers with current loyalty consent earn points. Disabling preserves balances and
          refund reversals. Rates use integer paisa; 100 paisa = PKR 1.
        </p>
        <div className="grid gap-5 md:grid-cols-3">
          {(
            [
              ['earnEveryMinor', 'Spend per earned point (paisa)', 100000000],
              ['pointValueMinor', 'Redemption value per point (paisa)', 1000000],
              ['minimumRedeemPoints', 'Minimum points per redemption', 1000000],
            ] as const
          ).map(([key, label, max]) => (
            <label key={key} className="grid gap-2 text-sm">
              {label}
              <Input
                type="number"
                min={1}
                max={max}
                step={1}
                required
                className="min-h-11"
                value={value[key]}
                disabled={save.isPending}
                onChange={(event) => {
                  setDraft({ ...value, [key]: Number(event.target.value) });
                  setSaved(false);
                }}
              />
            </label>
          ))}
        </div>
        <p className="text-sm text-text-muted">
          Policy changes record the previous and new values with the acting user. Refunds use the
          original sale rate.
        </p>
        {save.isError && (
          <p role="alert" className="text-destructive">
            {save.error.message}
          </p>
        )}
        {saved && <p role="status">Loyalty settings saved.</p>}
        <Button type="submit" className="min-h-11" disabled={save.isPending}>
          {save.isPending ? 'Saving…' : 'Save loyalty settings'}
        </Button>
      </form>
    </SectionCard>
  );
}
