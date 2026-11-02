import { Info } from 'lucide-react';
import Link from 'next/link';

import { Button } from '@/components/ui/button';
import { SectionCard } from '@/components/ui/section-card';
import { StatusPill } from '@/components/ui/status-pill';
import { formatMinor } from '@/lib/pharmacy/counter-receipt';
import type { pharmacyReportsRouter } from '@/server/routers/pharmacy-reports';
import {
  workPackCapNote,
  workPackDate,
  workPackEvidenceLabel,
  workPackFactLabel,
  workPackGroupLabels,
  workPackMissingSourceNote,
  workPackOperationalOnlyNote,
  workPackSourceLabels,
  workPackTime,
} from './daily-work-pack-labels';

type Reader = ReturnType<typeof pharmacyReportsRouter.createCaller>['dailyWorkPack'];
type WorkPack = Awaited<ReturnType<Reader>>;
type Evidence = WorkPack['groups'][number]['tasks'][number]['evidence'][number];
export type DailyWorkPackProps = {
  read: Reader;
  filters: Omit<Parameters<Reader>[0], 'asOf'>;
  branches: { id: string; name: string }[];
  refreshFields: Record<string, string>;
  /** Workspace IANA zone for dates; a missing or unknown zone reads as UTC. */
  timeZone?: string | null;
  /** Workspace currency code, shown beside amounts when known. */
  currency?: string | null;
};

const linkClass =
  'inline-flex min-h-11 items-center break-words text-sm underline focus-visible:outline-2 focus-visible:outline-ring';
/**
 * DEV-601: the shared Button dims a disabled control with `opacity-50`, which leaves this
 * outline button's label and border almost invisible on the dark card. Keep it at full
 * opacity on contrast-checked tokens (`--text-muted` on `--surface-sunken`, 4.5:1+ in both
 * themes). Remove once the shared Button stops dimming disabled controls with opacity.
 */
const refreshButtonClass =
  'min-h-11 disabled:border-border-default disabled:bg-surface-sunken disabled:text-text-muted disabled:opacity-100';
const disclosureClass =
  'min-h-11 cursor-pointer py-3 text-sm font-medium text-text-strong focus-visible:outline-2 focus-visible:outline-ring';

function Refresh({ fields, retry = false }: { fields: Record<string, string>; retry?: boolean }) {
  return (
    <form action="/pharmacy/reports#daily-work-pack" method="get">
      {Object.entries(fields).map(([name, value]) => (
        <input key={name} type="hidden" name={name} value={value} />
      ))}
      <Button variant="outline" className={refreshButtonClass} type="submit">
        {retry ? 'Try again' : 'Refresh'}
      </Button>
    </form>
  );
}

export function DailyWorkPackLoading() {
  return (
    <SectionCard id="daily-work-pack" title="Daily work pack" titleLevel={2} aria-busy="true">
      <p role="status" className="mb-4 text-sm text-text-body">
        Loading today&apos;s to-do list. The other reports on this page are ready to use.
      </p>
      <Button variant="outline" className={refreshButtonClass} disabled>
        Refresh
      </Button>
    </SectionCard>
  );
}

function amountText(value: number, currency: string | null | undefined) {
  if (!Number.isSafeInteger(value)) return '—';
  const amount = formatMinor(value).replace(/\B(?=(\d{3})+\.)/g, ',');
  return currency && /^[A-Z]{3}$/.test(currency) ? `${currency} ${amount}` : amount;
}

function facts(evidence: Evidence, currency: string | null | undefined) {
  return [
    ...Object.entries(evidence.counts)
      // Alert counts per kind list only the states that hold something.
      .filter(([, count]) => evidence.reference.kind !== 'stock-kind' || count > 0)
      .map(([key, count]) => ({ key, label: workPackFactLabel(key), value: String(count) })),
    ...(evidence.amounts ?? []).map((amount) => ({
      key: amount.key,
      label: workPackFactLabel(amount.key),
      value: amountText(amount.value, currency),
    })),
  ];
}

