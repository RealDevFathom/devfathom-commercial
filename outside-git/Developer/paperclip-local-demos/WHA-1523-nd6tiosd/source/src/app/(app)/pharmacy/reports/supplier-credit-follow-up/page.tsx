import type { Metadata } from 'next';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { PageHeader } from '@/components/ui/page-header';
import { SectionCard } from '@/components/ui/section-card';
import { can, subjectFromSession } from '@/lib/abac';
import { hasModule } from '@/lib/entitlements';
import { supplierCreditFollowUp } from '@/lib/pharmacy/supplier-credit-follow-up';
import { pharmacyPurchasingRouter } from '@/server/routers/pharmacy-purchasing';
import { pharmacyReportsRouter } from '@/server/routers/pharmacy-reports';
import { tenantContext } from '../../purchasing/_lib/console';
import { FollowUpPacket, type FollowUpPacketData } from './packet';

export const metadata: Metadata = { title: 'Supplier-credit follow-up · Pharmacy reports' };

const ROUTE = '/pharmacy/reports/supplier-credit-follow-up';
type Query = Partial<Record<'branch' | 'from' | 'to', string | string[]>>;
const value = (input: string | string[] | undefined) =>
  typeof input === 'string' ? input : undefined;
const validDate = (input: string) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input)) return false;
  const date = new Date(`${input}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === input;
};
const iso = (date: Date | null) =>
  date && Number.isFinite(date.getTime()) ? date.toISOString() : null;

function Notice({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <SectionCard title={title} titleLevel={2}>
      <p role="status" className="text-sm text-text-muted">
        {children}
      </p>
    </SectionCard>
  );
}

async function reportAccess() {
  const ctx = await tenantContext();
  if (
    !ctx?.session?.user?.id ||
    !ctx.entitlements.organizationId ||
    ctx.organization?.id !== ctx.entitlements.organizationId ||
    !hasModule(ctx.entitlements, 'pharmacy-reports') ||
    !hasModule(ctx.entitlements, 'pharmacy-procurement') ||
    !(await can(
      subjectFromSession({ ...ctx.session.user, id: ctx.session.user.id }),
      'reports:financial',
      undefined,
      { db: ctx.db, source: 'TRPC', ip: ctx.requestMeta.ip }
    ))
  )
    return { kind: 'denied' as const };
  // Reuse the Reports permission and tenant-scoped branch reader before any financial reads.
  const { branches } = await pharmacyReportsRouter.createCaller(ctx).branches();
  return { kind: 'allowed' as const, ctx, branches };
}

export default async function SupplierCreditFollowUpPage({
  searchParams,
}: {
  searchParams: Promise<Query>;
}) {
  const query = await searchParams;
  const heading = (
    <PageHeader
      eyebrow="Pharmacy reports"
      heading="Supplier-credit follow-up"
      description="Prepare a draft evidence pack from recorded returns, debit notes and supplier credit."
    />
  );
  let access: Awaited<ReturnType<typeof reportAccess>> | null = null;
  try {
    access = await reportAccess();
  } catch {
    // Read errors produce a safe access state; rendering happens outside the catch boundary.
  }
  if (!access || access.kind === 'denied') {
    return (
      <main className="min-w-0 space-y-6">
        {heading}
        <Notice title={access ? 'Financial report access required' : 'Report access unavailable'}>
          {access
            ? 'An active session, financial and operational report permissions, and Pharmacy reports and procurement access are required. Ask your workspace administrator to review access.'
            : 'Your session, permissions or branch scope could not be verified. Reload to retry, or contact your workspace administrator.'}
        </Notice>
      </main>
    );
  }
  const { ctx, branches } = access;

  const today = new Date().toISOString().slice(0, 10);
  const start = new Date(`${today}T00:00:00.000Z`);
  start.setUTCDate(start.getUTCDate() - 29);
  const from = value(query.from) ?? start.toISOString().slice(0, 10);
  const to = value(query.to) ?? today;
  const invalidRange = !validDate(from) || !validDate(to) || from > to;
  const requestedBranch = value(query.branch);
  const branchId = requestedBranch ?? (branches.length === 1 ? branches[0]!.id : '');
  const branch = branches.find((item) => item.id === branchId);
  // Duplicate parameters must not silently select a different period or branch.
  const invalidQuery = Object.values(query).some(Array.isArray);
  let packet: FollowUpPacketData | null = null;
  let readFailed = false;
  if (branch && !invalidRange && !invalidQuery) {
    try {
      const caller = pharmacyPurchasingRouter.createCaller(ctx);
      const [returns, credits] = await Promise.all([
        caller.purchaseReturns({ branchId: branch.id }),
        caller.supplierCredits({ branchId: branch.id }),
      ]);
      const asOf = new Date();
      const fromTime = Date.parse(`${from}T00:00:00.000Z`);
      const untilTime = Date.parse(`${to}T00:00:00.000Z`) + 86_400_000;
      const selected = returns.filter((row) => {
        const at = row.createdAt.getTime();
        return at >= fromTime && at < untilTime;
      });
      const queue = supplierCreditFollowUp({
        scope: { organizationId: ctx.entitlements.organizationId, branchId: branch.id },
        returns: selected,
        credits,
        asOf,
        // Existing readers expose neither coverage metadata nor a shared historical snapshot.
        coverage: 'partial',
      });
      const byId = new Map(selected.map((row) => [row.id, row]));
      const rows: FollowUpPacketData['rows'] = [
        ...queue.claims.map((claim) => {
          const original = byId.get(claim.returnId)!;
          return {
            id: claim.id,
            supplierId: original.supplierId,
            supplier: claim.supplier,
            returnId: original.id,
            returnReference: original.reference,
            debitReference: claim.reference,
            status: 'DISPATCHED' as const,
            dispatchedAt: iso(original.dispatchedAt),
            deadline: null,
            window: null,
            ageDays: claim.ageDays,
            outstandingMinor: claim.outstandingMinor,
            allocatedMinor: claim.allocatedMinor,
            credits: claim.credits,
          };
        }),
        ...queue.dispatch.map((item) => ({
          id: item.id,
          supplierId: byId.get(item.id)!.supplierId,
          supplier: item.supplier,
          returnId: item.id,
          returnReference: item.reference,
          debitReference: null,
          status: 'SUBMITTED' as const,
          dispatchedAt: null,
          deadline: item.deadline === null ? null : new Date(item.deadline).toISOString(),
          window: item.state,
          ageDays: null,
          outstandingMinor: null,
          allocatedMinor: null,
          credits: [],
        })),
      ];
      const currency = ctx.organization?.currency;
      packet = {
        branch: { id: branch.id, name: branch.name },
        from,
        to,
        preparedAt: queue.asOf,
        currency: currency && /^[A-Z]{3}$/.test(currency) ? currency : null,
        coverage: queue.coverage,
        excluded: queue.excluded + returns.filter((row) => !iso(row.createdAt)).length,
        rows,
      };
    } catch {
      readFailed = true;
    }
  }

  return (
    <main className="min-w-0 space-y-6">
      {heading}
      <SectionCard title="Prepare follow-up" titleLevel={2}>
        <p className="mb-4 text-sm text-text-muted" id="follow-up-period">
          Dates select return creation dates, inclusive UTC. Balances use current recorded
          allocations, not historical closing balances. Each Prepare rereads the source records.
        </p>
        <form action={ROUTE} method="get" className="flex flex-wrap items-end gap-4">
          <div className="min-w-0 flex-1 basis-48">
            <label htmlFor="follow-up-branch" className="mb-1 block text-sm">
              Branch
            </label>
            <select
              id="follow-up-branch"
              name="branch"
              defaultValue={branch?.id ?? ''}
              required
              aria-invalid={Boolean(requestedBranch && !branch)}
              aria-describedby="follow-up-validation"
              className="min-h-11 w-full rounded-sm border border-border bg-surface-card px-3 text-sm text-text-strong focus-visible:outline-2 focus-visible:outline-ring"
            >
              <option value="">Choose a branch</option>
              {branches.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                </option>
              ))}
            </select>
          </div>
          {(['from', 'to'] as const).map((key) => (
            <div key={key} className="min-w-0 flex-1 basis-40">
              <label htmlFor={`follow-up-${key}`} className="mb-1 block text-sm">
                {key === 'from' ? 'From' : 'To'}
              </label>
              <Input
                id={`follow-up-${key}`}
                name={key}
                type="date"
                required
                defaultValue={key === 'from' ? from : to}
                className="min-h-11"
                aria-invalid={invalidRange}
                aria-describedby="follow-up-period follow-up-validation"
              />
            </div>
          ))}
          <Button type="submit" className="min-h-11" disabled={branches.length === 0}>
            Prepare draft
          </Button>
        </form>
        <p id="follow-up-validation" role="status" className="mt-3 text-sm text-text-muted">
          {invalidRange || invalidQuery
            ? 'Choose one valid branch and a valid date range with From on or before To.'
            : requestedBranch && !branch
              ? 'The requested branch is outside your available report scope.'
              : !branches.length
                ? 'No branches are available in your report scope.'
                : !branch
                  ? 'Choose a branch to prepare its draft evidence packs.'
                  : 'Permission: financial reports. Preparation is read-only and works without Ask Fathom.'}
        </p>
      </SectionCard>
      {readFailed ? (
        <Notice title="Source records unavailable">
          The evidence pack could not be prepared. Use Prepare draft to retry. No balances have been
          substituted and no financial records have been changed.
        </Notice>
      ) : packet ? (
        <FollowUpPacket packet={packet} />
      ) : null}
    </main>
  );
}
