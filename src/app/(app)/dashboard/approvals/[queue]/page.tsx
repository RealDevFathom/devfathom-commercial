import Link from 'next/link';
import type { PharmacySupplierSubmissionKind, Prisma } from '@/generated/prisma/client';
import { notFound } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { PageHeader } from '@/components/ui/page-header';
import { SectionCard } from '@/components/ui/section-card';
import { can, subjectFromSession } from '@/lib/abac';
import { hasModule } from '@/lib/entitlements';
import { assignedRegisterBranchIds } from '@/lib/pharmacy/controlled-register';
import {
  pendingSupplierSubmissions,
  pendingRegisterIncidents,
} from '@/server/pharmacy-dashboard-approvals';
import { reachableProcurementBranchIds } from '@/server/pharmacy-procurement-scope';
import { pharmacyReportAccess, pharmacyReportsRouter } from '@/server/routers/pharmacy-reports';
import { pharmacySafetyRouter } from '@/server/routers/pharmacy-safety';
import { pharmacySupplierLinksRouter } from '@/server/routers/pharmacy-supplier-links';
import { tenantContext } from '../../../pharmacy/purchasing/_lib/console';

type Queue = 'suppliers' | 'register';
async function scopeFor(queue: Queue, branch?: string) {
  const ctx = await tenantContext();
  if (!ctx?.session?.user || ctx.session.user.organizationId !== ctx.entitlements.organizationId)
    notFound();
  const user = ctx.session.user;
  const organizationId = ctx.entitlements.organizationId;
  const report = await pharmacyReportAccess(ctx);
  if (report !== 'ALL' && !report.length) notFound();
  if (
    !hasModule(
      ctx.entitlements,
      queue === 'suppliers' ? 'pharmacy-procurement' : 'pharmacy-safety'
    ) ||
    !(await can(
      subjectFromSession(user),
      queue === 'suppliers' ? 'pharmacy:procurement' : 'pharmacy:safety',
      undefined,
      { db: ctx.db, source: 'TRPC', ip: ctx.requestMeta.ip }
    ))
  )
    notFound();
  const admitted = await pharmacyReportsRouter.createCaller(ctx).branches({ dashboard: true });
  const selected = admitted.branches.filter((b) => !branch || b.id === branch).map((b) => b.id);
  const allowed =
    queue === 'suppliers'
      ? await reachableProcurementBranchIds(ctx, selected)
      : await assignedRegisterBranchIds(ctx.db, organizationId, user.id);
  const branchIds = selected.filter((b) => allowed.includes(b));
  if (!branchIds.length) notFound();
  return { ctx, organizationId, branchIds };
}

async function decide(queue: Queue, branch: string | undefined, form: FormData) {
  'use server';
  const { ctx, organizationId, branchIds } = await scopeFor(queue, branch);
  const id = form.get('id'),
    decision = form.get('decision'),
    reason = form.get('reason');
  if (
    typeof id !== 'string' ||
    typeof reason !== 'string' ||
    !reason.trim() ||
    reason.length > 1000
  )
    return;
  if (queue === 'suppliers') {
    if (decision !== 'approve' && decision !== 'reject') return;
    const row = await ctx.db.pharmacySupplierSubmission.findFirst({
      where: { ...pendingSupplierSubmissions(organizationId, branchIds), id },
      select: { id: true, branchId: true },
    });
    if (!row) notFound();
    await pharmacySupplierLinksRouter.createCaller(ctx).approveProposal({
      submissionId: id,
      branchId: row.branchId,
      approved: decision === 'approve',
      reason,
    });
  } else {
    if (decision !== 'approve') return;
    const row = await ctx.db.pharmacyRegisterIncident.findFirst({
      where: { ...pendingRegisterIncidents(organizationId, branchIds), id },
      select: { id: true },
    });
    if (!row) notFound();
    await pharmacySafetyRouter
      .createCaller(ctx)
      .approveRegisterIncident({ incidentId: id, reason });
  }
  revalidatePath('/dashboard');
  revalidatePath('/dashboard/approvals/[queue]', 'page');
}

