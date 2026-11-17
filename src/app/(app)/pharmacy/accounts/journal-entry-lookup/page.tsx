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

export const metadata: Metadata = { title: 'Journal entry lookup · Pharmacy accounts' };
type Query = Record<string, string | string[] | undefined>;
type ViewState =
  JournalEntryLookupResult | { status: 'INITIAL' | 'INVALID' | 'DENIED' | 'FAILURE' };
const scalar = (value: string | string[] | undefined) => (typeof value === 'string' ? value : null);
const pageInput = z
  .object({
    branchId: z.string().trim().min(1).max(128),
    entryId: z.string().trim().min(1).max(128),
    from: z.iso.datetime({ offset: true }),
    to: z.iso.datetime({ offset: true }),
  })
  .strict();
type FieldName = 'branchId' | 'entryId' | 'from' | 'to';
const fields: { name: FieldName; label: string }[] = [
  { name: 'branchId', label: 'Branch ID' },
  { name: 'entryId', label: 'Journal entry ID' },
  { name: 'from', label: 'From (RFC3339 UTC)' },
  { name: 'to', label: 'To, exclusive (RFC3339 UTC)' },
];
const idField = z.string().trim().min(1).max(128);
const instantField = z.iso.datetime({ offset: true });

function fieldErrors(query: Query): Partial<Record<FieldName, string>> {
  const errors: Partial<Record<FieldName, string>> = {};
  for (const { name } of fields) {
    const raw = query[name];
    if (Array.isArray(raw)) {
      errors[name] = 'Provide this field only once.';
      continue;
    }
    if (raw === undefined || raw.trim().length === 0) {
      errors[name] = 'This field is required.';
      continue;
    }
    if (name === 'branchId' || name === 'entryId') {
      if (!idField.safeParse(raw).success) errors[name] = 'Use at most 128 characters.';
    } else if (!instantField.safeParse(raw).success) {
      errors[name] = 'Use an RFC3339 instant with an offset, for example 2026-08-01T00:00:00Z.';
    }
  }
  if (!errors.from && !errors.to) {
    const duration = Date.parse(query.to as string) - Date.parse(query.from as string);
    if (!(duration > 0 && duration <= 92 * 86_400_000)) {
      errors.to = 'Must be after From and no more than 92 days later.';
    }
  }
  return errors;
}

export default async function JournalEntryLookupPage({
  searchParams,
}: {
  searchParams: Promise<Query>;
}) {
  const query = await searchParams;
  const values = {
    branchId: scalar(query.branchId),
    entryId: scalar(query.entryId),
    from: scalar(query.from),
    to: scalar(query.to),
  };
  const supplied = Object.values(query).some((value) => value !== undefined);
  const parsed = pageInput.safeParse(query);
  const displayValues = parsed.success ? parsed.data : values;
  const duration = parsed.success ? Date.parse(parsed.data.to) - Date.parse(parsed.data.from) : NaN;
  const valid = parsed.success && duration > 0 && duration <= 92 * 86_400_000;
  let state: ViewState = supplied ? { status: 'INVALID' } : { status: 'INITIAL' };
  const errors = supplied && !valid ? fieldErrors(query) : {};
  if (valid && parsed.success) {
    try {
      const actor = await resolveTenantActor();
      if (!actor) throw new TRPCError({ code: 'UNAUTHORIZED' });
      const ctx = await createTRPCContext({
        session: actor.session,
        organization: actor.organization,
        support: actor.support,
      });
      state = await journalEntryLookupRouter.createCaller(ctx).lookup({
        branchId: parsed.data.branchId,
        entryId: parsed.data.entryId,
        from: parsed.data.from,
        to: parsed.data.to,
      });
    } catch (error) {
      state =
        error instanceof TRPCError && (error.code === 'FORBIDDEN' || error.code === 'UNAUTHORIZED')
          ? { status: 'DENIED' }
          : { status: 'FAILURE' };
    }
  }
  const message: Partial<Record<ViewState['status'], string>> = {
    INITIAL: 'Enter the journal entry ID, the branch and the dates to search.',
    INVALID:
      'Enter each field once, with an ID and dates no more than 92 days apart.',
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
          {fields.map(({ name, label }) => {
            const error = errors[name];
            const errorId = `journal-lookup-${name}-error`;
            return (
              <div key={name} className="text-sm text-text-body">
                <label htmlFor={`journal-lookup-${name}`}>{label}</label>
                <Input
                  id={`journal-lookup-${name}`}
                  name={name}
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
          from={displayValues.from!}
          to={displayValues.to!}
        />
      )}
    </div>
  );
}

function EntryDetail({
  result,
  branchId,
  from,
  to,
}: {
  result: Extract<JournalEntryLookupResult, { status: 'FOUND' }>;
  branchId: string;
  from: string;
  to: string;
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
          <dd>{entry.occurredAt}</dd>
        </div>
        <div>
          <dt className="font-mono text-xs uppercase text-text-muted">Branch / window</dt>
          <dd className="break-all">
            {branchId} · [{from}, {to})
          </dd>
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
