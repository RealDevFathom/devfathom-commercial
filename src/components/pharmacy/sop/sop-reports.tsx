'use client';

import { useState } from 'react';

import { Field, fieldClass, WorkspaceState } from '@/components/pharmacy/dispensing/field';
import { Button } from '@/components/ui/button';
import { SectionCard } from '@/components/ui/section-card';
import { Stat } from '@/components/ui/stat';
import { workspaceToday } from '@/lib/timezone';
import { trpc } from '@/lib/trpc';

import { errorMessage, type SopReport } from './sop-model';

function daysBefore(day: string, count: number) {
  const date = new Date(`${day}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() - count);
  return date.toISOString().slice(0, 10);
}

const head =
  'px-3 py-2 font-mono text-xs font-semibold tracking-wide text-text-muted uppercase';
const cell = 'px-3 py-2 text-sm text-text-body';

export function SopReportsView({
  pharmacyBranchId,
  timezone,
}: {
  pharmacyBranchId: string;
  timezone: string | null;
}) {
  const today = workspaceToday(timezone);
  const [draft, setDraft] = useState({ from: daysBefore(today, 6), to: today });
  const [range, setRange] = useState(draft);
  const [error, setError] = useState<string | null>(null);
  const report = trpc.pharmacySop.report.useQuery(
    { pharmacyBranchId, from: range.from, to: range.to },
    { retry: false }
  );
  const data: SopReport | undefined = report.data;

  return (
    <div className="grid min-w-0 gap-6">
      <SectionCard title="Date range">
        <form
          className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] sm:items-end"
          onSubmit={(event) => {
            event.preventDefault();
            if (!draft.from || !draft.to || draft.to < draft.from) {
              setError('Choose a start date on or before the end date.');
              return;
            }
            setError(null);
            setRange(draft);
          }}
        >
          <Field label="From">
            <input
              type="date"
              className={fieldClass}
              value={draft.from}
              max={draft.to}
              onChange={(event) => setDraft({ ...draft, from: event.target.value })}
            />
          </Field>
          <Field label="To">
            <input
              type="date"
              className={fieldClass}
              value={draft.to}
              min={draft.from}
              onChange={(event) => setDraft({ ...draft, to: event.target.value })}
            />
          </Field>
          <Button type="submit" variant="outline" size="touch">
            Show
          </Button>
        </form>
        {error ? (
          <p className="mt-2 text-sm text-destructive" role="alert">
            {error}
          </p>
        ) : null}
      </SectionCard>

      {report.isLoading ? (
        <WorkspaceState title="Loading summary">Adding up this period.</WorkspaceState>
      ) : report.error || !data ? (
        <WorkspaceState title="The summary could not be loaded" tone="danger">
          <p>{errorMessage(report.error, 'Nothing was changed. Retry when you are ready.')}</p>
          <Button
            type="button"
            variant="outline"
            size="touch"
            className="mt-3"
            onClick={() => void report.refetch()}
          >
            Retry
          </Button>
        </WorkspaceState>
      ) : data.summary.total === 0 ? (
        <WorkspaceState title="Nothing was due in this period">
          Choose a different range, or check that schedules are active in Setup.
        </WorkspaceState>
      ) : (
        <ReportBody report={data} />
      )}
    </div>
  );
}

function ReportBody({ report }: { report: SopReport }) {
  const { summary, score } = report;
  const counts = score.overall.counts;
  const scoreByStaff = new Map(score.staff.map((row) => [row.staffProfileId, row.breakdown.score]));
  return (
    <>
      <section
        aria-label="Summary for this period"
        className="grid grid-cols-2 gap-4 rounded-lg border border-border-subtle bg-card p-5 sm:grid-cols-3 xl:grid-cols-6"
      >
        <Stat label="Due" value={summary.total} valueClassName="text-[1.75rem]" />
        <Stat label="Handed in on time" value={counts.onTime} valueClassName="text-[1.75rem]" />
        <Stat label="Late" value={counts.late} valueClassName="text-[1.75rem]" />
        <Stat label="Missed" value={counts.missed} valueClassName="text-[1.75rem]" />
        <Stat label="Sent back" value={counts.rejected} valueClassName="text-[1.75rem]" />
        <Stat label="With proof" value={summary.withProof} valueClassName="text-[1.75rem]" />
      </section>
      <SectionCard title="On-time score">
        <p className="stat-figure text-[2rem]">
          {score.overall.score === null ? '—' : `${Math.round(score.overall.score)}%`}
        </p>
        <p className="mt-2 max-w-2xl text-sm text-text-muted">
          {/* Mirrors classifyOccurrence in src/lib/restaurant/sop-score.ts: an
              occurrence scores by when it was handed in, whether or not a
              reviewer has checked it yet; only a send-back changes that. */}
          {score.overall.score === null
            ? 'Nothing in this period has been handed in, missed or sent back yet.'
            : 'Work handed in within its time allowed counts fully, whether or not it has been checked yet. Work handed in late counts half. Missed and sent-back work counts as zero. Excused work, and work not handed in while there is still time, are left out.'}
        </p>
      </SectionCard>
      <SectionCard title="By person">
        {summary.attribution.length === 0 ? (
          <p className="text-sm text-text-muted">No one has completed a step in this period.</p>
        ) : (
          <div
            role="region"
            aria-label="Procedures by person"
            tabIndex={0}
            className="max-w-full overflow-x-auto focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
          >
            <table className="w-full min-w-[28rem] border-collapse text-left">
              <thead>
                <tr className="border-b border-border-subtle">
                  <th className={head}>Person</th>
                  <th className={`${head} text-right`}>Responsible for</th>
                  <th className={`${head} text-right`}>Completed</th>
                  <th className={`${head} text-right`}>On-time score</th>
                </tr>
              </thead>
              <tbody>
                {summary.attribution.map((row) => {
                  const personal = scoreByStaff.get(row.staffProfileId);
                  return (
                    <tr
                      key={row.staffProfileId}
                      className="border-b border-border-subtle last:border-b-0 hover:bg-surface-sunken"
                    >
                      <td className={`${cell} text-text-strong`}>{row.displayName}</td>
                      <td className={`${cell} text-right font-mono tabular-nums`}>{row.owned}</td>
                      <td className={`${cell} text-right font-mono tabular-nums`}>
                        {row.completed}
                      </td>
                      <td className={`${cell} text-right font-mono tabular-nums`}>
                        {personal == null ? '—' : `${Math.round(personal)}%`}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </SectionCard>
    </>
  );
}
