import 'server-only';

import type { Prisma } from '@/generated/prisma/client';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';

/**
 * M4-L3 / §4 — restaurant server sections: a grouping of tables assigned to a
 * server, with per-business-date staffing.
 *
 * Membership (`RestaurantServerSectionTable`) is a plain join with no
 * `(sectionId, tableId)` unique — this command layer dedups and re-seeds it
 * atomically (`setSectionTables`), so a re-save never accumulates duplicate rows.
 * A table may only join a section in the SAME branch as the section (a section
 * groups its own branch's tables). Staffing (`RestaurantServerSectionAssignment`)
 * is keyed `(section, staff, businessDate)`; a server may be assigned only when
 * the staff profile is ACTIVE and pinned to the section's branch (§11.6 — shift
 * granularity is deferred, BUILD-ASSUMPTIONS).
 *
 * Every function takes a tenant-scoped `ScopedDb`; `organizationId` is the RLS
 * default on every row and cross-tenant references are invisible (null) and
 * rejected here before the composite tenant foreign keys would reject them (C1).
 */

export type SectionErrorReason =
  | 'INVALID'
  | 'BRANCH_NOT_FOUND'
  | 'SECTION_NOT_FOUND'
  | 'SECTION_REFERENCED'
  | 'TABLE_NOT_FOUND'
  | 'TABLE_WRONG_BRANCH'
  | 'STAFF_NOT_FOUND'
  | 'STAFF_INACTIVE'
  | 'STAFF_WRONG_BRANCH';

export class SectionError extends Error {
  constructor(
    message: string,
    readonly reason: SectionErrorReason
  ) {
    super(message);
    this.name = 'SectionError';
  }
}

function requireName(value: string, label: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new SectionError(`A ${label} is required.`, 'INVALID');
  }
  return trimmed;
}

async function assertBranchInScope(db: ScopedDb, branchId: string): Promise<void> {
  const branch = await db.restaurantBranch.findUnique({
    where: { id: branchId },
    select: { id: true },
  });
  if (!branch) {
    throw new SectionError('The branch does not exist.', 'BRANCH_NOT_FOUND');
  }
}

/** Load a section in scope (or throw), returning its branch id for downstream checks. */
async function requireSection(db: ScopedDb, id: string): Promise<{ id: string; branchId: string }> {
  const section = await db.restaurantServerSection.findUnique({
    where: { id },
    select: { id: true, branchId: true },
  });
  if (!section) {
    throw new SectionError('Section not found.', 'SECTION_NOT_FOUND');
  }
  return section;
}

// ── Sections ─────────────────────────────────────────────────────────────────

export type CreateSectionInput = {
  branchId: string;
  name: string;
};

export async function createSection(db: ScopedDb, input: CreateSectionInput) {
  const name = requireName(input.name, 'section name');
  await assertBranchInScope(db, input.branchId);
  return db.restaurantServerSection.create({ data: { branchId: input.branchId, name } });
}

export type UpdateSectionInput = {
  name?: string;
  active?: boolean;
};

export async function updateSection(db: ScopedDb, id: string, patch: UpdateSectionInput) {
  await requireSection(db, id);
  const data: Prisma.RestaurantServerSectionUncheckedUpdateInput = {};
  if (patch.name !== undefined) data.name = requireName(patch.name, 'section name');
  if (patch.active !== undefined) data.active = patch.active;
  return db.restaurantServerSection.update({ where: { id }, data });
}

/**
 * Hard-delete a section. Refused once any order references it (the order→section
 * link is `SetNull`, so a delete would silently drop that attribution);
 * deactivate the section instead. Memberships and assignments cascade away.
 */
export async function deleteSection(db: ScopedDb, id: string) {
  await requireSection(db, id);
  const referencingOrders = await db.restaurantOrder.count({ where: { sectionId: id } });
  if (referencingOrders > 0) {
    throw new SectionError(
      'This section is referenced by orders; deactivate it instead of deleting.',
      'SECTION_REFERENCED'
    );
  }
  return db.restaurantServerSection.delete({ where: { id } });
}

// ── Table membership ─────────────────────────────────────────────────────────

/**
 * Replace a section's table membership with `tableIds` (deduplicated). Each table
 * must exist in scope and belong to the SAME branch as the section. The swap runs
 * in one transaction so the membership never observes a partial state.
 */
export async function setSectionTables(db: ScopedDb, sectionId: string, tableIds: string[]) {
  const section = await requireSection(db, sectionId);
  const uniqueTableIds = [...new Set(tableIds)];

  for (const tableId of uniqueTableIds) {
    const table = await db.restaurantTable.findUnique({
      where: { id: tableId },
      select: { id: true, floor: { select: { branchId: true } } },
    });
    if (!table) {
      throw new SectionError(`Table ${tableId} does not exist.`, 'TABLE_NOT_FOUND');
    }
    if (table.floor.branchId !== section.branchId) {
      throw new SectionError(
        `Table ${tableId} belongs to a different branch than this section.`,
        'TABLE_WRONG_BRANCH'
      );
    }
  }

  return db.$transaction(async (tx) => {
    await tx.restaurantServerSectionTable.deleteMany({ where: { sectionId } });
    if (uniqueTableIds.length > 0) {
      await tx.restaurantServerSectionTable.createMany({
        data: uniqueTableIds.map((tableId) => ({ sectionId, tableId })),
      });
    }
    return tx.restaurantServerSectionTable.findMany({
      where: { sectionId },
      select: { id: true, sectionId: true, tableId: true },
      orderBy: { tableId: 'asc' },
    });
  });
}

