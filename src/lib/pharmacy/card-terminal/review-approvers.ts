import 'server-only';

import { can, subjectFromSession } from '@/lib/abac';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import { counterOperatorDenial } from '../counter-capability';
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
 */
export async function otherCardTerminalReviewers(
  db: ScopedDb,
  scope: Pick<LedgerScope, 'organizationId' | 'branchId' | 'actorId'>,
  now = new Date()
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
    if (
      await counterOperatorDenial(db, other, scope.organizationId, scope.branchId, {
        source: 'TRPC',
      })
    )
      continue;
    if (
      !(await can(subjectFromSession(other), 'pharmacy:manage', undefined, {
        db,
        now,
        source: 'TRPC',
      }))
    )
      continue;
    reviewers.push({ id: other.id, name: other.name });
  }
  return reviewers;
}
