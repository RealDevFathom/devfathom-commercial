import { ReportDetails } from '@/components/pharmacy/report-details';
import type { Metadata } from 'next';
import Link from 'next/link';
import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { PageHeader } from '@/components/ui/page-header';
import { SectionCard } from '@/components/ui/section-card';
import {
  journalEntryLookupRouter,
  type JournalEntryLookupResult,
} from '@/lib/pharmacy/accounts/journal-entry-lookup';
import { resolveTenantActor } from '@/lib/tenancy/tenant-actor';
import { createTRPCContext } from '@/server/trpc';
import {
  formatWorkspaceDateTime,
  workspaceInstantFromInput,
  workspaceZoneLabel,
} from '@/lib/timezone';

export const metadata: Metadata = { title: 'Journal entry lookup · Pharmacy accounts' };
type Query = Record<string, string | string[] | undefined>;
type ViewState =
  JournalEntryLookupResult | { status: 'INITIAL' | 'INVALID' | 'DENIED' | 'FAILURE' };
const scalar = (value: string | string[] | undefined) => (typeof value === 'string' ? value : null);
const MAX_WINDOW_MS = 92 * 86_400_000;
// The owner picks a calendar date and a clock time with the browser's own pickers; the page reads
// them on the organisation's clock and sends the server the same ISO instants it always took.
const dateField = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((value) => {
    const ms = Date.parse(`${value}T00:00:00.000Z`);
    return Number.isFinite(ms) && new Date(ms).toISOString().slice(0, 10) === value;
  });
const timeField = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$/);
const idField = z.string().trim().min(1).max(128);
const pageInput = z
  .object({
    branchId: idField,
    entryId: idField,
    fromDate: dateField,
    fromTime: timeField,
    toDate: dateField,
    toTime: timeField,
  })
  .strict();
type FieldName = keyof z.infer<typeof pageInput>;
const fields: { name: FieldName; label: string; type: 'text' | 'date' | 'time' }[] = [
  { name: 'branchId', label: 'Branch ID', type: 'text' },
  { name: 'entryId', label: 'Journal entry ID', type: 'text' },
  { name: 'fromDate', label: 'From date', type: 'date' },
  { name: 'fromTime', label: 'From time', type: 'time' },
  { name: 'toDate', label: 'Until date', type: 'date' },
  { name: 'toTime', label: 'Until time (not included)', type: 'time' },
];
const fieldSchema: Record<FieldName, z.ZodType> = pageInput.shape;
const fieldMessage: Record<'text' | 'date' | 'time', string> = {
  text: 'Use at most 128 characters.',
  date: 'Choose a date.',
  time: 'Choose a time.',
};

function fieldErrors(query: Query): Partial<Record<FieldName, string>> {
  const errors: Partial<Record<FieldName, string>> = {};
  for (const { name, type } of fields) {
    const raw = query[name];
    if (Array.isArray(raw)) {
      errors[name] = 'Provide this field only once.';
      continue;
    }
    if (raw === undefined || raw.trim().length === 0) {
      errors[name] = 'This field is required.';
      continue;
    }
    if (!fieldSchema[name].safeParse(raw).success) errors[name] = fieldMessage[type];
  }
  return errors;
}

/** The searched window in plain words on the organisation's clock. */
function windowWords(from: string, to: string, timeZone: string | null | undefined) {
  return `From ${formatWorkspaceDateTime(from, timeZone)} up to, but not including, ${formatWorkspaceDateTime(to, timeZone)}`;
}