// ── Per-business-date server assignments ─────────────────────────────────────

export type AssignServerInput = {
  sectionId: string;
  staffProfileId: string;
  /** The business date being staffed (a UTC-midnight Date for the `@db.Date` column). */
  businessDate: Date;
};

/**
 * Assign a server to a section for a business date. Idempotent on the
 * `(section, staff, businessDate)` unique — a repeat assignment returns the
 * existing row. The staff profile must be ACTIVE and pinned to the section's
 * branch.
 */
export async function assignServer(db: ScopedDb, input: AssignServerInput) {
  const section = await requireSection(db, input.sectionId);
  const staff = await db.restaurantStaffProfile.findUnique({
    where: { id: input.staffProfileId },
    select: { id: true, status: true, primaryBranchId: true },
  });
  if (!staff) {
    throw new SectionError('Staff profile not found.', 'STAFF_NOT_FOUND');
  }
  if (staff.status !== 'ACTIVE') {
    throw new SectionError('The staff profile is not active.', 'STAFF_INACTIVE');
  }
  if (staff.primaryBranchId !== section.branchId) {
    throw new SectionError(
      'The staff profile is not assigned to the branch of this section.',
      'STAFF_WRONG_BRANCH'
    );
  }

  return db.restaurantServerSectionAssignment.upsert({
    where: {
      sectionId_staffProfileId_businessDate: {
        sectionId: input.sectionId,
        staffProfileId: input.staffProfileId,
        businessDate: input.businessDate,
      },
    },
    create: {
      sectionId: input.sectionId,
      staffProfileId: input.staffProfileId,
      businessDate: input.businessDate,
    },
    update: {},
  });
}

export type UnassignServerInput = AssignServerInput;

/**
 * Remove a server assignment for a business date. Idempotent — removing an
 * assignment that does not exist is a no-op that returns `{ count: 0 }`.
 */
export async function unassignServer(db: ScopedDb, input: UnassignServerInput) {
  return db.restaurantServerSectionAssignment.deleteMany({
    where: {
      sectionId: input.sectionId,
      staffProfileId: input.staffProfileId,
      businessDate: input.businessDate,
    },
  });
}

// ── Read model (C10 read contract, consumed by L5a) ──────────────────────────

export type SectionAssignmentView = {
  id: string;
  staffProfileId: string;
  staffDisplayName: string;
  staffStatus: string;
  businessDate: Date;
};

export type SectionView = {
  id: string;
  branchId: string;
  name: string;
  active: boolean;
  tables: Array<{ id: string; code: string; floorId: string }>;
  assignments: SectionAssignmentView[];
};

export type ListSectionsInput = {
  branchId: string;
  /** Assignments are filtered to this business date (UTC-midnight Date). */
  businessDate: Date;
  includeInactive?: boolean;
};

/**
 * The `listSections` read contract: a branch's sections, each with its member
 * tables and the server assignments for the requested business date.
 */
export async function listSections(db: ScopedDb, input: ListSectionsInput): Promise<SectionView[]> {
  const sections = await db.restaurantServerSection.findMany({
    where: { branchId: input.branchId, ...(input.includeInactive ? {} : { active: true }) },
    orderBy: { name: 'asc' },
    select: {
      id: true,
      branchId: true,
      name: true,
      active: true,
      tableLinks: {
        select: { table: { select: { id: true, code: true, floorId: true } } },
      },
      assignments: {
        where: { businessDate: input.businessDate },
        select: {
          id: true,
          staffProfileId: true,
          businessDate: true,
          staffProfile: { select: { displayName: true, status: true } },
        },
        orderBy: { staffProfileId: 'asc' },
      },
    },
  });

  return sections.map((section) => {
    // Membership has no DB uniqueness; dedupe defensively by table id.
    const tables = new Map<string, { id: string; code: string; floorId: string }>();
    for (const link of section.tableLinks) tables.set(link.table.id, link.table);
    return {
      id: section.id,
      branchId: section.branchId,
      name: section.name,
      active: section.active,
      tables: [...tables.values()].sort((a, b) => a.code.localeCompare(b.code)),
      assignments: section.assignments.map((assignment) => ({
        id: assignment.id,
        staffProfileId: assignment.staffProfileId,
        staffDisplayName: assignment.staffProfile.displayName,
        staffStatus: assignment.staffProfile.status,
        businessDate: assignment.businessDate,
      })),
    };
  });
}
