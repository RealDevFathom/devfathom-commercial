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

export const metadata = { title: 'General journal · Pharmacy' };
const route = '/pharmacy/finance/general-journal';
const field = (form: FormData, name: string) => String(form.get(name) ?? '').trim();
const control = 'mt-1 min-h-11 w-full rounded-[var(--radius-sm)] border border-border-default bg-surface-raised px-3 text-sm text-text-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring';

async function tenantContext() {
  const actor = await resolveTenantActor();
  if (!actor) return null;
  return createTRPCContext({ session: actor.session, organization: actor.organization, support: actor.support });
}

function destination(branch: string, notice: string, kind: 'success' | 'error') {
  return `${route}?${new URLSearchParams({ branch, notice, kind })}`;
}

export default async function GeneralJournalPage({ searchParams }: { searchParams: Promise<{ branch?: string; notice?: string; kind?: string }> }) {
  const query = await searchParams;
  const ctx = await tenantContext();
  const heading = <PageHeader eyebrow="Pharmacy finance" heading="General journal" description="Record controlled non-trade operating accruals with balanced, traceable postings." />;
  if (!ctx?.session?.user) return <main className="space-y-6">{heading}<SectionCard title="Permission denied"><p role="alert" className="text-sm text-text-muted">Sign in to an authorized pharmacy workspace to use the general journal.</p></SectionCard></main>;

  const caller = pharmacyGeneralJournalRouter.createCaller(ctx);
  let branches: Awaited<ReturnType<typeof caller.branches>> = [];
  let documents: Awaited<ReturnType<typeof caller.list>> = [];
  let loadError: unknown;
  try {
    branches = await caller.branches();
    const selected = branches.find((item) => item.id === query.branch) ?? branches[0];
    if (selected) documents = await caller.list({ branchId: selected.id });
  } catch (error) {
    loadError = error;
  }
  if (loadError) {
    const error = loadError;
    const denied = error instanceof TRPCError && ['FORBIDDEN', 'UNAUTHORIZED'].includes(error.code);
    return <main className="space-y-6">{heading}<SectionCard title={denied ? 'Finance access required' : 'General journal unavailable'}><p role="alert" className="text-sm text-text-muted">{denied ? 'An administrator with Pharmacy Finance and financial-report permission is required.' : 'Reload the page to try again. No voucher was changed.'}</p></SectionCard></main>;
  }

  const branch = branches.find((item) => item.id === query.branch) ?? branches[0];
  if (!branch) return <main className="space-y-6">{heading}<SectionCard title="No active branch"><p className="text-sm text-text-muted">Activate a pharmacy branch before creating a voucher.</p></SectionCard></main>;

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
      // Use the rendered form's identity and timestamp for every retry.
      const idempotencyKey = field(form, 'idempotencyKey');
      if (action === 'create' || action === 'update') {
        const values = { reference: field(form, 'reference'), purpose: 'NONTRADE_OPERATING_ACCRUAL' as const, amountMinor: Math.round(Number(field(form, 'amount')) * 100), currency: field(form, 'currency') as 'PKR' | 'USD', occurredAt: new Date(`${field(form, 'occurredAt')}T12:00:00Z`), evidence: field(form, 'evidence'), reason: field(form, 'reason') };
        if (action === 'create') await actionCaller.createDraft({ branchId, ...values, idempotencyKey });
        else await actionCaller.updateDraft({ branchId, documentId, version, ...values });
        notice = action === 'create' ? 'Draft saved.' : 'Draft changes saved.';
      } else if (action === 'post') {
        await actionCaller.post({ branchId, documentId, version, idempotencyKey }); notice = 'Voucher posted.';
      } else if (action === 'cancel') {
        await actionCaller.cancel({ branchId, documentId, version }); notice = 'Draft cancelled.';
      } else if (action === 'reverse') {
        await actionCaller.reverse({ branchId, documentId, version, idempotencyKey, at: new Date(field(form, 'reversalAt')), reason: field(form, 'reversalReason') }); notice = 'Voucher reversed.';
      } else throw new Error('Unknown journal command.');
    } catch (error) {
      // createCaller bypasses the HTTP error formatter. Never put raw errors in a URL.
      const message = error instanceof TRPCError && error.code === 'CONFLICT'
        ? 'The voucher changed. Reload the page and try again.'
        : error instanceof TRPCError && error.code === 'BAD_REQUEST'
          ? 'Check the voucher details and accounting period, then try again.'
          : 'The command could not be completed. Reload the page and try again.';
      redirect(destination(branchId, message, 'error'));
    }
    redirect(destination(branchId, notice, 'success'));
  }

  return <main className="min-w-0 space-y-6">{heading}
    {query.notice && <p role="status" className={query.kind === 'error' ? 'text-sm text-status-danger' : 'text-sm text-status-success'}>{query.notice}</p>}
    <SectionCard title="Branch"><form action={route} className="flex items-end gap-3"><label className="flex-1 text-sm">Active branch<select name="branch" defaultValue={branch.id} className={control}>{branches.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label><Button type="submit">Open</Button></form></SectionCard>
    <SectionCard title="New accrual voucher"><VoucherForm action={perform} branchId={branch.id} /></SectionCard>
    <SectionCard title="Voucher history">{documents.length === 0 ? <p className="text-sm text-text-muted">No vouchers have been saved for this branch.</p> : <div className="space-y-4">{documents.map((document) => <article key={document.id} className="rounded-[var(--radius-sm)] border border-border-default p-4"><div className="flex flex-wrap items-center justify-between gap-2"><h3 className="font-medium text-text-strong">{document.reference}</h3><StatusPill status={document.status}/></div><p className="mt-1 text-sm text-text-muted">{document.currency} {(document.amountMinor / 100).toFixed(2)} · {new Date(document.occurredAt).toLocaleDateString('en-PK')}</p>{document.status === 'DRAFT' && <VoucherForm action={perform} branchId={branch.id} document={document} />}<form action={perform} className="mt-3 flex flex-wrap gap-2"><input type="hidden" name="branchId" value={branch.id}/><input type="hidden" name="documentId" value={document.id}/><input type="hidden" name="version" value={document.version}/><input type="hidden" name="idempotencyKey" value={randomUUID()}/><input type="hidden" name="reversalAt" value={new Date().toISOString()}/>{document.status === 'DRAFT' && <><Button type="submit" name="action" value="post">Post</Button><Button type="submit" name="action" value="cancel" variant="outline">Cancel</Button></>}{document.status === 'POSTED' && <><Input name="reversalReason" required maxLength={500} placeholder="Reason for reversal" className="max-w-sm"/><Button type="submit" name="action" value="reverse" variant="outline">Reverse</Button></>}</form></article>)}</div>}</SectionCard>
    <Link href="/pharmacy/finance" className="inline-flex min-h-11 items-center underline">Back to pharmacy finance</Link>
  </main>;
}

