import { PHARMACY_FINANCE_MANAGE } from '@/lib/abac/pharmacy-finance-actions';
import 'server-only';

import { can, subjectFromSession } from '@/lib/abac';
import { canAccessPharmacyFinance } from '@/lib/pharmacy/finance-access';
import { otherCardTerminalReviewers } from '@/lib/pharmacy/card-terminal/review-approvers';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';

/**
 * DEV-103: the other people who could approve reversing a supplier expense invoice or payment
 * at this branch. Owner decision (19 Nov 2026): a manager or owner approves with their own PIN,
 * and a solo owner approves their own, as elsewhere.
 *
 * The set is exactly the people the reversal procedures (`reverseInvoice`, `reverseSettlement`)
 * would let approve, with the same gates, and nobody else:
 *   - `adminProcedure`: an active session and `admin:access`;
 *   - `authorizeGeneralJournal`: an owner-level (ADMIN) member of this organization with
 *     `finance:read`, at an active branch of it (an ADMIN may act at every such branch);
 *   - `actorMayRefund`: `pharmacy:manage`;
 *   - `authenticateRefundPin`: an unrevoked own PIN (an enrolled authenticator rides on it) on an
 *     ACTIVE staff profile of an ACTIVE member, so someone on leave, inactive or without a PIN
 *     does not count.
 * The PIN, `pharmacy:manage` and branch parts are the shared solo rule
 * (`otherCardTerminalReviewers`) with its `branch` gate: the reversal procedures never apply the
 * counter operator gate (`pharmacy:counter`), so a second owner without a counter grant, or with
 * a counter DENY, still counts. Counting fewer people than could approve would let the recorder
 * self-approve while someone else could; counting more would leave a solo owner nobody to ask.
 */
export async function otherApReversalApprovers(
  db: ScopedDb,
  scope: { organizationId: string; branchId: string; actorId: string },
  now = new Date()
): Promise<{ id: string; name: string | null }[]> {
  const reviewers = await otherCardTerminalReviewers(db, scope, now, { gate: 'branch' });
  if (!reviewers.length) return [];
  const users = await db.user.findMany({
    where: {
      organizationId: scope.organizationId,
      id: { in: reviewers.map((reviewer) => reviewer.id) },
      role: 'ADMIN',
      status: 'ACTIVE',
    },
    select: { id: true, name: true, role: true, department: true, status: true },
    orderBy: { id: 'asc' },
  });
  const approvers: { id: string; name: string | null }[] = [];
  for (const user of users) {
    if (user.id === scope.actorId) continue;
    // Both gates the reversal procedures apply: `adminProcedure` (admin:access) and
    // `authorizeGeneralJournal` (finance:read). Someone denied either could never approve.
    const subject = subjectFromSession(user);
    const options = { db, now, source: 'TRPC' as const };
    if (
      !(await can(subject, 'admin:access', undefined, options)) ||
      !(await canAccessPharmacyFinance(user, options)) ||
      !(await canAccessPharmacyFinance(user, options, PHARMACY_FINANCE_MANAGE))
    )
      continue;
    approvers.push({ id: user.id, name: user.name });
  }
  return approvers;
}
