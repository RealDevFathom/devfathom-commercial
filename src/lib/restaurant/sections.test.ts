import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  SectionError,
  assignServer,
  createSection,
  deleteSection,
  listSections,
  setSectionTables,
  unassignServer,
  updateSection,
} from './sections';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';

/**
 * M4-L3 sections lib — branch-scoped section CRUD, table-membership re-seeding
 * (deduped, same-branch only), per-business-date server assignment gating (staff
 * ACTIVE + branch-pinned), and the assignments-by-date read model. In-memory
 * `ScopedDb` fake; RLS is exercised by `tests/restaurant-m4-rls.test.ts`.
 */

const mocks = vi.hoisted(() => ({
  branchFindUnique: vi.fn(),
  sectionFindUnique: vi.fn(),
  sectionCreate: vi.fn(),
  sectionUpdate: vi.fn(),
  sectionDelete: vi.fn(),
  sectionFindMany: vi.fn(),
  tableFindUnique: vi.fn(),
  staffFindUnique: vi.fn(),
  orderCount: vi.fn(),
  membershipDeleteMany: vi.fn(),
  membershipCreateMany: vi.fn(),
  membershipFindMany: vi.fn(),
  assignmentUpsert: vi.fn(),
  assignmentDeleteMany: vi.fn(),
  transaction: vi.fn(),
}));

const db = {
  restaurantBranch: { findUnique: mocks.branchFindUnique },
  restaurantServerSection: {
    findUnique: mocks.sectionFindUnique,
    create: mocks.sectionCreate,
    update: mocks.sectionUpdate,
    delete: mocks.sectionDelete,
    findMany: mocks.sectionFindMany,
  },
  restaurantTable: { findUnique: mocks.tableFindUnique },
  restaurantStaffProfile: { findUnique: mocks.staffFindUnique },
  restaurantOrder: { count: mocks.orderCount },
  restaurantServerSectionTable: {
    deleteMany: mocks.membershipDeleteMany,
    createMany: mocks.membershipCreateMany,
    findMany: mocks.membershipFindMany,
  },
  restaurantServerSectionAssignment: {
    upsert: mocks.assignmentUpsert,
    deleteMany: mocks.assignmentDeleteMany,
  },
  $transaction: mocks.transaction,
} as unknown as ScopedDb;

const DATE = new Date(Date.UTC(2026, 7, 19));

beforeEach(() => {
  vi.clearAllMocks();
  mocks.branchFindUnique.mockResolvedValue({ id: 'branch_1' });
  mocks.sectionFindUnique.mockResolvedValue({ id: 'section_1', branchId: 'branch_1' });
  mocks.sectionCreate.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
    id: 'section_new',
    ...data,
  }));
  mocks.sectionUpdate.mockImplementation(
    async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => ({
      id: where.id,
      name: 'Existing',
      ...data,
    })
  );
  mocks.sectionDelete.mockImplementation(async ({ where }: { where: { id: string } }) => ({
    id: where.id,
    name: 'Deleted',
  }));
  mocks.tableFindUnique.mockResolvedValue({ id: 'table_1', floor: { branchId: 'branch_1' } });
  mocks.staffFindUnique.mockResolvedValue({
    id: 'staff_1',
    status: 'ACTIVE',
    primaryBranchId: 'branch_1',
  });
  mocks.orderCount.mockResolvedValue(0);
  mocks.membershipDeleteMany.mockResolvedValue({ count: 0 });
  mocks.membershipCreateMany.mockResolvedValue({ count: 0 });
  mocks.membershipFindMany.mockResolvedValue([]);
  mocks.assignmentUpsert.mockImplementation(
    async ({ create }: { create: Record<string, unknown> }) => ({
      id: 'assignment_new',
      ...create,
    })
  );
  mocks.assignmentDeleteMany.mockResolvedValue({ count: 1 });
  // The interactive transaction re-enters with the same fake db.
  mocks.transaction.mockImplementation(async (cb: (tx: ScopedDb) => Promise<unknown>) => cb(db));
});

describe('createSection / updateSection', () => {
  it('creates a section with a trimmed name after validating the branch', async () => {
    await createSection(db, { branchId: 'branch_1', name: '  Bar  ' });
    expect(mocks.sectionCreate).toHaveBeenCalledWith({
      data: { branchId: 'branch_1', name: 'Bar' },
    });
  });

  it('rejects an out-of-tenant branch', async () => {
    mocks.branchFindUnique.mockResolvedValue(null);
    await expect(createSection(db, { branchId: 'x', name: 'Bar' })).rejects.toMatchObject({
      reason: 'BRANCH_NOT_FOUND',
    });
  });

  it('maps a missing section on update to SECTION_NOT_FOUND', async () => {
    mocks.sectionFindUnique.mockResolvedValue(null);
    await expect(updateSection(db, 'gone', { name: 'x' })).rejects.toMatchObject({
      reason: 'SECTION_NOT_FOUND',
    });
  });
});

describe('deleteSection', () => {
  it('refuses to delete a section referenced by orders', async () => {
    mocks.orderCount.mockResolvedValue(3);
    await expect(deleteSection(db, 'section_1')).rejects.toMatchObject({
      reason: 'SECTION_REFERENCED',
    });
    expect(mocks.sectionDelete).not.toHaveBeenCalled();
  });

  it('deletes an unreferenced section', async () => {
    await deleteSection(db, 'section_1');
    expect(mocks.sectionDelete).toHaveBeenCalledWith({ where: { id: 'section_1' } });
  });
});