function VoucherForm({ action, branchId, document }: { action: (form: FormData) => Promise<void>; branchId: string; document?: { id: string; version: number; reference: string; amountMinor: number; currency: string; occurredAt: Date | string; evidence: string; reason: string } }) {
  const day = document ? new Date(document.occurredAt).toISOString().slice(0, 10) : new Date().toISOString().slice(0, 10);
  return <form action={action} className="mt-3 grid gap-3 md:grid-cols-2"><input type="hidden" name="branchId" value={branchId}/><input type="hidden" name="idempotencyKey" value={randomUUID()}/><input type="hidden" name="currency" value={document?.currency ?? 'PKR'}/>{document && <><input type="hidden" name="documentId" value={document.id}/><input type="hidden" name="version" value={document.version}/></>}<label className="text-sm">Reference<Input name="reference" required maxLength={80} defaultValue={document?.reference}/></label><label className="text-sm">Amount ({document?.currency ?? 'PKR'})<Input name="amount" type="number" required min="0.01" step="0.01" defaultValue={document ? (document.amountMinor / 100).toFixed(2) : undefined}/></label><label className="text-sm">Accounting date<Input name="occurredAt" type="date" required defaultValue={day}/></label><label className="text-sm">Evidence reference<Input name="evidence" required maxLength={500} defaultValue={document?.evidence}/></label><label className="text-sm md:col-span-2">Business reason<Input name="reason" required maxLength={500} defaultValue={document?.reason}/></label><Button type="submit" className="w-fit" name="action" value={document ? 'update' : 'create'}>{document ? 'Save changes' : 'Save draft'}</Button></form>;
}
