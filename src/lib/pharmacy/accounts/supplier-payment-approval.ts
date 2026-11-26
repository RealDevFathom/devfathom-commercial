import { TRPCError } from '@trpc/server';
import { can, subjectFromSession } from '@/lib/abac';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import type { BookkeepingScope } from '../bookkeeping';
import { authenticateRefundPin } from '../refund-authorization';

export const SUPPLIER_MAKER_REFUSAL = 'Someone else must pay an invoice you recorded.';
export const SUPPLIER_APPROVAL_REQUIRED =
  'Enter the approving administrator’s PIN or authenticator code.';

export async function authorizeSupplierPayment(
  db: ScopedDb,
  scope: BookkeepingScope,
  payment: { recordedBy: string; amountMinor: number; reference: string; action: string },
  approval: { pin?: string; approverEmail?: string }
) {
  // The policy and payment serialize with a concurrent change to this business setting.
  const [business] = await db.$queryRaw<
    { limitMinor: number | null }[]
  >`SELECT "supplierPaymentApprovalLimitMinor" AS "limitMinor" FROM organizations WHERE id=${scope.organizationId} FOR SHARE`;
  if (!business)
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: 'Business payment settings are unavailable.',
    });
  const payingOwn = payment.recordedBy === scope.actorId;
  const aboveLimit = business.limitMinor !== null && payment.amountMinor > business.limitMinor;
  if (!payingOwn && !aboveLimit) return;
  const actor = await db.user.findFirst({
    where: { id: scope.actorId, organizationId: scope.organizationId, status: 'ACTIVE' },
    select: { id: true, role: true, status: true, department: true },
  });
  const isAdministrator =
    actor?.role === 'ADMIN' &&
    (await can(subjectFromSession(actor), 'admin:access', undefined, { db }));
  if (payingOwn && !isAdministrator)
    throw new TRPCError({ code: 'FORBIDDEN', message: SUPPLIER_MAKER_REFUSAL });
  if (!payingOwn && isAdministrator) return;
  const administrator = payingOwn
    ? actor
    : approval.approverEmail &&
      (await db.user.findFirst({
        where: {
          organizationId: scope.organizationId,
          email: { equals: approval.approverEmail, mode: 'insensitive' },
          role: 'ADMIN',
          status: 'ACTIVE',
        },
        select: { id: true, role: true, status: true, department: true },
      }));
  if (
    !administrator ||
    !(await can(subjectFromSession(administrator), 'admin:access', undefined, { db }))
  )
    throw new TRPCError({ code: 'FORBIDDEN', message: SUPPLIER_APPROVAL_REQUIRED });
  const selfApproval = payment.recordedBy === administrator.id;
  if (!approval.pin)
    throw new TRPCError({ code: 'FORBIDDEN', message: SUPPLIER_APPROVAL_REQUIRED });
  const verified = await authenticateRefundPin({
    organizationId: scope.organizationId,
    actorId: administrator.id,
    requestedById: scope.actorId,
    pin: approval.pin,
    action: payment.action,
    policy: payingOwn ? 'SUPPLIER_PAYMENT_SELF_APPROVAL' : 'SUPPLIER_PAYMENT_LIMIT_APPROVAL',
    administratorApproval: true,
  });
  if ('blocked' in verified)
    throw new TRPCError({ code: 'FORBIDDEN', message: SUPPLIER_APPROVAL_REQUIRED });
  await db.auditLog.create({
    data: {
      organizationId: scope.organizationId,
      actorId: scope.actorId,
      source: 'TRPC',
      category: 'PHARMACY',
      operation: 'EXECUTE',
      action: payment.action + '.approved',
      outcome: 'SUCCESS',
      metadata: {
        branchId: scope.branchId,
        approverId: administrator.id,
        selfApproval,
        limitMinor: business.limitMinor,
        recordedBy: payment.recordedBy,
        amountMinor: payment.amountMinor,
        reference: payment.reference,
      },
    },
  });
}
