import 'server-only';

import { can, subjectFromSession } from '@/lib/abac';
import { otherCardTerminalReviewers } from '@/lib/pharmacy/card-terminal/review-approvers';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';

/**
 * DEV-103: the other people who could approve reversing a supplier expense invoice or payment
 * at this branch. Owner decision (19 Nov 2026): a manager or owner approves with their own PIN,
 * and a solo owner approves their own, as elsewhere.
 *
 * The solo rule is the card-terminal review's (`otherCardTerminalReviewers`): someone counts only
 * if they hold an unrevoked own PIN on an active profile, pass this branch's operator gate and
 * hold `pharmacy:manage`. On top of that, a reversal runs through the AP router, which only an
 * owner-level (ADMIN) user with `admin:access` and `finance:read` can reach, so a manager who
 * could never open this screen does not count either: counting them would leave the solo owner
 * with nobody to ask.
 */
export async function otherApReversalApprovers(
  db: ScopedDb,
  scope: { organizationId: string; branchId: string; actorId: string },
  now = new Date()
): Promise<{ id: string; name: string | null }[]> {
  const reviewers = await otherCardTerminalReviewers(db, scope, now);
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
      !(await can(subject, 'finance:read', undefined, options))
    )
      continue;
    approvers.push({ id: user.id, name: user.name });
  }
  return approvers;
}
