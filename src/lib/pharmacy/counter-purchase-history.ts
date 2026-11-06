import 'server-only';

import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import { lockPatientConsent } from './consent-writer';

/** Caller must supply a tenant transaction and authorize the actor and branch. */
export async function readCounterPurchaseHistory(
  db: ScopedDb,
  scope: { organizationId: string; branchId: string; patientId: string }
) {
  await lockPatientConsent(db, scope.organizationId, scope.patientId);
  const currentPurpose = async (purpose: 'LOYALTY' | 'DISPENSING') => {
    const where = { organizationId: scope.organizationId, patientId: scope.patientId, purpose };
    const ordered = await db.patientConsent.findFirst({
      where: { ...where, purposeSequence: { not: null } },
      orderBy: { purposeSequence: 'desc' },
      select: { granted: true, revokedAt: true },
    });
    if (ordered) return ordered.granted && ordered.revokedAt === null;
    const legacy = await db.patientConsent.findMany({
      where: { ...where, purposeSequence: null },
      select: { channel: true, version: true, granted: true, revokedAt: true },
    });
    if (!legacy.length) return false;
    const channels = new Set(legacy.map((event) => event.channel));
    if (channels.size === 1) {
      const latest = legacy.reduce((a, b) => (a.version > b.version ? a : b));
      return latest.granted && latest.revokedAt === null;
    }
    // Historical timestamps cannot prove cross-channel order. If any event
    // revokes, require a new purpose decision; all-grant histories are clear.
    return legacy.every((event) => event.granted && event.revokedAt === null);
  };
  if (!(await currentPurpose('LOYALTY')) || !(await currentPurpose('DISPENSING'))) {
    return { state: 'consent_needed' as const, purchases: [] };
  }
  const customer = await db.pharmacyCustomer.findFirst({
    where: { organizationId: scope.organizationId, patientId: scope.patientId, active: true },
    select: { id: true },
  });
  if (!customer) return { state: 'not_linked' as const, purchases: [] };
  const sales = await db.pharmacySale.findMany({
    where: {
      organizationId: scope.organizationId,
      branchId: scope.branchId,
      customerId: customer.id,
      status: 'COMPLETED',
    },
    orderBy: [{ completedAt: 'desc' }, { id: 'desc' }],
    take: 10,
    select: {
      id: true,
      completedAt: true,
      lines: { select: { medicine: { select: { productName: true } } } },
    },
  });
  return {
    state: 'ready' as const,
    purchases: sales.map((sale) => ({
      saleId: sale.id,
      completedAt: sale.completedAt?.toISOString() ?? null,
      medicines: sale.lines.map((line) => line.medicine.productName),
    })),
  };
}
