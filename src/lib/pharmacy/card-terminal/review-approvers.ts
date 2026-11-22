import 'server-only';

import { can, subjectFromSession } from '@/lib/abac';
import { PHARMACY_FINANCE_MANAGE } from '@/lib/abac/pharmacy-finance-actions';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import { counterBranchAssignmentDenial, counterOperatorDenial } from '../counter-capability';
import { canAccessPharmacyFinance } from '../finance-access';
import type { LedgerScope } from '../stock-ledger';

/**
 * DEV-743: the other people who could resolve a card-terminal review at this branch. A second
 * person must resolve a charge the resolver took; only when this list is empty does the solo rule
 * let them resolve it themselves, with their own PIN.
 *
 * Someone counts only if they could actually do it here, now:
 *   - they could enter their own approval PIN: the candidates are built the way `isSoleApprover`
 *     (counter-line-approval.ts) builds them, from unrevoked staff PINs not tied to a device, on an
 *     ACTIVE staff profile of an ACTIVE member (what `verifyRefundPin` needs). A member on leave,
 *     or without such a PIN, does not count. A temporarily locked-out PIN still counts, as it does
 *     in `isSoleApprover`: the lockout is that person's to clear, and it never silently turns the
 *     resolver into a self-approver;
 *   - they pass the counter's own operator and branch gate for THIS branch
 *     (`counterOperatorDenial`, the gate the resolve procedure applies), so a manager assigned
 *     only to another branch, or whose counter access is denied, does not count;
 *   - they hold `pharmacy:manage` (the refund rule).
 *
 * DEV-103: another control that reuses this rule but whose procedure does not apply the counter
 * gate passes `gate: 'branch'`: then the operator gate is only the branch rule the counter gate
 * ends with (`counterBranchAssignmentDenial`: an active assignment to this branch, or an
 * organization ADMIN), without the `pharmacy:counter` grant. The default is the card-terminal
 * rule above. Refund corrections use the counter gate and also require accounts administration
 * and finance management access.
 */
export type ReviewerGate = 'counter' | 'branch' | 'refund-correction';

export async function otherCardTerminalReviewers(
  db: ScopedDb,
  scope: Pick<LedgerScope, 'organizationId' | 'branchId' | 'actorId'>,
  now = new Date(),
  options: { gate?: ReviewerGate } = {}
): Promise<{ id: string; name: string | null }[]> {
  const credentials = await db.restaurantOperatorCredential.findMany({
    where: {
      organizationId: scope.organizationId,
      type: 'PIN',
      revokedAt: null,
      deviceId: null,
      staffProfile: {
        status: 'ACTIVE',
        user: {
          organizationId: scope.organizationId,
          status: 'ACTIVE',
          id: { not: scope.actorId },
        },
      },
    },
    // Never a whole credential (its PIN hash) or user row: only what the checks below read.
    select: {
      staffProfile: {
        select: {
          user: {
            select: { id: true, name: true, role: true, department: true, status: true },
          },
        },
      },
    },
    orderBy: { id: 'asc' },
  });
  const checked = new Set<string>();
  const reviewers: { id: string; name: string | null }[] = [];
  for (const credential of credentials) {
    const other = credential.staffProfile.user;
    if (!other || other.id === scope.actorId || checked.has(other.id)) continue;
    checked.add(other.id);
    const denial =
      options.gate === 'branch'
        ? await counterBranchAssignmentDenial(db, other, scope.organizationId, scope.branchId)
        : await counterOperatorDenial(db, other, scope.organizationId, scope.branchId, {
            source: 'TRPC',
          });
    if (denial) continue;
    const subject = subjectFromSession(other);
    const access = { db, now, source: 'TRPC' as const };
    if (!(await can(subject, 'pharmacy:manage', undefined, access))) continue;
    if (
      options.gate === 'refund-correction' &&
      (!(await can(subject, 'admin:access', undefined, access)) ||
        !(await canAccessPharmacyFinance(other, access, PHARMACY_FINANCE_MANAGE)))
    )
      continue;
    reviewers.push({ id: other.id, name: other.name });
  }
  return reviewers;
}