export default async function JournalEntryLookupPage({
  searchParams,
}: {
  searchParams: Promise<Query>;
}) {
  const query = await searchParams;
  const values = Object.fromEntries(
    fields.map(({ name }) => [name, scalar(query[name])])
  ) as Record<FieldName, string | null>;
  const supplied = Object.values(query).some((value) => value !== undefined);
  const parsed = pageInput.safeParse(query);
  const displayValues: Record<FieldName, string | null> = parsed.success ? parsed.data : values;
  let state: ViewState = supplied ? { status: 'INVALID' } : { status: 'INITIAL' };
  let errors: Partial<Record<FieldName, string>> =
    supplied && !parsed.success ? fieldErrors(query) : {};
  // Known once the tenant actor resolves; until then the page names it in words.
  let timeZone: string | null | undefined;
  let window: { from: string; to: string } | null = null;
  if (parsed.success) {
    try {
      const actor = await resolveTenantActor();
      if (!actor) throw new TRPCError({ code: 'UNAUTHORIZED' });
      timeZone = actor.organization?.timezone ?? 'UTC';
      const from = workspaceInstantFromInput(
        `${parsed.data.fromDate}T${parsed.data.fromTime}`,
        timeZone
      );
      const to = workspaceInstantFromInput(`${parsed.data.toDate}T${parsed.data.toTime}`, timeZone);
      const duration = Date.parse(to) - Date.parse(from);
      if (!(duration > 0 && duration <= MAX_WINDOW_MS)) {
        errors = { toDate: 'Must be after the From date and time and no more than 92 days later.' };
      } else {
        window = { from, to };
        const ctx = await createTRPCContext({
          session: actor.session,
          organization: actor.organization,
          support: actor.support,
        });
        state = await journalEntryLookupRouter.createCaller(ctx).lookup({
          branchId: parsed.data.branchId,
          entryId: parsed.data.entryId,
          from,
          to,
        });
      }
    } catch (error) {
      state =
        error instanceof TRPCError && (error.code === 'FORBIDDEN' || error.code === 'UNAUTHORIZED')
          ? { status: 'DENIED' }
          : { status: 'FAILURE' };
    }
  }
  const zoneWords = timeZone
    ? `Dates and times are on your organisation's clock (${workspaceZoneLabel(timeZone)}).`
    : "Dates and times are on your organisation's clock.";
  const message: Partial<Record<ViewState['status'], string>> = {
    INITIAL: 'Enter the journal entry ID, the branch and the dates and times to search.',
    INVALID:
      'Enter each field once, with an ID and a window that ends after it starts and is no more than 92 days long.',
    DENIED: 'You do not have access to this financial report scope.',
    FAILURE: 'The journal lookup is unavailable. Retry; no stale details are shown.',
    NOT_FOUND: 'No journal entry was found in this exact branch and window.',
    INVALID_SOURCE: 'The records could not be checked, so no details or totals are shown.',
    TRUNCATED: 'This branch slice exceeds 200 lines. No partial details or totals are shown.',
  };
  return (
    <div className="min-w-0 space-y-6">
      <PageHeader
        eyebrow="Pharmacy accounts"
        heading="Journal entry lookup"
        description="Look up one journal entry for a branch and a date range."
      />
      <Link
        className="text-sm underline focus-visible:outline-2 focus-visible:outline-ring"
        href="/pharmacy/finance"
      >
        Back to finance
      </Link>
      <SectionCard title="Exact lookup" titleLevel={2}>
        <form
          method="get"
          action="/pharmacy/accounts/journal-entry-lookup"
          className="grid gap-4 md:grid-cols-2"
        >
          <p className="text-sm text-text-muted md:col-span-2">{zoneWords}</p>
          {fields.map(({ name, label, type }) => {
            const error = errors[name];
            const errorId = `journal-lookup-${name}-error`;
            return (
              <div key={name} className="text-sm text-text-body">
                <label htmlFor={`journal-lookup-${name}`}>{label}</label>
                <Input
                  id={`journal-lookup-${name}`}
                  name={name}
                  type={type}
                  className="mt-1 min-h-11"
                  defaultValue={displayValues[name] ?? ''}
                  aria-invalid={error ? true : undefined}
                  aria-describedby={error ? errorId : undefined}
                  required
                />
                {error ? (
                  <p id={errorId} className="mt-1 text-sm text-destructive">
                    {error}
                  </p>
                ) : null}
              </div>
            );
          })}
          <Button type="submit" className="min-h-11">
            Look up exact entry
          </Button>
        </form>
      </SectionCard>
      {state.status !== 'FOUND' ? (
        <SectionCard title="Lookup status" titleLevel={2}>
          <p
            role={state.status === 'INITIAL' ? undefined : 'alert'}
            className="text-sm text-text-muted"
          >
            {message[state.status]}
          </p>
        </SectionCard>
      ) : (
        <EntryDetail
          result={state}
          branchId={displayValues.branchId!}
          windowLabel={window ? windowWords(window.from, window.to, timeZone) : ''}
          timeZone={timeZone}
        />
      )}
    </div>
  );
}