/** Server component: reuse the authenticated caller and stream separately from report figures. */
export async function DailyWorkPack({
  read,
  filters,
  branches,
  refreshFields,
  timeZone,
  currency,
}: DailyWorkPackProps) {
  let pack: WorkPack | null = null;
  try {
    // Generate as-of on every server read, including GET refresh; never trust a URL timestamp.
    pack = await read({ ...filters, asOf: new Date().toISOString() });
  } catch {
    // A failed/denied read must not expose server errors or erase successful sibling reports.
  }
  if (!pack) {
    return (
      <SectionCard id="daily-work-pack" title="Daily work pack" titleLevel={2}>
        <p role="alert" className="mb-4 text-sm text-text-body">
          The daily work pack couldn&apos;t load. Try again, or ask your workspace administrator to
          check your report access. Nothing was changed.
        </p>
        <Refresh fields={refreshFields} retry />
      </SectionCard>
    );
  }
  const branchName = (id: string) => branches.find((branch) => branch.id === id)?.name ?? 'Branch';
  const tasks = pack.groups.flatMap((group) =>
    group.tasks
      .filter((task) => task.evidence.length)
      .map((task) => ({ ...task, label: workPackGroupLabels[group.key] }))
  );
  const missingNote = workPackMissingSourceNote(pack, branchName);
  const notes = [
    missingNote,
    workPackCapNote(pack),
    pack.permissions.financial ? null : workPackOperationalOnlyNote,
  ].filter((note): note is string => Boolean(note));
  const nothingLoaded = pack.sources.every((source) => source.status !== 'available');
  const updated = workPackTime(pack.readAt, timeZone);
  return (
    <SectionCard
      id="daily-work-pack"
      eyebrow="Today's to-do list"
      title="Daily work pack"
      titleLevel={2}
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-text-body">
          Things to check for {pack.scope.branchIds.map(branchName).join(', ')}.
          {updated ? ` Updated ${updated}.` : ''}
        </p>
        <Refresh fields={refreshFields} />
      </div>
      {notes.length ? (
        <div className="mt-4 flex gap-3 rounded-md border border-border-default bg-surface-sunken p-3 text-sm text-text-body">
          <Info aria-hidden className="mt-0.5 size-4 shrink-0 text-warning" />
          <div className="space-y-1">
            {notes.map((note) => (
              <p key={note}>{note}</p>
            ))}
          </div>
        </div>
      ) : null}
      {tasks.length ? (
        <ol className="mt-4 divide-y divide-border-subtle">
          {tasks.map((task) => {
            const count = task.evidence.length;
            return (
              <li key={task.id} className="py-4">
                <h3 className="font-semibold text-text-strong">{task.label.title}</h3>
                <p className="mt-1 text-sm text-text-body">
                  {branchName(task.branchId)} · {count} {count === 1 ? 'item' : 'items'} to check
                </p>
                <div className="flex flex-wrap gap-x-4">
                  {task.nextActions.map((action) => (
                    <Link
                      key={action.href}
                      href={action.href}
                      prefetch={false}
                      className={linkClass}
                    >
                      {task.label.action}
                    </Link>
                  ))}
                </div>
                <details>
                  <summary className={disclosureClass}>
                    Show {count === 1 ? 'the item' : `all ${count} items`}
                  </summary>
                  <ul className="space-y-3 text-sm text-text-body">
                    {task.evidence.map((evidence) => {
                      const label = workPackEvidenceLabel(evidence);
                      const due = workPackDate(evidence.dueAt, timeZone);
                      const rows = facts(evidence, currency);
                      return (
                        <li
                          key={evidence.id}
                          className="min-w-0 space-y-1 border-l border-border-default pl-4"
                        >
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="font-medium text-text-strong">{label.title}</span>
                            {label.state ? (
                              <StatusPill status={label.state.label} tone={label.state.tone} />
                            ) : null}
                          </div>
                          {due ? (
                            <p>
                              {label.due} {due}
                            </p>
                          ) : null}
                          {rows.length ? (
                            <dl className="flex flex-wrap gap-x-4 gap-y-1">
                              {rows.map((row) => (
                                <div key={row.key} className="flex flex-wrap gap-1">
                                  <dt>{row.label}:</dt>
                                  <dd className="font-mono tabular-nums">{row.value}</dd>
                                </div>
                              ))}
                            </dl>
                          ) : null}
                        </li>
                      );
                    })}
                  </ul>
                </details>
              </li>
            );
          })}
        </ol>
      ) : nothingLoaded ? null : (
        <p role="status" className="mt-4 text-sm text-text-body">
          {missingNote
            ? 'Nothing to review from the checks that loaded.'
            : "Nothing to review from today's checks."}
        </p>
      )}
      <details className="mt-2">
        <summary className={disclosureClass}>What this list checks</summary>
        <ul className="space-y-1 text-sm text-text-body">
          {pack.sources.map((source) => (
            <li key={source.id}>
              {workPackSourceLabels[source.kind].name} · {branchName(source.scope.branchId)}:{' '}
              {source.status === 'available' ? 'checked' : "couldn't load"}
            </li>
          ))}
        </ul>
      </details>
    </SectionCard>
  );
}
