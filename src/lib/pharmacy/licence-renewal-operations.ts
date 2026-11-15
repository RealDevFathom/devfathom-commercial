import 'server-only';

import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import {
  licenceRenewalReminders,
  type RenewalReminder,
  type RenewalSubject,
} from './licence-renewal';

/**
 * #720 — read the renewal reminders for a workspace (optionally one branch).
 *
 * Branch licence and qualified-person registration come from the branch's
 * currently effective, non-placeholder regulatory profile, so saving the
 * renewed licence as a new profile version stops the reminder. Supplier
 * licences use each active supplier's latest unsuperseded filing, so filing the
 * renewed licence stops it too. Every query carries the organizationId
 * predicate; row-level security is the second wall.
 */
export async function readLicenceRenewalReminders(
  db: ScopedDb,
  input: { organizationId: string; branchId?: string; at?: Date }
): Promise<RenewalReminder[]> {
  const at = input.at ?? new Date();
  const { organizationId } = input;
  const [profiles, suppliers] = await Promise.all([
    db.branchRegulatoryProfile.findMany({
      where: {
        organizationId,
        ...(input.branchId ? { branchId: input.branchId } : {}),
        isPlaceholder: false,
        effectiveFrom: { lte: at },
        OR: [{ effectiveTo: null }, { effectiveTo: { gt: at } }],
        branch: { active: true },
      },
      orderBy: { effectiveFrom: 'desc' },
      select: {
        branchId: true,
        provinceCode: true,
        licenceCategory: true,
        licenceNumber: true,
        licenceValidTo: true,
        qualifiedPersonRegistration: true,
        qualifiedPersonValidTo: true,
        branch: { select: { name: true } },
      },
    }),
    db.pharmacySupplier.findMany({
      where: { organizationId, active: true, authorized: true },
      select: {
        name: true,
        licences: {
          where: { organizationId, supersededBy: { none: {} } },
          orderBy: { expiresAt: 'desc' },
          take: 1,
          select: { licenceNumber: true, expiresAt: true },
        },
      },
    }),
  ]);

  const subjects: RenewalSubject[] = [];
  const seenBranches = new Set<string>();
  for (const profile of profiles) {
    // Overlapping effective rows: the newest effective version speaks for the branch.
    if (seenBranches.has(profile.branchId)) continue;
    seenBranches.add(profile.branchId);
    const common = {
      holder: profile.branch.name,
      provinceCode: profile.provinceCode,
      licenceCategory: profile.licenceCategory,
    };
    subjects.push(
      {
        ...common,
        kind: 'BRANCH_LICENCE',
        reference: profile.licenceNumber,
        validTo: profile.licenceValidTo,
      },
      {
        ...common,
        kind: 'QUALIFIED_PERSON_REGISTRATION',
        reference: profile.qualifiedPersonRegistration,
        validTo: profile.qualifiedPersonValidTo,
      }
    );
  }
  for (const supplier of suppliers) {
    const licence = supplier.licences[0];
    if (!licence) continue;
    subjects.push({
      kind: 'SUPPLIER_LICENCE',
      holder: supplier.name,
      reference: licence.licenceNumber,
      validTo: licence.expiresAt,
    });
  }
  return licenceRenewalReminders(subjects, at);
}
