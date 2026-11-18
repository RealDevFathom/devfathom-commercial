'use client';

import { useState } from 'react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { SectionCard } from '@/components/ui/section-card';
import { StatusPill } from '@/components/ui/status-pill';
import {
  PHARMACIST_COVERAGE_MAX_WINDOWS,
  PHARMACIST_COVERAGE_WEEKDAYS,
  coverageDaysLabel,
  pharmacistCoverageWindowsSchema,
  type PharmacistCoverageWindow,
} from '@/lib/pharmacy/pharmacist-coverage-hours';
import { trpc } from '@/lib/trpc';

type DraftWindow = { days: number[]; start: string; end: string };
type Invalid = { index: number; field: 'days' | 'start' | 'end' } | null;

const BLANK_WINDOW: DraftWindow = { days: [1, 2, 3, 4, 5, 6], start: '09:00', end: '21:00' };

function toDraft(windows: readonly PharmacistCoverageWindow[]): DraftWindow[] {
  return windows.map((window) => ({
    days: [...window.days],
    start: window.start,
    end: window.end,
  }));
}

/**
 * DEV-846 (DEV-86) — the owner records which hours a pharmacist covers one
 * branch. A record only: the live-sale hours check reads the branch's
 * jurisdiction rule set and stays off until the pharmacist adviser's Punjab and
 * Sindh rules are published there. The save procedure enforces the owner rule.
 */
