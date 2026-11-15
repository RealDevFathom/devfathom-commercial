import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  can: vi.fn(),
  assignmentFindMany: vi.fn(),
  drawerFindMany: vi.fn(),
  branchFindMany: vi.fn(),
  organizationFindUnique: vi.fn(),
}));
vi.mock('@/lib/abac', async () => ({
  ...(await vi.importActual<typeof import('@/lib/abac')>('@/lib/abac')),
  can: mocks.can,
}));

import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import { canOpenPharmacyCommandCentre, loadPharmacyStaffHome } from './staff-home';

const db = {
  pharmacyBranchAssignment: { findMany: mocks.assignmentFindMany },
  pharmacyDrawerSession: { findMany: mocks.drawerFindMany },
  pharmacyBranch: { findMany: mocks.branchFindMany },
  organization: { findUnique: mocks.organizationFindUnique },
} as unknown as ScopedDb;
const cashier = { id: 'cashier_1', role: 'EMPLOYEE', status: 'ACTIVE' };
const ALL_MODULES = [
  'pharmacy-counter',
  'pharmacy-dispensing',
  'pharmacy-procurement',
  'pharmacy-inventory',
  'pharmacy-reports',
];
const grant = (...actions: string[]) =>
  mocks.can.mockImplementation(async (_subject: unknown, action: string) =>
    actions.includes(action)
  );

beforeEach(() => {
  vi.clearAllMocks();
  mocks.assignmentFindMany.mockResolvedValue([]);
  mocks.drawerFindMany.mockResolvedValue([]);
  mocks.branchFindMany.mockResolvedValue([]);
  mocks.organizationFindUnique.mockResolvedValue({ timezone: 'Asia/Karachi' });
});

describe('canOpenPharmacyCommandCentre (DEV-20)', () => {
  it.each([
    ['cashier', ['pharmacy:counter', 'pharmacy:orders'], false],
    ['pharmacist', ['pharmacy:dispense', 'pharmacy:catalogue-review', 'pharmacy:close'], false],
    ['procurement', ['pharmacy:procurement'], false],
    ['finance', ['reports:financial'], false],
    // A manager without the reports grant could not load a single command-centre widget.
    ['manager without reports', ['pharmacy:manage', 'pharmacy:orders'], false],
    // A report reader is not the Owner, an Admin or a Manager.
    ['auditor', ['reports:operational'], false],
    ['manager with reports', ['pharmacy:manage', 'reports:operational'], true],
  ])('decides the %s from their grants', async (_role, grants, expected) => {
    grant(...grants);
    await expect(canOpenPharmacyCommandCentre(db, cashier)).resolves.toBe(expected);
  });

  it('keeps the command centre for the organization administrator without a DB grant', async () => {
    grant();
    await expect(
      canOpenPharmacyCommandCentre(db, { id: 'owner', role: 'ADMIN', status: 'ACTIVE' })
    ).resolves.toBe(true);
    expect(mocks.can).not.toHaveBeenCalled();
  });
});

describe('loadPharmacyStaffHome (DEV-20)', () => {
  it('gives a cashier the Counter, their active assigned branches and only their own open shift', async () => {
    grant('pharmacy:counter', 'pharmacy:orders');
    mocks.assignmentFindMany.mockResolvedValue([{ branchId: 'b_main' }, { branchId: 'b_closed' }]);
    mocks.drawerFindMany.mockResolvedValue([
      {
        id: 'drawer_1',
        branchId: 'b_main',
        businessDate: new Date('2026-11-15T00:00:00Z'),
        openedAt: new Date('2026-11-15T04:30:00Z'),
      },
    ]);
    mocks.branchFindMany.mockResolvedValue([
      { id: 'b_closed', name: 'Closed', active: false },
      { id: 'b_main', name: 'Main', active: true },
    ]);

    const home = await loadPharmacyStaffHome(db, 'org_1', cashier, ALL_MODULES);

    expect(home.links.map((link) => link.href)).toEqual(['/pharmacy/counter']);
    expect(home.branches).toEqual([{ id: 'b_main', name: 'Main' }]);
    expect(home.shifts).toEqual([
      {
        id: 'drawer_1',
        branchName: 'Main',
        businessDate: '2026-11-15',
        openedAt: '2026-11-15T04:30:00.000Z',
      },
    ]);
    expect(home.timeZone).toBe('Asia/Karachi');
    expect(mocks.assignmentFindMany).toHaveBeenCalledWith({
      where: { organizationId: 'org_1', userId: 'cashier_1', active: true },
      select: { branchId: true },
    });
    expect(mocks.drawerFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { organizationId: 'org_1', openedByActorId: 'cashier_1', status: 'OPEN' },
      })
    );
    expect(mocks.branchFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { organizationId: 'org_1', id: { in: ['b_main', 'b_closed'] } },
      })
    );
  });

  it('offers a pharmacist the queue but not the Counter or purchasing', async () => {
    grant('pharmacy:dispense', 'pharmacy:close');
    const home = await loadPharmacyStaffHome(db, 'org_1', cashier, ALL_MODULES);
    expect(home.links.map((link) => link.key)).toEqual(['dispense']);
  });

  it('offers no link the workspace package does not license, whatever the grant', async () => {
    grant('pharmacy:counter', 'pharmacy:dispense', 'pharmacy:procurement', 'pharmacy:inventory');
    // A pharmacist in a package without dispensing gets no queue link.
    const home = await loadPharmacyStaffHome(db, 'org_1', cashier, [
      'pharmacy-counter',
      'pharmacy-inventory',
    ]);
    expect(home.links.map((link) => link.key)).toEqual(['counter', 'inventory']);
    expect(mocks.can).not.toHaveBeenCalledWith(
      expect.anything(),
      'pharmacy:dispense',
      undefined,
      expect.anything()
    );
  });

  it('gives a report reader the Reports link instead of the command centre', async () => {
    grant('reports:operational');
    const home = await loadPharmacyStaffHome(db, 'org_1', cashier, ALL_MODULES);
    expect(home.links).toEqual([
      expect.objectContaining({ key: 'reports', href: '/pharmacy/reports' }),
    ]);
  });

  it('returns an empty home, not an error, for an unassigned member with no grants', async () => {
    grant();
    mocks.organizationFindUnique.mockResolvedValue(null);
    await expect(loadPharmacyStaffHome(db, 'org_1', cashier, ALL_MODULES)).resolves.toEqual({
      links: [],
      branches: [],
      shifts: [],
      timeZone: 'UTC',
    });
    expect(mocks.branchFindMany).not.toHaveBeenCalled();
  });
});
