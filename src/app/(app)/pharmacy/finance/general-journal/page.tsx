import { randomUUID } from 'node:crypto';
import { TRPCError } from '@trpc/server';
import Link from 'next/link';
import { redirect } from 'next/navigation';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { PageHeader } from '@/components/ui/page-header';
import { SectionCard } from '@/components/ui/section-card';
import { StatusPill } from '@/components/ui/status-pill';
import { resolveTenantActor } from '@/lib/tenancy/tenant-actor';
import { pharmacyGeneralJournalRouter } from '@/server/routers/pharmacy-general-journal';
import { createTRPCContext } from '@/server/trpc';
import {
  clearRetained,
  retainedPayload,
  retainedValues,
  storeRetained,
  type Retained,
} from './retry-store';

export const metadata = { title: 'General journal · Pharmacy' };
const route = '/pharmacy/finance/general-journal';
const field = (form: FormData, name: string) => String(form.get(name) ?? '').trim();
const control =
  'mt-1 min-h-11 w-full rounded-[var(--radius-sm)] border border-border-default bg-surface-raised px-3 text-sm text-text-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring';

async function tenantContext() {
  const actor = await resolveTenantActor();
  if (!actor) return null;
  return createTRPCContext({
    session: actor.session,
    organization: actor.organization,
    support: actor.support,
  });
}

const PAGE_SIZE = 25;

function destination(params: Record<string, string | undefined>) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) if (value) query.set(key, value);
  return `${route}?${query}`;
}

const utcDay = (value: Date | string) => new Date(value).toISOString().slice(0, 10);
// Accounting dates are stored at noon UTC so a calendar day never shifts across zones.
const accountingDate = (day: string) => new Date(`${day}T12:00:00Z`);

const REASON_MESSAGES: Record<string, string> = {
  STALE_VERSION:
    'This voucher was changed by someone else. Review the latest values below, then save again.',
  INVALID_STATE:
    'This voucher is no longer in a state that allows that command. Review its current status below.',
  REPLAY_MISMATCH:
    'This submission was already recorded with different details. Reload the page to see the saved voucher.',
  PERIOD_CLOSED: 'The accounting period for that date is closed. Choose a date in an open period.',
  INVALID_DATE:
    'Choose a date between 2000 and 2099. A reversal date cannot be earlier than the voucher date.',
  INVALID_AMOUNT: 'Enter an amount greater than zero.',
  MISSING_EVIDENCE: 'Enter an evidence reference.',
  MISSING_REASON: 'Enter a reason.',
  NOT_FOUND: 'This voucher is no longer available in this branch.',
  'A voucher with this reference or request key already exists.':
    'A voucher with this reference already exists. Use a different reference.',
};

function failureMessage(error: unknown) {
  // createCaller bypasses the HTTP error formatter. Only allow-listed domain
  // reasons are translated; raw errors never reach the page or a URL.
  if (error instanceof TRPCError) {
    const known = REASON_MESSAGES[error.message];
    if (known) return known;
    if (error.code === 'CONFLICT')
      return 'The voucher changed. Review the latest values below and try again.';
    if (error.code === 'BAD_REQUEST')
      return 'Check the voucher details and accounting period, then try again.';
    if (error.code === 'FORBIDDEN' || error.code === 'UNAUTHORIZED')
      return 'You no longer have permission to change pharmacy journal vouchers.';
  }
  return 'The command could not be completed. Your entries are kept below; try again.';
}

