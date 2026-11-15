import { can, subjectFromSession, type Action } from '@/lib/abac';
import { isModuleGranted } from '@/lib/module-catalog';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import { workspaceTimezone } from '@/lib/timezone';

type HomeUser = {
  id: string;
  role?: string | null;
  department?: string | null;
  status?: string | null;
};

/**
 * DEV-20: the Owner command centre is built only from `reports:operational` reads, so it
 * belongs to the organization administrator (Owner/Admin) and to members holding that grant
 * (owner-operator, a manager given reports, an auditor), as DEV-95 already decided. Pharmacists
 * get DEV-95's pharmacist home first. Every other member (cashier, procurement, inventory,
 * finance, or a manager without the reports grant) lands on their own staff home instead of
 * a command centre whose reads the server refuses. Decided on the server for every render.
 */
export const PHARMACY_COMMAND_CENTRE_ACTIONS = [
  'reports:operational',
] as const satisfies readonly Action[];

export async function canOpenPharmacyCommandCentre(db: ScopedDb, user: HomeUser) {
  if (user.role === 'ADMIN') return true;
  const subject = subjectFromSession(user);
  for (const action of PHARMACY_COMMAND_CENTRE_ACTIONS) {
    if (!(await can(subject, action, undefined, { db }))) return false;
  }
  return true;
}

/** Work a staff member may start from their home, each behind its own capability. */
export const PHARMACY_STAFF_LINKS = [
  {
    key: 'counter',
    action: 'pharmacy:counter',
    module: 'pharmacy-counter',
    href: '/pharmacy/counter',
    label: 'Open Counter',
    description: 'Ring up sales, take payment and run your cash drawer.',
  },
  {
    key: 'procurement',
    action: 'pharmacy:procurement',
    module: 'pharmacy-procurement',
    href: '/pharmacy/purchasing',
    label: 'Purchasing',
    description: 'Raise orders and receive supplier deliveries.',
  },
  {
    key: 'inventory',
    action: 'pharmacy:inventory',
    module: 'pharmacy-inventory',
    href: '/pharmacy/inventory',
    label: 'Inventory',
    description: 'Check stock, batches and expiry.',
  },
] as const satisfies readonly {
  key: string;
  action: Action;
  module: string;
  href: string;
  label: string;
  description: string;
}[];

export type PharmacyStaffLink = Omit<(typeof PHARMACY_STAFF_LINKS)[number], 'action' | 'module'>;

export type PharmacyStaffHome = {
  links: PharmacyStaffLink[];
  branches: { id: string; name: string }[];
  shifts: {
    id: string;
    branchName: string;
    businessDate: string;
    openedAt: string;
  }[];
  timeZone: string;
};

/**
 * The signed-in member's own home: the work their grants allow in the modules this workspace
 * licenses, their active branch assignments in this organization, and only the cash drawers
 * they opened themselves.
 */
export async function loadPharmacyStaffHome(
  db: ScopedDb,
  organizationId: string,
  user: HomeUser,
  enabledModules: readonly string[]
): Promise<PharmacyStaffHome> {
  const subject = subjectFromSession(user);
  const links: PharmacyStaffLink[] = [];
  for (const { action, module, ...link } of PHARMACY_STAFF_LINKS) {
    if (!isModuleGranted(module, enabledModules)) continue;
    if (await can(subject, action, undefined, { db })) links.push(link);
  }
  const [assignments, drawers, organization] = await Promise.all([
    db.pharmacyBranchAssignment.findMany({
      where: { organizationId, userId: user.id, active: true },
      select: { branchId: true },
    }),
    db.pharmacyDrawerSession.findMany({
      where: { organizationId, openedByActorId: user.id, status: 'OPEN' },
      select: { id: true, branchId: true, businessDate: true, openedAt: true },
      orderBy: { openedAt: 'desc' },
      take: 10,
    }),
    db.organization.findUnique({ where: { id: organizationId }, select: { timezone: true } }),
  ]);
  const branchIds = [
    ...new Set([...assignments.map((row) => row.branchId), ...drawers.map((row) => row.branchId)]),
  ];
  const known = branchIds.length
    ? await db.pharmacyBranch.findMany({
        where: { organizationId, id: { in: branchIds } },
        select: { id: true, name: true, active: true },
        orderBy: { name: 'asc' },
      })
    : [];
  const assigned = new Set(assignments.map((row) => row.branchId));
  const names = new Map(known.map((branch) => [branch.id, branch.name]));
  return {
    links,
    branches: known
      .filter((branch) => branch.active && assigned.has(branch.id))
      .map(({ id, name }) => ({ id, name })),
    shifts: drawers
      .filter((drawer) => names.has(drawer.branchId))
      .map((drawer) => ({
        id: drawer.id,
        branchName: names.get(drawer.branchId)!,
        businessDate: drawer.businessDate.toISOString().slice(0, 10),
        openedAt: drawer.openedAt.toISOString(),
      })),
    timeZone: workspaceTimezone(organization?.timezone),
  };
}
