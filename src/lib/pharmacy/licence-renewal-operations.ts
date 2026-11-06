import 'server-only';

import type { ScopedDb } from '@/lib/tenancy/scoped-db';

import { planRenewalReminders, type RenewalReminder, type RenewalSubject } from './licence-renewal';

/**
 * #720 — reads the stored licences that renewal reminders are planned from:
 *
 *  - the branch drug sale licence and the qualified person's registration, from
 *    the current profile followed by continuously covered future versions.
 *    A scheduled renewal only replaces dates when it leaves no coverage gap;
 *  - independent supplier licences of active, authorized suppliers, following
 *    explicit supersession chains. Only verified renewals replace earlier filings.
 *    A later-expiring verified filing of the same type and number is the renewal
 *    even when saved without a link, and an expired filing is dropped while the
 *    supplier holds a valid one of the same type.
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
          orderBy: [{ branchId: 'asc' }, { effectiveFrom: 'asc' }],
          select: {
            branchId: true,
            effectiveFrom: true,
            effectiveTo: true,
            provinceCode: true,
            licenceCategory: true,
            licenceNumber: true,
            licenceValidFrom: true,
            licenceValidTo: true,
            qualifiedPersonRegistration: true,
            qualifiedPersonValidFrom: true,
            qualifiedPersonValidTo: true,
            branch: { select: { name: true } },
          },
        })
      : Promise.resolve([]),
    db.pharmacySupplierLicence.findMany({
      where: {
        organizationId,
        supplier: { active: true, authorized: true },
      },
      orderBy: [{ supplierId: 'asc' }, { expiresAt: 'desc' }],
      select: {
        id: true,
        supersedesId: true,
        verifiedAt: true,
        supplierId: true,
        licenceType: true,
        licenceNumber: true,
        expiresAt: true,
        supplier: { select: { name: true } },
      },
    }),
  ]);

  const subjects: RenewalSubject[] = [];
  const profilesByBranch = new Map<string, typeof profiles>();
  for (const profile of profiles) {
    const versions = profilesByBranch.get(profile.branchId) ?? [];
    versions.push(profile);
    profilesByBranch.set(profile.branchId, versions);
  }
  // Walk forward from the current version, stopping at the first gap. Licence
  // and qualified-person coverage can renew independently on the same profile.
  function coveredProfile(
    versions: typeof profiles,
    validFrom: 'licenceValidFrom' | 'qualifiedPersonValidFrom',
    validTo: 'licenceValidTo' | 'qualifiedPersonValidTo'
  ) {
    let covered = versions[0]!;
    for (const next of versions.slice(1)) {
      if (
        covered[validFrom].getTime() > Math.max(at.getTime(), covered.effectiveFrom.getTime()) ||
        covered.effectiveTo?.getTime() !== next.effectiveFrom.getTime() ||
        next.effectiveFrom > covered[validTo] ||
        next[validFrom] > next.effectiveFrom ||
        next[validTo] <= next.effectiveFrom
      )
        break;
      covered = next;
    }
    return covered;
  }
  for (const versions of profilesByBranch.values()) {
    const profile = coveredProfile(versions, 'licenceValidFrom', 'licenceValidTo');
    const qualifiedPerson = coveredProfile(
      versions,
      'qualifiedPersonValidFrom',
      'qualifiedPersonValidTo'
    );
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
        reference: qualifiedPerson.qualifiedPersonRegistration,
        expiresAt: qualifiedPerson.qualifiedPersonValidTo,
        provinceCode: qualifiedPerson.provinceCode,
        licenceCategory: null,
      }
    );
  }

  const licencesById = new Map(licences.map((licence) => [licence.id, licence]));
  const verifiedLicences = licences.filter((licence) => licence.verifiedAt !== null);
  const supersededIds = new Set<string>();
  const rootsById = new Map<string, string>();
  for (const licence of verifiedLicences) {
    let root = licence;
    const visited = new Set([root.id]);
    while (root.supersedesId) {
      const prior = licencesById.get(root.supersedesId);
      if (!prior || prior.supplierId !== licence.supplierId || visited.has(prior.id)) break;
      root = prior;
      visited.add(root.id);
      supersededIds.add(root.id);
    }
    rootsById.set(licence.id, root.id);
  }
  const normalize = (value: string) => value.trim().toLowerCase();
  const typeKey = (licence: (typeof licences)[number]) =>
    JSON.stringify([licence.supplierId, normalize(licence.licenceType)]);
  const seenRoots = new Set<string>();
  const seenNumbers = new Set<string>();
  const current: { licence: (typeof licences)[number]; subjectId: string }[] = [];
  for (const licence of verifiedLicences) {
    // An unverified renewal cannot retire verified evidence. Unrelated licences
    // of the same type remain separate, even when one expires much later.
    const subjectId = rootsById.get(licence.id)!;
    if (supersededIds.has(licence.id) || seenRoots.has(subjectId)) continue;
    seenRoots.add(subjectId);
    // Licences arrive latest expiry first: a sooner-expiring filing of the same
    // type and number is the one a renewal saved without a supersession link replaces.
    const numberKey = JSON.stringify([
      licence.supplierId,
      normalize(licence.licenceType),
      normalize(licence.licenceNumber),
    ]);
    if (seenNumbers.has(numberKey)) continue;
    seenNumbers.add(numberKey);
    current.push({ licence, subjectId });
  }
  const validTypes = new Set(
    current
      .filter(({ licence }) => licence.expiresAt.getTime() > at.getTime())
      .map(({ licence }) => typeKey(licence))
  );
  for (const { licence, subjectId } of current) {
    // Purchasing already accepts a valid filing of the same type, so an expired
    // one beside it leaves the owner nothing to renew.
    if (licence.expiresAt.getTime() <= at.getTime() && validTypes.has(typeKey(licence))) continue;
    subjects.push({
      kind: 'SUPPLIER_LICENCE',
      subjectId,
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
