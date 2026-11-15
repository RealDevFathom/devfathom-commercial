import { isModuleGranted } from '@/lib/module-catalog';

/**
 * DEV-497 — where a pharmacy member who cannot run onboarding goes instead of
 * the `/pharmacy` front door, decided from the same ABAC-resolved capabilities
 * the rail uses (`pharmacyAccess.navigation`):
 *
 * - a member holding `reports:operational` (owner-operator, manager, auditor)
 *   belongs on the command centre at `/dashboard`;
 * - a pharmacist (`pharmacy:dispense`, with Dispensing licensed) on their queue;
 * - a cashier (`pharmacy:counter`, with Counter licensed) on the counter;
 * - anyone else on their own staff home at `/dashboard`, which is always usable.
 *
 * Never a page the member's grants or the workspace's licence would refuse.
 */
export function pharmacyLandingPath(
  capabilities: readonly string[],
  enabledModules: readonly string[] | null | undefined
): string {
  const modules = enabledModules ?? [];
  if (capabilities.includes('reports:operational')) return '/dashboard';
  if (capabilities.includes('pharmacy:dispense') && isModuleGranted('pharmacy-dispensing', modules))
    return '/pharmacy/pharmacist-queue';
  if (capabilities.includes('pharmacy:counter') && isModuleGranted('pharmacy-counter', modules))
    return '/pharmacy/counter';
  return '/dashboard';
}