function supplierEvidence(
  kind: PharmacySupplierSubmissionKind,
  payload: Prisma.JsonValue,
  lines: { id: string; lineNumber: number }[]
): string {
  const fields = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : {};
  switch (kind) {
    case 'SUBSTITUTION_PROPOSAL':
      return typeof fields.description === 'string'
        ? fields.description
        : 'No substitution description supplied.';
    case 'ETA':
      return typeof fields.eta === 'string'
        ? `Estimated arrival: ${fields.eta}`
        : 'No arrival time supplied.';
    case 'DOCUMENT':
      return typeof fields.fileName === 'string'
        ? `Document: ${fields.fileName}`
        : 'Supplier document submitted.';
    case 'PARTIAL_ACCEPTANCE': {
      const quantities = fields.quantities;
      if (quantities && typeof quantities === 'object' && !Array.isArray(quantities)) {
        const accepted = lines.flatMap((line) =>
          typeof quantities[line.id] === 'number'
            ? [`Line ${line.lineNumber}: ${quantities[line.id]} packs`]
            : []
        );
        if (accepted.length) return accepted.join(' · ');
      }
      return 'No line quantities supplied.';
    }
    case 'ACKNOWLEDGEMENT':
      return 'The supplier acknowledged the order.';
    case 'REJECTION':
      return 'The supplier rejected the order.';
  }
}

export default async function ApprovalQueue({
  params,
  searchParams,
}: {
  params: Promise<{ queue: string }>;
  searchParams: Promise<{ branch?: string; after?: string }>;
}) {
  const { queue } = await params;
  if (queue !== 'suppliers' && queue !== 'register') notFound();
  const { branch, after } = await searchParams;
  const { ctx, organizationId, branchIds } = await scopeFor(queue, branch);
  const page = { orderBy: { id: 'asc' as const }, take: 26 };
  const cursor = after ? { id: { gt: after } } : {};
  const rows =
    queue === 'suppliers'
      ? (
          await ctx.db.pharmacySupplierSubmission.findMany({
            ...page,
            where: { ...pendingSupplierSubmissions(organizationId, branchIds), ...cursor },
            select: {
              id: true,
              kind: true,
              sourceEvidence: true,
              payload: true,
              actionLink: {
                select: {
                  purchaseOrder: {
                    select: {
                      reference: true,
                      supplier: { select: { name: true } },
                      lines: {
                        select: { id: true, lineNumber: true },
                        orderBy: { lineNumber: 'asc' },
                      },
                    },
                  },
                },
              },
            },
          })
        ).map((row) => ({
          id: row.id,
          title: row.actionLink.purchaseOrder.supplier.name,
          detail: `${row.actionLink.purchaseOrder.reference} · ${row.kind.toLowerCase().replaceAll('_', ' ')}`,
          evidence: [
            supplierEvidence(row.kind, row.payload, row.actionLink.purchaseOrder.lines),
            row.sourceEvidence,
          ]
            .filter(Boolean)
            .join('\n'),
        }))
      : (
          await ctx.db.pharmacyRegisterIncident.findMany({
            ...page,
            where: { ...pendingRegisterIncidents(organizationId, branchIds), ...cursor },
            select: { id: true, registerEntryId: true, expectedBalance: true, actualBalance: true },
          })
        ).map((row) => ({
          id: row.id,
          title: 'Register balance discrepancy',
          detail: `Expected ${row.expectedBalance} units · Recorded ${row.actualBalance} units`,
          evidence: `Register entry ${row.registerEntryId}`,
        }));
  const next = new URLSearchParams(branch ? { branch } : {});
  if (rows.length > 25) next.set('after', rows[24]!.id);
  return (
    <div className="space-y-4">
      <PageHeader
        heading={
          queue === 'suppliers' ? 'Supplier submission approvals' : 'Register incident approvals'
        }
        actions={<Link href="/dashboard">Back to dashboard</Link>}
      />
      {rows.length === 0 && (
        <SectionCard title="Queue clear">No decisions are waiting in these branches.</SectionCard>
      )}
      {rows.slice(0, 25).map((row) => (
        <SectionCard key={row.id} title={row.title}>
          <p>{row.detail}</p>
          <p className="my-3 whitespace-pre-wrap break-words text-sm text-text-muted">
            {row.evidence}
          </p>
          <form
            className="flex flex-wrap items-end gap-2"
            action={decide.bind(null, queue, branch)}
          >
            <input type="hidden" name="id" value={row.id} />
            <label className="min-w-0 flex-1 text-sm">
              Decision reason
              <Input name="reason" required maxLength={1000} />
            </label>
            <Button type="submit" name="decision" value="approve">
              Approve
            </Button>
            {queue === 'suppliers' && (
              <Button variant="outline" type="submit" name="decision" value="reject">
                Reject
              </Button>
            )}
          </form>
        </SectionCard>
      ))}
      {rows.length > 25 && <Link href={`/dashboard/approvals/${queue}?${next}`}>Next 25</Link>}
    </div>
  );
}
