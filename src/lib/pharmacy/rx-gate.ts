/**
 * SEC (live High): server-side prescription gate for regulated sale lines.
 *
 * A medicine flagged `rx` or `restricted` (and not `controlled`, which has its
 * own register flow) may only sit on a payable bill when the line carries an
 * append-only `PharmacyRxLineAuthorization`: a linked prescription line, or an
 * audited pharmacist override with a reason. Controlled lines need the fill the
 * controlled path writes (`controlled:<saleLineId>`).
 *
 * Tender, complete and sandbox payment call `assertSaleLinesCleared`, which
 * locks the sale lines and re-reads the CURRENT medicine flags, so a line
 * inserted around `addLine` or a flag flipped after it is refused at payment.
 */
import { Prisma } from '@/generated/prisma/client';
import type { LedgerScope } from './stock-ledger';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';

export type RegulatedFlags = { rx: boolean; restricted: boolean; controlled: boolean };

export class PharmacySafetyBlockError extends Error {
  readonly reason = 'SAFETY_BLOCK' as const;
  constructor(readonly saleLineIds: string[]) {
    super('SAFETY_BLOCK');
    this.name = 'PharmacySafetyBlockError';
  }
}

export function needsPrescription(medicine: RegulatedFlags | null | undefined): boolean {
  return Boolean(medicine && (medicine.rx || medicine.restricted || medicine.controlled));
}

export function controlledFillKey(saleLineId: string): string {
  return `controlled:${saleLineId}`;
}

/**
 * (d) Forward-compatible seam for #111's emergency no-prescription supply path.
 *
 * #111 lets a pharmacist record a witnessed emergency supply of a CONTROLLED
 * medicine without a prescription (a `PharmacyEmergencyRxFollowUp` keyed by sale
 * line). Such a line carries no prescription fill, so this payment gate would
 * otherwise refuse it. We clear it ONLY when the branch is permitted to operate
 * on that supply's drug schedule — the same permitted-schedule rule the branch
 * regulatory guard enforces — so an emergency supply can never launder a
 * schedule the branch may not dispense.
 *
 * The emergency model ships with #111, not this branch, so we feature-detect its
 * delegate and fail closed (no exemption) when it is absent: this branch's
 * behaviour is unchanged and the exemption activates only once #111 merges.
 */
type EmergencySupplyDb = {
  pharmacyEmergencyRxFollowUp?: {
    findMany: (args: {
      where: { organizationId: string; saleLineId: { in: string[] } };
      select: { saleLineId: true; schedule: true };
    }) => Promise<Array<{ saleLineId: string; schedule: string | null }>>;
  };
};

async function emergencyExemptSaleLineIds(
  db: ScopedDb,
  scope: LedgerScope,
  controlledSaleLineIds: string[]
): Promise<Set<string>> {
  const emergency = (db as unknown as EmergencySupplyDb).pharmacyEmergencyRxFollowUp;
  if (!emergency || controlledSaleLineIds.length === 0) return new Set();
  const now = new Date();
  const [followUps, profile] = await Promise.all([
    emergency.findMany({
      where: { organizationId: scope.organizationId, saleLineId: { in: controlledSaleLineIds } },
      select: { saleLineId: true, schedule: true },
    }),
    db.branchRegulatoryProfile.findFirst({
      where: {
        organizationId: scope.organizationId,
        branchId: scope.branchId,
        effectiveFrom: { lte: now },
        OR: [{ effectiveTo: null }, { effectiveTo: { gt: now } }],
      },
      orderBy: { effectiveFrom: 'desc' },
      select: { permittedSchedules: true },
    }),
  ]);
  const permitted = new Set(profile?.permittedSchedules ?? []);
  // A follow-up with no resolvable schedule is NOT exempt — fail closed.
  return new Set(
    followUps
      .filter((row) => row.schedule !== null && permitted.has(row.schedule))
      .map((row) => row.saleLineId)
  );
}

export async function assertSaleLinesCleared(
  db: ScopedDb,
  scope: LedgerScope,
  saleId: string
): Promise<void> {
  // One statement: lock this sale's lines and read the medicine flags as they are NOW.
  const lines = await db.$queryRaw<
    Array<{ id: string; rx: boolean; restricted: boolean; controlled: boolean }>
  >(
    Prisma.sql`SELECT l.id, m.rx, m.restricted, m.controlled
      FROM pharmacy_sale_lines AS l
      JOIN pharmacy_medicines AS m ON m.id = l."medicineId" AND m."organizationId" = l."organizationId"
      WHERE l."organizationId" = ${scope.organizationId} AND l."branchId" = ${scope.branchId} AND l."saleId" = ${saleId}
      FOR UPDATE OF l`
  );
  const regulated = (Array.isArray(lines) ? lines : []).filter((line) => needsPrescription(line));
  if (regulated.length === 0) return;
  const ids = regulated.map((line) => line.id);
  const [authorizations, fills] = await Promise.all([
    db.pharmacyRxLineAuthorization.findMany({
      where: { organizationId: scope.organizationId, saleLineId: { in: ids } },
      select: { saleLineId: true },
    }),
    db.prescriptionFill.findMany({
      where: {
        organizationId: scope.organizationId,
        idempotencyKey: { in: ids.map(controlledFillKey) },
      },
      select: { idempotencyKey: true },
    }),
  ]);
  const authorized = new Set(authorizations.map((row) => row.saleLineId));
  const filled = new Set(fills.map((row) => row.idempotencyKey));
  const refused = regulated
    .filter((line) =>
      line.controlled
        ? !filled.has(controlledFillKey(line.id))
        : !authorized.has(line.id) && !filled.has(controlledFillKey(line.id))
    )
    .map((line) => line.id);
  if (refused.length === 0) return;
  // (d) A controlled line with no fill may still be cleared by a #111 emergency
  // supply — but only on a schedule this branch is permitted to dispense.
  const refusedSet = new Set(refused);
  const controlledRefused = regulated
    .filter((line) => line.controlled && refusedSet.has(line.id))
    .map((line) => line.id);
  const exempt = await emergencyExemptSaleLineIds(db, scope, controlledRefused);
  const stillRefused = refused.filter((id) => !exempt.has(id));
  if (stillRefused.length > 0) throw new PharmacySafetyBlockError(stillRefused);
}