export function PharmacistCoverageHoursPanel({ branchId }: { branchId: string }) {
  const query = trpc.pharmacyOnboarding.pharmacistCoverage.useQuery({ branchId });
  const save = trpc.pharmacyOnboarding.savePharmacistCoverage.useMutation();
  const [draft, setDraft] = useState<DraftWindow[] | null>(null);
  const [draftRevision, setDraftRevision] = useState<number | null>(null);
  const [notice, setNotice] = useState('');
  const [invalid, setInvalid] = useState<Invalid>(null);
  const loaded = query.data ? toDraft(query.data.windows) : null;
  const windows = draft ?? loaded;
  const disabled = query.isLoading || query.isError || save.isPending || !windows;
  const liveCheck = query.data?.liveSaleHoursCheck === true;

  function change(next: DraftWindow[]) {
    setNotice('');
    setInvalid(null);
    setDraftRevision(draftRevision ?? query.data?.revision ?? null);
    setDraft(next);
  }
  function update(index: number, patch: Partial<DraftWindow>) {
    if (!windows) return;
    change(windows.map((window, i) => (i === index ? { ...window, ...patch } : window)));
  }

  async function submit() {
    if (!draft || draftRevision === null) return;
    const parsed = pharmacistCoverageWindowsSchema.safeParse(
      draft.map((window) => ({ ...window, start: window.start.trim(), end: window.end.trim() }))
    );
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      const [index, field] = issue?.path ?? [];
      if (typeof index === 'number') {
        setInvalid({
          index,
          field: field === 'start' || field === 'end' ? field : 'days',
        });
        setNotice(`Window ${index + 1}: ${issue?.message ?? 'Check this window.'}`);
      } else {
        setNotice(issue?.message ?? 'Check the hours.');
      }
      return;
    }
    try {
      await save.mutateAsync({ branchId, revision: draftRevision, windows: parsed.data });
      const refreshed = await query.refetch();
      if (refreshed.error) {
        setNotice('Saved. Reload the coverage hours before making further changes.');
        return;
      }
      setDraft(null);
      setDraftRevision(null);
      setNotice(parsed.data.length ? 'Coverage hours saved.' : 'Coverage hours cleared.');
    } catch {
      setNotice(
        'Could not save. Reload the coverage hours to check access and concurrent changes.'
      );
    }
  }

  return (
    <SectionCard
      eyebrow="Pharmacist coverage"
      title="Pharmacist coverage hours"
      titleLevel={2}
      actions={
        query.data ? (
          liveCheck ? (
            <StatusPill status="Hours check on" tone="success" />
          ) : (
            <StatusPill status="Hours check off" tone="neutral" />
          )
        ) : null
      }
    >
      <p className="text-sm text-text-body">
        Record the hours a pharmacist covers this branch. Each window runs from its start time up to
        its end time on the days you tick; split a shift past midnight into two windows.
      </p>
      <p className="mt-3 rounded-md border border-border-subtle bg-surface-sunken px-3 py-2 text-sm text-text-body">
        {liveCheck
          ? "This branch's published rules set their own presence hours, and live sales are checked against those, not against the hours recorded here."
          : "The hours check for live sales is off. It stays off until the pharmacist adviser's Punjab and Sindh rules are confirmed, because a roster alone cannot show who is present. These hours are kept as your record and refuse no sale."}{' '}
        Every prescription, restricted and controlled sale still needs its pharmacist check at the
        counter.
      </p>
      {query.data ? (
        <p className="mt-3 font-mono text-xs text-text-muted">
          Times are in {query.data.timeZone}.
        </p>
      ) : null}
      {query.isLoading ? (
        <p className="mt-4 text-sm text-text-muted" role="status">
          Loading coverage hours…
        </p>
      ) : null}
      {query.isError ? (
        <div className="mt-4 space-y-2" role="alert">
          <p className="text-sm text-text-body">
            The coverage hours are unavailable. The workspace owner records them for each branch.
          </p>
          <Button className="min-h-11" onClick={() => void query.refetch()} variant="outline">
            Retry
          </Button>
        </div>
      ) : null}

      {windows ? (
        <div className="mt-4 space-y-4">
          {windows.length === 0 ? (
            <p className="text-sm text-text-muted">
              No coverage hours are recorded for this branch yet. Add a window to record them.
            </p>
          ) : null}
          {windows.map((window, index) => {
            const startId = `coverage-start-${branchId}-${index}`;
            const endId = `coverage-end-${branchId}-${index}`;
            return (
              <fieldset
                className="min-w-0 rounded-md border border-border-subtle p-4"
                disabled={disabled}
                key={index}
              >
                <legend className="px-1 font-mono text-xs tracking-wide text-text-muted uppercase">
                  Window {index + 1}
                  {window.days.length ? ` · ${coverageDaysLabel(window.days)}` : ''}
                </legend>
                <div
                  aria-invalid={
                    invalid?.index === index && invalid.field === 'days' ? true : undefined
                  }
                  aria-label={`Window ${index + 1} days`}
                  className="flex flex-wrap gap-x-4 gap-y-1"
                  role="group"
                >
                  {PHARMACIST_COVERAGE_WEEKDAYS.map((name, day) => (
                    <Label className="flex min-h-11 items-center gap-2" key={name}>
                      <input
                        checked={window.days.includes(day)}
                        onChange={(event) =>
                          update(index, {
                            days: event.target.checked
                              ? [...window.days, day].sort((a, b) => a - b)
                              : window.days.filter((item) => item !== day),
                          })
                        }
                        type="checkbox"
                      />
                      {name.slice(0, 3)}
                      <span className="sr-only"> ({name})</span>
                    </Label>
                  ))}
                </div>
                <div className="mt-3 grid min-w-0 gap-4 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
                  <div className="space-y-2">
                    <Label htmlFor={startId}>From (HH:MM)</Label>
                    <Input
                      aria-invalid={
                        invalid?.index === index && invalid.field === 'start' ? true : undefined
                      }
                      className="min-h-11"
                      id={startId}
                      inputMode="numeric"
                      onChange={(event) => update(index, { start: event.target.value })}
                      placeholder="09:00"
                      value={window.start}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor={endId}>Until (HH:MM, 24:00 for midnight)</Label>
                    <Input
                      aria-invalid={
                        invalid?.index === index && invalid.field === 'end' ? true : undefined
                      }
                      className="min-h-11"
                      id={endId}
                      inputMode="numeric"
                      onChange={(event) => update(index, { end: event.target.value })}
                      placeholder="21:00"
                      value={window.end}
                    />
                  </div>
                  <Button
                    className="min-h-11"
                    onClick={() => change(windows.filter((_, i) => i !== index))}
                    variant="outline"
                  >
                    Remove window {index + 1}
                  </Button>
                </div>
              </fieldset>
            );
          })}
          <Button
            className="min-h-11"
            disabled={disabled || windows.length >= PHARMACIST_COVERAGE_MAX_WINDOWS}
            onClick={() => change([...windows, { ...BLANK_WINDOW, days: [...BLANK_WINDOW.days] }])}
            variant="outline"
          >
            Add window
          </Button>
        </div>
      ) : null}

      <div className="mt-4 flex flex-wrap items-center gap-3">
        <Button className="min-h-11" disabled={disabled || draft === null} onClick={submit}>
          {save.isPending ? 'Saving…' : 'Save coverage hours'}
        </Button>
        <Button
          className="min-h-11"
          disabled={query.isLoading || save.isPending}
          onClick={async () => {
            const refreshed = await query.refetch();
            if (refreshed.error) {
              setNotice('The coverage hours could not be reloaded. Your draft is preserved.');
              return;
            }
            setDraft(null);
            setDraftRevision(null);
            setInvalid(null);
            setNotice('');
          }}
          variant="outline"
        >
          Reload coverage hours
        </Button>
      </div>
      {notice ? (
        <p className="mt-3 text-sm text-text-body" role="status">
          {notice}
        </p>
      ) : null}
    </SectionCard>
  );
}
