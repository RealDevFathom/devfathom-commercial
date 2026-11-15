import { can, subjectFromSession, type Action } from '@/lib/abac';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import { workspaceTimezone } from '@/lib/timezone';

type HomeUser = {
  id: string;
  role?: string | null;
  department?: string | null;
  status?: string | null;
};

/**
 * DEV-20: the Owner command centre is the dashboard of the organization administrator
 * (Owner/Admin), a pharmacy manager, and holders of the operational reports grant. Every
 * other pharmacy role (cashier, pharmacist, procurement, inventory, finance) lands on its
 * own staff home instead. Decided on the server for every dashboard render.
 */
export const PHARMACY_COMMAND_CENTRE_ACTIONS = [
  'reports:operational',
  'pharmacy:manage',
] as const satisfies readonly Action[];

export async function canOpenPharmacyCommandCentre(db: ScopedDb, user: HomeUser) {
  if (user.role === 'ADMIN') return true;
  const subject = subjectFromSession(user);
  for (const action of PHARMACY_COMMAND_CENTRE_ACTIONS) {
    if (await can(subject, action, undefined, { db })) return true;
  }
  return false;
}

/** Work a staff member may start from their home, each behind its own capability. */
export const PHARMACY_STAFF_LINKS = [
  {
    key: 'counter',
    action: 'pharmacy:counter',
    href: '/pharmacy/counter',
    label: 'Open Counter',
    description: 'Ring up sales, take payment and run your cash drawer.',
  },
  {
    key: 'dispense',
    action: 'pharmacy:dispense',
    href: '/pharmacy/pharmacist-queue',
    label: 'Pharmacist queue',
    description: 'Review prescriptions and release held items.',
  },
  {
    key: 'procurement',
    action: 'pharmacy:procurement',
    href: '/pharmacy/purchasing',
    label: 'Purchasing',
    description: 'Raise orders and receive supplier deliveries.',
  },
  {
    key: 'inventory',
    action: 'pharmacy:inventory',
    href: '/pharmacy/inventory',
    label: 'Inventory',
    description: 'Check stock, batches and expiry.',
  },
] as const satisfies readonly {
  key: string;
  action: Action;
  href: string;
  label: string;
  description: string;
}[];

export type PharmacyStaffLink = Omit<(typeof PHARMACY_STAFF_LINKS)[number], 'action'>;

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
 * The signed-in member's own home: the work their grants allow, their active branch
 * assignments in this organization, and only the cash drawers they opened themselves.
 */
export async function loadPharmacyStaffHome(
  db: ScopedDb,
  organizationId: string,
  user: HomeUser
): Promise<PharmacyStaffHome> {
  const subject = subjectFromSession(user);
  const links: PharmacyStaffLink[] = [];
  for (const { action, ...link } of PHARMACY_STAFF_LINKS) {
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
