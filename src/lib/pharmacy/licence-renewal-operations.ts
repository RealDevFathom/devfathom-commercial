import 'server-only';

import type { ScopedDb } from '@/lib/tenancy/scoped-db';

import { planRenewalReminders, type RenewalReminder, type RenewalSubject } from './licence-renewal';

/**
 * #720 — reads the stored licences that renewal reminders are planned from:
 *
 *  - the branch drug sale licence and the qualified person's registration, from
 *    the newest regulatory profile version that has not ended. A renewal saved
 *    as a new profile version — in force now or scheduled to start later —
 *    therefore replaces the old dates and the reminder stops;
 *  - supplier licences of active, authorized suppliers: per supplier and
 *    licence type, the latest expiry among verified filings that no later
 *    filing supersedes. Recording the renewed licence stops the reminder.
 *
 * Runs on the caller's tenant-scoped client (FORCE RLS), and still names the
 * organization and branches in every predicate, as the other readers do.
 */
export async function readLicenceRenewalSubjects(
  db: ScopedDb,
  input: { organizationId: string; branchIds: readonly string[]; at: Date }
): Promise<RenewalSubject[]> {
  const { organizationId, at } = input;
  const branchIds = [...new Set(input.branchIds)];
  const [profiles, licences] = await Promise.all([
    branchIds.length
      ? db.branchRegulatoryProfile.findMany({
          where: {
            organizationId,
            branchId: { in: branchIds },
            branch: { active: true },
            OR: [{ effectiveTo: null }, { effectiveTo: { gt: at } }],
          },
          orderBy: [{ branchId: 'asc' }, { effectiveFrom: 'desc' }],
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
        })
      : Promise.resolve([]),
    db.pharmacySupplierLicence.findMany({
      where: {
        organizationId,
        supersededBy: { none: {} },
        // The purchasing gate trades only on verified filings, so an unverified
        // renewal keeps the reminder running until someone verifies it.
        verifiedAt: { not: null },
        supplier: { active: true, authorized: true },
      },
      orderBy: [{ supplierId: 'asc' }, { expiresAt: 'desc' }],
      select: {
        supplierId: true,
        licenceType: true,
        licenceNumber: true,
        expiresAt: true,
        supplier: { select: { name: true } },
      },
    }),
  ]);

  const subjects: RenewalSubject[] = [];
  const seenBranches = new Set<string>();
  for (const profile of profiles) {
    // Newest version first: the first row per branch is the latest saved one.
    if (seenBranches.has(profile.branchId)) continue;
    seenBranches.add(profile.branchId);
    subjects.push(
      {
        kind: 'BRANCH_LICENCE',
        subjectId: profile.branchId,
        branchId: profile.branchId,
        label: `${profile.branch.name} drug sale licence`,
        reference: profile.licenceNumber,
        expiresAt: profile.licenceValidTo,
        provinceCode: profile.provinceCode,
        licenceCategory: profile.licenceCategory,
      },
      {
        kind: 'QUALIFIED_PERSON_REGISTRATION',
        subjectId: profile.branchId,
        branchId: profile.branchId,
        label: `${profile.branch.name} qualified person registration`,
        reference: profile.qualifiedPersonRegistration,
        expiresAt: profile.qualifiedPersonValidTo,
        provinceCode: profile.provinceCode,
        licenceCategory: null,
      }
    );
  }

  const seenLicences = new Set<string>();
  for (const licence of licences) {
    const key = `${licence.supplierId}:${licence.licenceType.trim().toLowerCase()}`;
    // Latest expiry first: an older unsuperseded filing of the same type is not
    // what the supplier trades on once a newer one is on file.
    if (seenLicences.has(key)) continue;
    seenLicences.add(key);
    subjects.push({
      kind: 'SUPPLIER_LICENCE',
      subjectId: key,
      branchId: null,
      label: `${licence.supplier.name} ${licence.licenceType} licence`,
      reference: licence.licenceNumber,
      expiresAt: licence.expiresAt,
      provinceCode: null,
      licenceCategory: null,
    });
  }
  return subjects;
}

export async function readLicenceRenewalReminders(
  db: ScopedDb,
  input: { organizationId: string; branchIds: readonly string[]; at?: Date }
): Promise<RenewalReminder[]> {
  const at = input.at ?? new Date();
  return planRenewalReminders(await readLicenceRenewalSubjects(db, { ...input, at }), at);
}