function EntryDetail({
  result,
  branchId,
  windowLabel,
  timeZone,
}: {
  result: Extract<JournalEntryLookupResult, { status: 'FOUND' }>;
  branchId: string;
  windowLabel: string;
  timeZone: string | null | undefined;
}) {
  const { entry } = result;
  return (
    <SectionCard title="Authorized branch slice" titleLevel={2}>
      <ReportDetails>
        <p className="mb-4 text-sm text-text-muted">
          This is only the selected branch slice, not a complete journal or global-balance
          assertion. A nonzero difference can be legitimate for an interbranch entry.
        </p>
      </ReportDetails>
      <dl className="mb-5 grid gap-3 text-sm sm:grid-cols-2 lg:grid-cols-3">
        <div>
          <dt className="font-mono text-xs uppercase text-text-muted">Entry</dt>
          <dd className="break-all">{entry.id}</dd>
        </div>
        <div>
          <dt className="font-mono text-xs uppercase text-text-muted">Source</dt>
          <dd className="break-all">
            {entry.sourceKind} · {entry.sourceId}
          </dd>
        </div>
        <div>
          <dt className="font-mono text-xs uppercase text-text-muted">Reverses entry</dt>
          <dd className="break-all">{entry.reversesEntryId ?? 'None'}</dd>
        </div>
        <div>
          <dt className="font-mono text-xs uppercase text-text-muted">Occurred</dt>
          <dd>{formatWorkspaceDateTime(entry.occurredAt, timeZone)}</dd>
        </div>
        <div>
          <dt className="font-mono text-xs uppercase text-text-muted">Branch</dt>
          <dd className="break-all">{branchId}</dd>
        </div>
        <div>
          <dt className="font-mono text-xs uppercase text-text-muted">Searched window</dt>
          <dd>{windowLabel}</dd>
        </div>
        <div>
          <dt className="font-mono text-xs uppercase text-text-muted">Currency</dt>
          <dd>{entry.currency}</dd>
        </div>
      </dl>
      <div className="overflow-x-auto">
        <table className="w-full min-w-2xl text-sm">
          <thead>
            <tr className="border-b border-border-default font-mono text-xs uppercase text-text-muted">
              <th className="p-3 text-left">Line</th>
              <th className="p-3 text-left">Account</th>
              <th className="p-3 text-left">Side</th>
              <th className="p-3 text-right">Amount (minor)</th>
            </tr>
          </thead>
          <tbody>
            {entry.lines.map((line) => (
              <tr className="border-b border-border-subtle" key={line.id}>
                <td className="p-3 break-all">{line.id}</td>
                <td className="p-3">{line.accountCode}</td>
                <td className="p-3">{line.side}</td>
                <td className="p-3 text-right tabular-nums">{line.amountMinor}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="font-semibold">
              <td className="p-3" colSpan={3}>
                Branch-slice debit / credit / signed difference
              </td>
              <td className="p-3 text-right tabular-nums">
                {entry.debitMinor} / {entry.creditMinor} / {entry.differenceMinor}
              </td>
            </tr>
          </tfoot>
        </table>
      </div>
    </SectionCard>
  );
}
