import { can, subjectFromSession, type CanOptions } from '@/lib/abac';

/**
 * What a signed-in pharmacy member may open beyond the counter. Each flag is
 * resolved through the same capability checks the server procedures enforce,
 * so pages and the rail never offer a surface the server would refuse.
 *
 * - `commandCentre`: the owner dashboard — Owner/Admin (session ADMIN), anyone
 *   holding `reports:operational`, and managers (`pharmacy:manage`).
 * - `dayClose`: session ADMIN or `pharmacy:close` (mirrors `requireCloseAccess`).
 * - `reports`: `reports:operational` (the `pharmacyReports` capability gate).
 * - `inventoryControl`: `pharmacy:inventory` (create location, write-off, …).
 * - `inventoryImport`: session ADMIN (the owner-import router is admin-only).
 * - `dispense`: `pharmacy:dispense` (pharmacist queue, substitution, Rx fill).
 * - `prescriptions`: `pharmacy:prescriptions` (the prescription workspace; a
 *   dispense grant covers it, and tenant administrators hold it by policy).
 */
export type PharmacyStaffAccess = {
  commandCentre: boolean;
  dayClose: boolean;
  reports: boolean;
  inventoryControl: boolean;
  inventoryImport: boolean;
  dispense: boolean;
  prescriptions: boolean;
};

export const NO_PHARMACY_STAFF_ACCESS: PharmacyStaffAccess = {
  commandCentre: false,
  dayClose: false,
  reports: false,
  inventoryControl: false,
  inventoryImport: false,
  dispense: false,
  prescriptions: false,
};

type SessionUser = Parameters<typeof subjectFromSession>[0];

export async function readPharmacyStaffAccess(
  user: SessionUser | null | undefined,
  db: NonNullable<CanOptions['db']>
): Promise<PharmacyStaffAccess> {
  if (!user) return NO_PHARMACY_STAFF_ACCESS;
  const subject = subjectFromSession(user);
  const options = { db, source: 'TRPC' as const };
  const admin = subject.role === 'ADMIN';
  const [reports, manage, close, inventory, dispense, prescriptions] = await Promise.all([
    can(subject, 'reports:operational', undefined, options),
    can(subject, 'pharmacy:manage', undefined, options),
    can(subject, 'pharmacy:close', undefined, options),
    can(subject, 'pharmacy:inventory', undefined, options),
    can(subject, 'pharmacy:dispense', undefined, options),
    can(subject, 'pharmacy:prescriptions', undefined, options),
  ]);
  return {
    commandCentre: admin || reports || manage,
    dayClose: admin || close,
    reports,
    inventoryControl: inventory,
    inventoryImport: admin,
    dispense,
    prescriptions,
  };
}

/** The rail's capability names for the access flags above. */
export function pharmacyStaffCapabilities(access: PharmacyStaffAccess): string[] {
  return [
    ...(access.commandCentre ? ['pharmacy:command-centre'] : []),
    ...(access.dayClose ? ['pharmacy:close'] : []),
    ...(access.reports ? ['reports:operational'] : []),
    ...(access.inventoryControl ? ['pharmacy:inventory'] : []),
    ...(access.inventoryImport ? ['pharmacy:inventory-import'] : []),
    ...(access.dispense ? ['pharmacy:dispense'] : []),
    ...(access.prescriptions ? ['pharmacy:prescriptions'] : []),
  ];
}
