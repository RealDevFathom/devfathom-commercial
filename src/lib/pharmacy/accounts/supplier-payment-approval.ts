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
  const selfApproval = payment.recordedBy === scope.actorId;
  if (!selfApproval) return;
  const administrator = await db.user.findFirst({
    where: {
      organizationId: scope.organizationId,
      id: scope.actorId,
      role: 'ADMIN',
      status: 'ACTIVE',
    },
    select: { id: true, role: true, status: true, department: true },
  });
  if (
    !administrator ||
    !(await can(subjectFromSession(administrator), 'admin:access', undefined, { db }))
  )
    throw new TRPCError({ code: 'FORBIDDEN', message: SUPPLIER_MAKER_REFUSAL });
  if (!approval.pin)
    throw new TRPCError({ code: 'FORBIDDEN', message: SUPPLIER_APPROVAL_REQUIRED });
  const verified = await authenticateRefundPin({
    organizationId: scope.organizationId,
    actorId: administrator.id,
    requestedById: scope.actorId,
    pin: approval.pin,
    action: payment.action,
    policy: 'SUPPLIER_PAYMENT_SELF_APPROVAL',
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
        recordedBy: payment.recordedBy,
        amountMinor: payment.amountMinor,
        reference: payment.reference,
      },
    },
  });
}
