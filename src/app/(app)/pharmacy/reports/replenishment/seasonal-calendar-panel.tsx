'use client';

import { SelectField as StudioSelect } from '@/components/ui/select-field';

import { useId, useState, type FormEvent } from 'react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { SectionCard } from '@/components/ui/section-card';
import { StatusPill } from '@/components/ui/status-pill';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { demandDateAfter } from '@/lib/pharmacy/demand-evidence';
import { SEASONAL_WINDOW_KINDS, type SeasonalWindowKind } from '@/lib/pharmacy/seasonal-calendar';
import { trpc } from '@/lib/trpc';

const KIND_LABELS: Record<SeasonalWindowKind, string> = {
  DENGUE: 'Dengue season',
  FLU: 'Flu season',
  RAMADAN: 'Ramadan',
  MONSOON: 'Monsoon',
  CUSTOM: 'Custom',
};
const selectClass =
  'mt-1 min-h-11 w-full rounded-md border border-input bg-surface-raised px-3 text-sm text-text-strong focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-50';

type Draft = {
  id?: string;
  kind: SeasonalWindowKind;
  label: string;
  startDate: string;
  endDateExclusive: string;
};

/** DEV-74: owner-editable branch seasonal calendar and per-salt spike flags. */
export function SeasonalCalendarPanel({ branchId, today }: { branchId: string; today: string }) {
  const formId = useId();
  const utils = trpc.useUtils();
  const calendar = trpc.pharmacyReports.seasonalCalendar.useQuery({ branchId }, { retry: false });
  const spikeFrom = demandDateAfter(today, -13);
  const spikes = trpc.pharmacyReports.saltSpikes.useQuery(
    { branchId, from: spikeFrom, to: today },
    { retry: false }
  );
  const empty: Draft = {
    kind: 'DENGUE',
    label: KIND_LABELS.DENGUE,
    startDate: today,
    endDateExclusive: demandDateAfter(today, 30),
  };
  const [draft, setDraft] = useState<Draft>(empty);
  const [error, setError] = useState('');
  const refresh = () => utils.pharmacyReports.seasonalCalendar.invalidate({ branchId });
  const save = trpc.pharmacyReports.saveSeasonalWindow.useMutation({
    onSuccess: async () => {
      setDraft(empty);
      setError('');
      await refresh();
    },
    onError: (failure) => setError(failure.message || 'The seasonal window could not be saved.'),
  });
  const remove = trpc.pharmacyReports.deleteSeasonalWindow.useMutation({
    onSuccess: refresh,
    onError: (failure) => setError(failure.message || 'The seasonal window could not be removed.'),
  });
  const canEdit = calendar.data?.canEdit === true;
  const busy = save.isPending || remove.isPending;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!draft.label.trim()) return setError('Enter a label for this window.');
    if (!draft.startDate || !draft.endDateExclusive || draft.endDateExclusive <= draft.startDate)
      return setError('The end date must be after the start date.');
    setError('');
    save.mutate({ branchId, ...draft, label: draft.label.trim() });
  };

  return (
    <div className="space-y-6">
      <SectionCard title="Seasonal calendar" titleLevel={2}>
        <p className="mb-4 text-sm text-text-muted">
          Dated windows for this branch. Forecasting learns each season&apos;s uplift from this
          branch&apos;s own sales history; nothing is assumed from a fixed list.
        </p>
        {calendar.isLoading ? (
          <p className="text-sm text-text-muted" role="status">
            Loading the seasonal calendar…
          </p>
        ) : calendar.isError ? (
          <p className="text-sm text-text-muted" role="alert">
            The seasonal calendar is unavailable for this branch.
          </p>
        ) : calendar.data!.windows.length === 0 ? (
          <p className="text-sm text-text-muted">
            No seasonal windows yet.{' '}
            {canEdit
              ? 'Add dengue, flu, Ramadan, monsoon or a custom window below.'
              : 'Ask the owner to add windows for this branch.'}
          </p>
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Season</TableHead>
                  <TableHead>Label</TableHead>
                  <TableHead>Starts</TableHead>
                  <TableHead>Ends before</TableHead>
                  {canEdit && <TableHead className="text-right">Actions</TableHead>}
                </TableRow>
              </TableHeader>
              <TableBody>
                {calendar.data!.windows.map((window) => (
                  <TableRow key={window.id}>
                    <TableCell>
                      <StatusPill
                        status={window.kind}
                        tone="info"
                        label={KIND_LABELS[window.kind]}
                      />
                    </TableCell>
                    <TableCell>{window.label}</TableCell>
                    <TableCell className="tabular-nums">{window.startDate}</TableCell>
                    <TableCell className="tabular-nums">{window.endDateExclusive}</TableCell>
                    {canEdit && (
                      <TableCell className="space-x-2 text-right">
                        <Button
                          type="button"
                          variant="outline"
                          size="touch"
                          disabled={busy}
                          onClick={() =>
                            setDraft({
                              id: window.id,
                              kind: window.kind,
                              label: window.label,
                              startDate: window.startDate,
                              endDateExclusive: window.endDateExclusive,
                            })
                          }
                        >
                          Edit
                        </Button>
                        <Button
                          type="button"
                          variant="destructive"
                          size="touch"
                          disabled={busy}
                          onClick={() => remove.mutate({ branchId, id: window.id })}
                        >
                          Remove
                        </Button>
                      </TableCell>
                    )}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
        {canEdit && (
          <form onSubmit={submit} noValidate className="mt-6 grid gap-4 md:grid-cols-4">
            <label className="text-sm" htmlFor={`${formId}-kind`}>
              Season
              <StudioSelect
                id={`${formId}-kind`}
                className={selectClass}
                value={draft.kind}
                disabled={busy}
                onChange={(event) => {
                  const kind = event.target.value as SeasonalWindowKind;
                  setDraft((current) => ({
                    ...current,
                    kind,
                    label:
                      current.label === KIND_LABELS[current.kind]
                        ? KIND_LABELS[kind]
                        : current.label,
                  }));
                }}
              >
                {SEASONAL_WINDOW_KINDS.map((kind) => (
                  <option key={kind} value={kind}>
                    {KIND_LABELS[kind]}
                  </option>
                ))}
              </StudioSelect>
            </label>
            <label className="text-sm" htmlFor={`${formId}-label`}>
              Label
              <Input
                id={`${formId}-label`}
                className="mt-1 min-h-11"
                maxLength={80}
                value={draft.label}
                disabled={busy}
                aria-invalid={Boolean(error) && !draft.label.trim()}
                onChange={(event) => setDraft({ ...draft, label: event.target.value })}
              />
            </label>
            <label className="text-sm" htmlFor={`${formId}-start`}>
              Starts
              <Input
                id={`${formId}-start`}
                type="date"
                className="mt-1 min-h-11"
                value={draft.startDate}
                disabled={busy}
                onChange={(event) => setDraft({ ...draft, startDate: event.target.value })}
              />
            </label>
            <label className="text-sm" htmlFor={`${formId}-end`}>
              Ends before
              <Input
                id={`${formId}-end`}
                type="date"
                className="mt-1 min-h-11"
                value={draft.endDateExclusive}
                disabled={busy}
                aria-invalid={Boolean(error) && draft.endDateExclusive <= draft.startDate}
                onChange={(event) => setDraft({ ...draft, endDateExclusive: event.target.value })}
              />
            </label>
            {error && (
              <p role="alert" className="text-sm text-destructive md:col-span-4">
                {error}
              </p>
            )}
            <div className="flex flex-wrap gap-2 md:col-span-4">
              <Button type="submit" className="min-h-11" disabled={busy}>
                {save.isPending ? 'Saving…' : draft.id ? 'Save window' : 'Add window'}
              </Button>
              {draft.id && (
                <Button
                  type="button"
                  variant="outline"
                  className="min-h-11"
                  disabled={busy}
                  onClick={() => setDraft(empty)}
                >
                  Cancel edit
                </Button>
              )}
            </div>
          </form>
        )}
        {!canEdit && error && (
          <p role="alert" className="mt-4 text-sm text-destructive">
            {error}
          </p>
        )}
      </SectionCard>

      <SectionCard title="Sales spikes by salt" titleLevel={2}>
        <p className="mb-4 text-sm text-text-muted">
          Estimate: days from {spikeFrom} to {today} where a salt sold at least twice its trailing
          four-week level on this branch. Days without recorded sales are not counted as zero.
        </p>
        {spikes.isLoading ? (
          <p className="text-sm text-text-muted" role="status">
            Checking recent sales…
          </p>
        ) : spikes.isError ? (
          <p className="text-sm text-text-muted" role="alert">
            Spike detection is unavailable for this branch.
          </p>
        ) : spikes.data!.salts.length === 0 ? (
          <p className="text-sm text-text-muted">
            No spikes against each salt&apos;s own recent baseline in this period.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Salt</TableHead>
                  <TableHead>Date</TableHead>
                  <TableHead className="text-right">Units</TableHead>
                  <TableHead className="text-right">Baseline / day</TableHead>
                  <TableHead className="text-right">Multiple</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {spikes.data!.salts.flatMap((salt) =>
                  salt.spikes.map((spike) => (
                    <TableRow key={`${salt.ingredientId}-${spike.date}`}>
                      <TableCell>{salt.name}</TableCell>
                      <TableCell className="tabular-nums">{spike.date}</TableCell>
                      <TableCell className="text-right tabular-nums">{spike.units}</TableCell>
                      <TableCell className="text-right tabular-nums">
                        {spike.baselineMeanUnits}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {spike.upliftBps === null
                          ? 'New demand'
                          : `${(spike.upliftBps / 10_000).toFixed(1)}×`}
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </div>
        )}
      </SectionCard>
    </div>
  );
}
