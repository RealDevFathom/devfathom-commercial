'use client';

import { useState, type FormEvent } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { SectionCard } from '@/components/ui/section-card';
import { trpc } from '@/lib/trpc';

export function SeasonalCalendar({ branchId }: { branchId: string }) {
  const utils = trpc.useUtils();
  const calendar = trpc.pharmacyReports.seasonalCalendar.useQuery(
    { branchId },
    { enabled: Boolean(branchId) }
  );
  const save = trpc.pharmacyReports.saveSeasonalWindow.useMutation({
    onSuccess: () => utils.pharmacyReports.seasonalCalendar.invalidate({ branchId }),
  });
  const remove = trpc.pharmacyReports.deleteSeasonalWindow.useMutation({
    onSuccess: () => utils.pharmacyReports.seasonalCalendar.invalidate({ branchId }),
  });
  const denied =
    calendar.error?.data?.code === 'FORBIDDEN' || calendar.error?.data?.code === 'UNAUTHORIZED';
  const unavailable = !branchId || calendar.isPending || Boolean(calendar.error);
  const [name, setName] = useState('');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [pin, setPin] = useState('');
  function submit(event: FormEvent) {
    event.preventDefault();
    save.mutate(
      { branchId, name, startDate, endDate, enabled: true, confirmationPin: pin },
      {
        onSuccess: () => {
          setName('');
          setStartDate('');
          setEndDate('');
          setPin('');
        },
      }
    );
  }
  return (
    <SectionCard title="Seasonal demand calendar" titleLevel={2}>
      <p className="text-sm text-text-muted">
        Owner-only windows are persisted per branch and feed explainable replenishment uplift.
        Enabled windows may not overlap. Saving or deleting requires your owner PIN and is audited.
      </p>
      {!branchId ? (
        <p className="mt-4 text-sm text-text-muted">
          Select a branch to view its seasonal calendar.
        </p>
      ) : calendar.isPending ? (
        <p role="status" className="mt-4 text-sm text-text-muted">
          Loading seasonal calendar…
        </p>
      ) : calendar.error ? (
        <div role="alert" className="mt-4 text-sm text-destructive">
          <p>
            {denied
              ? 'You do not have permission to view this branch’s seasonal calendar.'
              : 'The seasonal calendar could not be loaded. Please try again.'}
          </p>
          {!denied && (
            <Button
              type="button"
              variant="outline"
              className="mt-3"
              disabled={calendar.isFetching}
              onClick={() => void calendar.refetch()}
            >
              Retry calendar
            </Button>
          )}
        </div>
      ) : calendar.data?.length ? (
        <ul className="mt-4 divide-y divide-border-default" aria-label="Seasonal windows">
          {calendar.data.map((window) => (
            <li
              key={window.id}
              className="flex flex-wrap items-center justify-between gap-3 py-3 text-sm"
            >
              <span>
                <strong>{window.name}</strong> · {window.startDate.toISOString().slice(0, 10)}–
                {window.endDate.toISOString().slice(0, 10)}
              </span>
              <Button
                type="button"
                variant="outline"
                disabled={unavailable || !pin || remove.isPending}
                onClick={() => remove.mutate({ branchId, id: window.id, confirmationPin: pin })}
              >
                Delete
              </Button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-4 text-sm text-text-muted">
          No seasonal windows recorded for this branch.
        </p>
      )}
      <form onSubmit={submit}>
        <fieldset disabled={unavailable} className="mt-5 grid gap-4 md:grid-cols-2">
          <legend className="sr-only">Add a seasonal window</legend>
          <label className="text-sm">
            Window name
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
              maxLength={120}
            />
          </label>
          <label className="text-sm">
            Owner PIN
            <Input
              value={pin}
              onChange={(e) => setPin(e.target.value)}
              required
              inputMode="numeric"
              type="password"
              pattern="[0-9]{4,12}"
              autoComplete="off"
            />
          </label>
          <label className="text-sm">
            Start date
            <Input
              value={startDate}
              onChange={(e) => setStartDate(e.target.value)}
              required
              type="date"
            />
          </label>
          <label className="text-sm">
            End date
            <Input
              value={endDate}
              onChange={(e) => setEndDate(e.target.value)}
              required
              type="date"
            />
          </label>
          <div className="md:col-span-2">
            <Button type="submit" disabled={!branchId || save.isPending}>
              Add seasonal window
            </Button>
          </div>
        </fieldset>
      </form>
      {(save.error || remove.error) && (
        <p role="alert" className="mt-3 text-sm text-destructive">
          {save.error?.message ?? remove.error?.message}
        </p>
      )}
    </SectionCard>
  );
}
