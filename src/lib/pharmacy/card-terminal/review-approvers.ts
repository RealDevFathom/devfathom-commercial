import 'server-only';

import { can, subjectFromSession } from '@/lib/abac';
import { ACTIVE_STATUSES } from '@/lib/auth/session-state';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import { counterOperatorDenial } from '../counter-capability';
import type { LedgerScope } from '../stock-ledger';

/**
 * DEV-743: the other people who could resolve a card-terminal review at this branch. A second
 * person must resolve a charge the resolver took; only when this list is empty does the solo rule
 * let them resolve it themselves, with their own PIN.
 *
 * Someone counts only if they could actually do it here: an active member who passes the counter's
 * own operator and branch gate for THIS branch (`counterOperatorDenial`, the gate the resolve
 * procedure applies) and holds `pharmacy:manage` (the refund rule). A manager assigned only to
 * another branch, or whose counter access is denied, does not block the resolver. The query shape
 * is `isSoleActiveApprover`'s: every other active member of the organization, checked one by one.
 */
export async function otherCardTerminalReviewers(
  db: ScopedDb,
  scope: Pick<LedgerScope, 'organizationId' | 'branchId' | 'actorId'>,
  now = new Date()
): Promise<{ id: string; name: string | null }[]> {
  const others = await db.user.findMany({
    where: {
      organizationId: scope.organizationId,
      status: { in: [...ACTIVE_STATUSES] as Array<'ACTIVE' | 'ON_LEAVE'> },
      id: { not: scope.actorId },
    },
    select: { id: true, name: true, role: true, department: true, status: true },
    orderBy: { id: 'asc' },
  });
  const reviewers: { id: string; name: string | null }[] = [];
  for (const other of others) {
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