export default async function GeneralJournalPage({
  searchParams,
}: {
  searchParams: Promise<{
    branch?: string;
    notice?: string;
    kind?: string;
    ref?: string;
    before?: string;
    retry?: string;
  }>;
}) {
  const query = await searchParams;
  const ctx = await tenantContext();
  const heading = (
    <PageHeader
      eyebrow="Pharmacy finance"
      heading="General journal"
      description="Record controlled non-trade operating accruals with balanced, traceable postings."
    />
  );
  if (!ctx?.session?.user)
    return (
      <main className="space-y-6">
        {heading}
        <SectionCard title="Permission denied">
          <p role="alert" className="text-sm text-text-muted">
            Sign in to an authorized pharmacy workspace to use the general journal.
          </p>
        </SectionCard>
      </main>
    );

  const caller = pharmacyGeneralJournalRouter.createCaller(ctx);
  const search = (query.ref ?? '').trim().slice(0, 80);
  let branches: Awaited<ReturnType<typeof caller.branches>> = [];
  let documents: Awaited<ReturnType<typeof caller.list>> = [];
  let loadError: unknown;
  try {
    branches = await caller.branches();
    const selected = branches.find((item) => item.id === query.branch) ?? branches[0];
    if (selected)
      documents = await caller.list({
        branchId: selected.id,
        limit: PAGE_SIZE + 1,
        ...(query.before ? { cursor: query.before } : {}),
        ...(search ? { reference: search } : {}),
      });
  } catch (error) {
    loadError = error;
  }
  if (loadError) {
    const error = loadError;
    const denied = error instanceof TRPCError && ['FORBIDDEN', 'UNAUTHORIZED'].includes(error.code);
    return (
      <main className="space-y-6">
        {heading}
        <SectionCard title={denied ? 'Finance access required' : 'General journal unavailable'}>
          <p role="alert" className="text-sm text-text-muted">
            {denied
              ? 'An administrator with Pharmacy Finance and financial-report permission is required.'
              : 'Reload the page to try again. No voucher was changed.'}
          </p>
        </SectionCard>
      </main>
    );
  }

  const branch = branches.find((item) => item.id === query.branch) ?? branches[0];
  if (!branch)
    return (
      <main className="space-y-6">
        {heading}
        <SectionCard title="No active branch">
          <p className="text-sm text-text-muted">
            Activate a pharmacy branch before creating a voucher.
          </p>
        </SectionCard>
      </main>
    );

  const retained = await retainedValues(query.retry, branch.id);
  // History context travels with every command so a failure returns to the
  // same page of history, and navigation keeps the retry nonce.
  const historyBefore = (query.before ?? '').trim().slice(0, 128);
  const history = { ref: search, before: historyBefore };
  const retryNonce = retained ? query.retry : undefined;
  const hasOlder = documents.length > PAGE_SIZE;
  const shown = documents.slice(0, PAGE_SIZE);

  async function perform(form: FormData) {
    'use server';
    const branchId = field(form, 'branchId');
    let notice = 'Voucher updated.';
    try {
      const actionCtx = await tenantContext();
      if (!actionCtx?.session?.user) throw new Error('Your session is no longer active.');
      const actionCaller = pharmacyGeneralJournalRouter.createCaller(actionCtx);
      const action = field(form, 'action');
      const documentId = field(form, 'documentId');
      const version = Number(field(form, 'version'));
      // Use the rendered form's identity for every retry.
      const idempotencyKey = field(form, 'idempotencyKey');
      if (action === 'create' || action === 'update') {
        const values = {
          reference: field(form, 'reference'),
          purpose: 'NONTRADE_OPERATING_ACCRUAL' as const,
          amountMinor: Math.round(Number(field(form, 'amount')) * 100),
          currency: field(form, 'currency') as 'PKR' | 'USD',
          occurredAt: accountingDate(field(form, 'occurredAt')),
          evidence: field(form, 'evidence'),
          reason: field(form, 'reason'),
        };
        if (action === 'create')
          await actionCaller.createDraft({ branchId, ...values, idempotencyKey });
        else await actionCaller.updateDraft({ branchId, documentId, version, ...values });
        notice = action === 'create' ? 'Draft saved.' : 'Draft changes saved.';
      } else if (action === 'post') {
        await actionCaller.post({ branchId, documentId, version, idempotencyKey });
        notice = 'Voucher posted.';
      } else if (action === 'cancel') {
        await actionCaller.cancel({ branchId, documentId, version });
        notice = 'Draft cancelled.';
      } else if (action === 'reverse') {
        await actionCaller.reverse({
          branchId,
          documentId,
          version,
          idempotencyKey,
          at: accountingDate(field(form, 'reversalDate')),
          reason: field(form, 'reversalReason'),
        });
        notice = 'Voucher reversed.';
      } else throw new Error('Unknown journal command.');
    } catch (error) {
      const message = failureMessage(error);
      const nonce = randomUUID();
      await storeRetained(retainedPayload(form, { nonce, branchId, message }));
      redirect(
        destination({
          branch: branchId,
          ref: field(form, 'historyRef').slice(0, 80),
          before: field(form, 'historyBefore').slice(0, 128),
          notice: message,
          kind: 'error',
          retry: nonce,
        })
      );
    }
    await clearRetained();
    redirect(destination({ branch: branchId, notice, kind: 'success' }));
  }

  const keep = (documentId: string | undefined) =>
    retained && (retained.documentId ?? '') === (documentId ?? '') ? retained : undefined;
  const createRetained = retained?.action === 'create' ? retained : undefined;

  return (
    <main className="min-w-0 space-y-6">
      {heading}
      {query.notice && (
        <p
          role={query.kind === 'error' ? 'alert' : 'status'}
          className={query.kind === 'error' ? 'text-sm text-destructive' : 'text-sm text-success'}
        >
          {query.notice}
        </p>
      )}
      <SectionCard title="Branch">
        <form action={route} className="flex items-end gap-3">
          <label className="flex-1 text-sm">
            Active branch
            <select name="branch" defaultValue={branch.id} className={control}>
              {branches.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                </option>
              ))}
            </select>
          </label>
          <Button type="submit">Open</Button>
        </form>
      </SectionCard>
      <SectionCard title="New accrual voucher">
        <VoucherForm
          action={perform}
          branchId={branch.id}
          history={history}
          retained={createRetained}
        />
      </SectionCard>
      <SectionCard title="Voucher history">
        <form action={route} role="search" className="flex flex-wrap items-end gap-3">
          <input type="hidden" name="branch" value={branch.id} />
          {retryNonce && <input type="hidden" name="retry" value={retryNonce} />}
          <label className="flex-1 text-sm">
            Search by reference
            <Input name="ref" maxLength={80} defaultValue={search} />
          </label>
          <Button type="submit" variant="outline">
            Search
          </Button>
          {(search || query.before) && (
            <Link
              href={destination({ branch: branch.id, retry: retryNonce })}
              className="inline-flex min-h-11 items-center underline"
            >
              Show newest
            </Link>
          )}
        </form>
        {shown.length === 0 ? (
          <p className="mt-4 text-sm text-text-muted">
            {search || query.before
              ? 'No vouchers match this view.'
              : 'No vouchers have been saved for this branch.'}
          </p>
        ) : (
          <div className="mt-4 space-y-4">
            {shown.map((document) => {
              const kept = keep(document.id);
              const occurredDay = utcDay(document.occurredAt);
              const today = utcDay(new Date());
              const reversalDefault = occurredDay > today ? occurredDay : today;
              return (
                <article
                  key={document.id}
                  className="rounded-[var(--radius-sm)] border border-border-default p-4"
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <h3 className="font-medium text-text-strong">{document.reference}</h3>
                    <StatusPill status={document.status} />
                  </div>
                  <p className="mt-1 text-sm text-text-muted">
                    {document.currency} {(document.amountMinor / 100).toFixed(2)} ·{' '}
                    {new Date(document.occurredAt).toLocaleDateString('en-PK')}
                  </p>
                  {kept && (
                    <p role="alert" className="mt-2 text-sm text-destructive">
                      {kept.message}
                    </p>
                  )}
                  {document.status === 'DRAFT' ? (
                    <VoucherForm
                      action={perform}
                      branchId={branch.id}
                      document={document}
                      history={history}
                      retained={kept?.action === 'update' ? kept : undefined}
                    />
                  ) : (
                    <dl className="mt-3 grid gap-3 text-sm md:grid-cols-2">
                      <div className="min-w-0">
                        <dt className="text-text-muted">Evidence reference</dt>
                        <dd className="mt-1 break-words text-text-strong">{document.evidence}</dd>
                      </div>
                      <div className="min-w-0">
                        <dt className="text-text-muted">Business reason</dt>
                        <dd className="mt-1 break-words text-text-strong">{document.reason}</dd>
                      </div>
                    </dl>
                  )}
                  <form action={perform} className="mt-3 flex flex-wrap items-end gap-2">
                    <input type="hidden" name="branchId" value={branch.id} />
                    <HistoryFields history={history} />
                    <input type="hidden" name="documentId" value={document.id} />
                    <input type="hidden" name="version" value={document.version} />
                    <input
                      type="hidden"
                      name="idempotencyKey"
                      value={
                        kept && kept.action !== 'update' && kept.idempotencyKey
                          ? kept.idempotencyKey
                          : randomUUID()
                      }
                    />
                    {document.status === 'DRAFT' && (
                      <>
                        <Button type="submit" name="action" value="post">
                          Post
                        </Button>
                        <Button type="submit" name="action" value="cancel" variant="outline">
                          Cancel
                        </Button>
                      </>
                    )}
                    {document.status === 'POSTED' && (
                      <>
                        <label className="text-sm">
                          Reversal date
                          <Input
                            name="reversalDate"
                            type="date"
                            required
                            min={occurredDay}
                            defaultValue={kept?.reversalDate || reversalDefault}
                            aria-invalid={kept?.action === 'reverse' || undefined}
                          />
                        </label>
                        <label className="text-sm">
                          Reason for reversal
                          <Input
                            name="reversalReason"
                            required
                            maxLength={500}
                            placeholder="Reason for reversal"
                            className="max-w-sm"
                            defaultValue={kept?.reversalReason}
                            aria-invalid={kept?.action === 'reverse' || undefined}
                          />
                        </label>
                        <Button type="submit" name="action" value="reverse" variant="outline">
                          Reverse
                        </Button>
                      </>
                    )}
                  </form>
                </article>
              );
            })}
          </div>
        )}
        {hasOlder && (
          <Link
            href={destination({
              branch: branch.id,
              ref: search,
              before: shown[shown.length - 1]?.id,
              retry: retryNonce,
            })}
            className="mt-4 inline-flex min-h-11 items-center underline"
          >
            Older vouchers
          </Link>
        )}
      </SectionCard>
      <Link href="/pharmacy/finance" className="inline-flex min-h-11 items-center underline">
        Back to pharmacy finance
      </Link>
    </main>
  );
}