describe('setSectionTables', () => {
  it('dedupes the table ids and re-seeds membership in a transaction', async () => {
    await setSectionTables(db, 'section_1', ['t1', 't2', 't1']);
    expect(mocks.membershipDeleteMany).toHaveBeenCalledWith({ where: { sectionId: 'section_1' } });
    expect(mocks.membershipCreateMany).toHaveBeenCalledWith({
      data: [
        { sectionId: 'section_1', tableId: 't1' },
        { sectionId: 'section_1', tableId: 't2' },
      ],
    });
  });

  it('clears membership when given an empty set (no createMany)', async () => {
    await setSectionTables(db, 'section_1', []);
    expect(mocks.membershipDeleteMany).toHaveBeenCalled();
    expect(mocks.membershipCreateMany).not.toHaveBeenCalled();
  });

  it('rejects a table from a different branch', async () => {
    mocks.tableFindUnique.mockResolvedValue({ id: 't1', floor: { branchId: 'branch_other' } });
    await expect(setSectionTables(db, 'section_1', ['t1'])).rejects.toMatchObject({
      reason: 'TABLE_WRONG_BRANCH',
    });
    expect(mocks.membershipDeleteMany).not.toHaveBeenCalled();
  });

  it('rejects an out-of-tenant table', async () => {
    mocks.tableFindUnique.mockResolvedValue(null);
    await expect(setSectionTables(db, 'section_1', ['gone'])).rejects.toMatchObject({
      reason: 'TABLE_NOT_FOUND',
    });
  });
});

describe('assignServer (ACTIVE + branch-pinned)', () => {
  it('upserts idempotently on (section, staff, businessDate)', async () => {
    await assignServer(db, {
      sectionId: 'section_1',
      staffProfileId: 'staff_1',
      businessDate: DATE,
    });
    expect(mocks.assignmentUpsert).toHaveBeenCalledWith({
      where: {
        sectionId_staffProfileId_businessDate: {
          sectionId: 'section_1',
          staffProfileId: 'staff_1',
          businessDate: DATE,
        },
      },
      create: { sectionId: 'section_1', staffProfileId: 'staff_1', businessDate: DATE },
      update: {},
    });
  });

  it('rejects an inactive staff profile', async () => {
    mocks.staffFindUnique.mockResolvedValue({
      id: 'staff_1',
      status: 'SUSPENDED',
      primaryBranchId: 'branch_1',
    });
    await expect(
      assignServer(db, { sectionId: 'section_1', staffProfileId: 'staff_1', businessDate: DATE })
    ).rejects.toMatchObject({ reason: 'STAFF_INACTIVE' });
    expect(mocks.assignmentUpsert).not.toHaveBeenCalled();
  });

  it('rejects a staff profile pinned to another branch', async () => {
    mocks.staffFindUnique.mockResolvedValue({
      id: 'staff_1',
      status: 'ACTIVE',
      primaryBranchId: 'branch_other',
    });
    await expect(
      assignServer(db, { sectionId: 'section_1', staffProfileId: 'staff_1', businessDate: DATE })
    ).rejects.toMatchObject({ reason: 'STAFF_WRONG_BRANCH' });
  });

  it('rejects an out-of-tenant staff profile', async () => {
    mocks.staffFindUnique.mockResolvedValue(null);
    await expect(
      assignServer(db, { sectionId: 'section_1', staffProfileId: 'gone', businessDate: DATE })
    ).rejects.toMatchObject({ reason: 'STAFF_NOT_FOUND' });
  });
});

describe('unassignServer', () => {
  it('deletes the matching assignment row(s) and is a no-op when none match', async () => {
    mocks.assignmentDeleteMany.mockResolvedValue({ count: 0 });
    const result = await unassignServer(db, {
      sectionId: 'section_1',
      staffProfileId: 'staff_1',
      businessDate: DATE,
    });
    expect(result).toEqual({ count: 0 });
    expect(mocks.assignmentDeleteMany).toHaveBeenCalledWith({
      where: { sectionId: 'section_1', staffProfileId: 'staff_1', businessDate: DATE },
    });
  });
});

describe('listSections (assignments-by-date read model)', () => {
  it('filters assignments to the business date and dedupes membership tables', async () => {
    mocks.sectionFindMany.mockResolvedValue([
      {
        id: 'section_1',
        branchId: 'branch_1',
        name: 'Bar',
        active: true,
        tableLinks: [
          { table: { id: 't1', code: 'A1', floorId: 'f1' } },
          { table: { id: 't1', code: 'A1', floorId: 'f1' } }, // duplicate membership row
        ],
        assignments: [
          {
            id: 'a1',
            staffProfileId: 'staff_1',
            businessDate: DATE,
            staffProfile: { displayName: 'Dana', status: 'ACTIVE' },
          },
        ],
      },
    ]);

    const sections = await listSections(db, { branchId: 'branch_1', businessDate: DATE });

    expect(mocks.sectionFindMany.mock.calls[0][0].where).toEqual({
      branchId: 'branch_1',
      active: true,
    });
    expect(sections[0].tables).toEqual([{ id: 't1', code: 'A1', floorId: 'f1' }]);
    expect(sections[0].assignments).toEqual([
      {
        id: 'a1',
        staffProfileId: 'staff_1',
        staffDisplayName: 'Dana',
        staffStatus: 'ACTIVE',
        businessDate: DATE,
      },
    ]);
  });
});

describe('SectionError', () => {
  it('carries its reason', () => {
    expect(new SectionError('nope', 'INVALID').reason).toBe('INVALID');
  });
});
