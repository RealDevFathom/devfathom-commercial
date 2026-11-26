import 'server-only';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import { actorIsPharmacyOwner } from '../procurement-access';
import { assertReviewBranch } from './staged-review-read';
import { sourceReport, type Prepared } from '../../../../tools/abuzar-import/prepared';
import { appendParties, appendHistory, planParties, planHistory } from './abuzar-parties-history';

export class AbuzarReviewError extends Error {}
export const phaseInput = z.strictObject({
  step: z.enum(['parties', 'history']),
  sourceBranch: z.string().trim().min(1).max(128),
  addToExisting: z.boolean(),
});
type Scope = { organizationId: string; branchId: string; actorId: string };
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

/** The caller supplies one serializable tenant transaction, including the audit entry. */
export async function runAbuzarStep(
  db: ScopedDb,
  scope: Scope,
  data: Prepared,
  options: z.infer<typeof phaseInput>,
  confirmed?: string
) {
  const { organizationId, branchId, actorId } = scope;
  await assertReviewBranch(db, organizationId, branchId);
  if (confirmed)
    await db.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${'pharmacy-abuzar:' + organizationId},0))`;
  const postedSales = await db.pharmacySale.count({
    where: { organizationId, status: { in: ['COMPLETED', 'VOID'] } },
  });
  const blocked =
    postedSales > 0 &&
    !(options.addToExisting && (await actorIsPharmacyOwner(db, organizationId, actorId)));
  const source = sourceReport(data);
  const decision =
    options.step === 'parties'
      ? await planParties(db, scope, data.tables.parties).then((rows) => ({
          rows,
          apply: () => appendParties(db, scope, rows),
        }))
      : await planHistory(db, scope, options.sourceBranch, data.tables.history).then((rows) => ({
          rows,
          apply: () => appendHistory(db, scope, rows),
        }));
  const skipped = decision.rows.flatMap((r) =>
    r.reason ? [{ row: r.index, reason: r.reason }] : []
  );
  const create = decision.rows.length - skipped.length;
  const confirmation = digest({
    scope,
    options,
    source: data.checksum,
    sourceTotals: source.totals,
    postedSales,
    skipped,
    create,
  });
  const receipt = digest({ scope, options, source: data.checksum });
  const report = { step: options.step, source, create, skipped, blocked, confirmation, applied: 0 };
  if (!confirmed) return report;
  if (blocked)
    throw new AbuzarReviewError('Posted sales require the owner to choose add to existing.');
  if (confirmed !== confirmation) {
    const previous = await db.auditLog.findFirst({
      where: {
        organizationId,
        actorId,
        action: 'pharmacy.abuzar.' + options.step,
        targetId: receipt,
        metadata: { path: ['confirmation'], equals: confirmed },
      },
      select: { id: true },
    });
    if (create === 0 && previous) return report;
    throw new AbuzarReviewError('Review the current dry run totals before applying this step.');
  }
  if (!create) return report;
  await decision.apply();
  await db.auditLog.create({
    data: {
      organizationId,
      actorId,
      source: 'REST_API',
      category: 'PHARMACY',
      operation: 'CREATE',
      action: 'pharmacy.abuzar.' + options.step,
      targetId: receipt,
      metadata: { confirmation, branchId, rows: create, sourceChecksum: data.checksum },
    },
  });
  return { ...report, applied: create };
}