type HistoryContext = { ref: string; before: string };

function HistoryFields({ history }: { history?: HistoryContext }) {
  return (
    <>
      {history?.ref && <input type="hidden" name="historyRef" value={history.ref} />}
      {history?.before && <input type="hidden" name="historyBefore" value={history.before} />}
    </>
  );
}

function VoucherForm({
  action,
  branchId,
  document,
  history,
  retained,
}: {
  action: (form: FormData) => Promise<void>;
  branchId: string;
  history?: HistoryContext;
  retained?: Retained;
  document?: {
    id: string;
    version: number;
    reference: string;
    amountMinor: number;
    currency: string;
    occurredAt: Date | string;
    evidence: string;
    reason: string;
  };
}) {
  const day = retained?.occurredAt || (document ? utcDay(document.occurredAt) : utcDay(new Date()));
  const invalid = retained ? true : undefined;
  const value = (
    name: 'reference' | 'amount' | 'evidence' | 'reason',
    persisted: string | undefined
  ) => (retained ? retained[name] : persisted);
  return (
    <form action={action} className="mt-3 grid gap-3 md:grid-cols-2">
      {retained && !document && (
        <p role="alert" className="text-sm text-destructive md:col-span-2">
          {retained.message}
        </p>
      )}
      <input type="hidden" name="branchId" value={branchId} />
      <HistoryFields history={history} />
      <input type="hidden" name="idempotencyKey" value={retained?.idempotencyKey || randomUUID()} />
      <input type="hidden" name="currency" value={document?.currency ?? 'PKR'} />
      {document && (
        <>
          <input type="hidden" name="documentId" value={document.id} />
          <input type="hidden" name="version" value={document.version} />
        </>
      )}
      <label className="text-sm">
        Reference
        <Input
          name="reference"
          required
          maxLength={80}
          defaultValue={value('reference', document?.reference)}
          aria-invalid={invalid}
        />
      </label>
      <label className="text-sm">
        Amount ({document?.currency ?? 'PKR'})
        <Input
          name="amount"
          type="number"
          required
          min="0.01"
          step="0.01"
          defaultValue={value(
            'amount',
            document ? (document.amountMinor / 100).toFixed(2) : undefined
          )}
          aria-invalid={invalid}
        />
      </label>
      <label className="text-sm">
        Accounting date
        <Input name="occurredAt" type="date" required defaultValue={day} aria-invalid={invalid} />
      </label>
      <label className="text-sm">
        Evidence reference
        <Input
          name="evidence"
          required
          maxLength={500}
          defaultValue={value('evidence', document?.evidence)}
          aria-invalid={invalid}
        />
      </label>
      <label className="text-sm md:col-span-2">
        Business reason
        <Input
          name="reason"
          required
          maxLength={500}
          defaultValue={value('reason', document?.reason)}
          aria-invalid={invalid}
        />
      </label>
      <Button type="submit" className="w-fit" name="action" value={document ? 'update' : 'create'}>
        {document ? 'Save changes' : 'Save draft'}
      </Button>
    </form>
  );
}
