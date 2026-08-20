import 'server-only';

import { z } from 'zod';

import type { RestaurantJobContext } from '@/lib/restaurant/job-handlers';

/**
 * M7-L4 / §11.5 — SOP late/missed sweep: scheduler handler.
 *
 * Two status transitions are driven EXCLUSIVELY by this scheduler job (never by
 * request-path side effects — BUILD-ASSUMPTIONS §SOP-defaults (4)):
 *
 *   IN_PROGRESS  → LATE    when windowEndsAt has passed without SUBMITTED
 *   SCHEDULED    → LATE    same condition (not yet started when window closed)
 *   LATE         → MISSED  when (windowEndsAt + graceMinutes * 60s) has passed
 *   SCHEDULED    → MISSED  same (never reached IN_PROGRESS before grace expired)
 *
 * The handler is idempotent: processing an already-LATE or already-MISSED
 * occurrence is a no-op. At-least-once execution is safe because the status
 * update is guarded by the WHERE clause (only active states qualify).
 *
 * Registration: one key added to restaurantJobHandlers in job-handlers.ts.
 */

export const SOP_LATE_MISSED_JOB = 'sop.sweepLateMissed';

const PayloadSchema = z
  .object({
    /** Override the "now" instant for deterministic tests. */
    now: z.string().datetime().optional(),
  })
  .strict();

export async function sopLateMissedHandler({ db, job }: RestaurantJobContext): Promise<void> {
  const payload = PayloadSchema.parse(job.payload);
  const now = payload.now ? new Date(payload.now) : new Date();

  // One query sweeps both LATE and MISSED in a single pass. Prisma does not
  // support multi-case UPDATE, so we issue two targeted updates:

  // 1. LATE: window has closed but grace has not yet elapsed (or grace = 0).
  //    Transitions SCHEDULED + IN_PROGRESS → LATE.
  await db.restaurantSopOccurrence.updateMany({
    where: {
      status: { in: ['SCHEDULED', 'IN_PROGRESS'] },
      windowEndsAt: { lte: now },
    },
    data: { status: 'LATE' },
  });

  // 2. MISSED: grace period also elapsed (windowEndsAt + graceMinutes * 60s <= now).
  //    Transitions SCHEDULED + LATE (not yet submitted) → MISSED.
  //    graceMinutes lives on the assignment row, so we JOIN to compute the boundary.
  await db.$queryRaw`
    UPDATE restaurant_sop_occurrences occ
    SET    status = 'MISSED', "updatedAt" = ${now}
    FROM   restaurant_sop_assignments asgn
    WHERE  occ."assignmentId" = asgn.id
      AND  occ.status IN ('SCHEDULED', 'LATE')
      AND  (occ."windowEndsAt" + (INTERVAL '1 minute' * asgn."graceMinutes")) <= ${now}
  `;
}
