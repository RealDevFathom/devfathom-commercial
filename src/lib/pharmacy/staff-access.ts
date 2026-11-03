import { can, subjectFromSession, type CanOptions } from '@/lib/abac';
import { isModuleGranted } from '@/lib/module-catalog';
import {
  NO_PHARMACY_STAFF_ACCESS,
  type PharmacyStaffAccess,
} from '@/lib/pharmacy/staff-access-flags';

export { NO_PHARMACY_STAFF_ACCESS, type PharmacyStaffAccess };

type SessionUser = Parameters<typeof subjectFromSession>[0];

export async function readPharmacyStaffAccess(
  user: SessionUser | null | undefined,
  db: NonNullable<CanOptions['db']>
): Promise<PharmacyStaffAccess> {
  if (!user) return NO_PHARMACY_STAFF_ACCESS;
  const subject = subjectFromSession(user);
  const options = { db, source: 'TRPC' as const };
  const admin = subject.role === 'ADMIN';
  const [reports, manage, close, inventory, dispense, prescriptions, procurement] =
    await Promise.all([
      can(subject, 'reports:operational', undefined, options),
      can(subject, 'pharmacy:manage', undefined, options),
      can(subject, 'pharmacy:close', undefined, options),
      can(subject, 'pharmacy:inventory', undefined, options),
      can(subject, 'pharmacy:dispense', undefined, options),
      can(subject, 'pharmacy:prescriptions', undefined, options),
      can(subject, 'pharmacy:procurement', undefined, options),
    ]);
  return {
    commandCentre: admin || reports || manage,
    dayClose: admin || close,
    reports,
    inventoryControl: inventory,
    inventoryImport: admin,
    dispense,
    prescriptions,
    purchasing: procurement,
    administration: admin || manage,
  };
}

/**
 * Where a pharmacy member lands after signing in. The command centre's audience
 * stays on `/dashboard` (null); a pharmacist lands on the Pharmacist queue and
 * counter staff on the Counter, each only when the organization licenses that
 * surface. Nobody outside the command centre's audience is sent to it.
 */
export function pharmacyHomePath(
  access: PharmacyStaffAccess,
  enabledModules: readonly string[] | null | undefined
): string | null {
  if (access.commandCentre) return null;
  const modules = enabledModules ?? [];
  if (access.dispense && isModuleGranted('pharmacy-dispensing', modules)) {
    return '/pharmacy/pharmacist-queue';
  }
  if (isModuleGranted('pharmacy-counter', modules)) return '/pharmacy/counter';
  return null;
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
    ...(access.purchasing ? ['pharmacy:procurement'] : []),
    ...(access.administration ? ['pharmacy:administration'] : []),
  ];
}
