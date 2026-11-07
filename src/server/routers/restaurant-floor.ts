import { z } from 'zod';
import { TRPCError } from '@trpc/server';

import { router, capabilityProcedure, type TRPCContext } from '../trpc';
import { annotateAudit } from '../audit';
import { assertInOrganization } from '../org-refs';
import { requireRestaurantBranchScope } from '../restaurant-branch-scope';
import { resolveStaffCapabilities } from '@/lib/restaurant/job-roles';
import { businessDateToUtcDate } from '@/lib/restaurant/business-date';
import { can, subjectFromSession } from '@/lib/abac';
import {
  FloorError,
  createFloor,
  createTable,
  deleteFloor,
  deleteTable,
  listFloors,
  updateFloor,
  updateTable,
} from '@/lib/restaurant/floor';
import {
  SectionError,
  assignServer,
  createSection,
  deleteSection,
  listSections,
  setSectionTables,
  unassignServer,
  updateSection,
} from '@/lib/restaurant/sections';
import {
  StationError,
  createRoutingRule,
  createStation,
  deleteRoutingRule,
  deleteStation,
  listStations,
  setDefaultStation,
  updateRoutingRule,
  updateStation,
} from '@/lib/restaurant/stations';

/**
 * M4-L3 — POS/back-office server surface for floors, tables, server sections and
 * kitchen stations (config + occupancy).
 *
 * Reads are gated by `capabilityProcedure('orders:read')` — the floor plan is
 * consumed by any operator who can read orders (POS/KDS consoles, L5a/L5b) — and
 * mutations by `capabilityProcedure('floor:manage')`, a manager-level config
 * capability. Both flow through the ABAC engine (org-role driven; no static
 * policy — see `abac/policies.ts`), the licensed `restaurant-pos` module
 * (`module-catalog.ts`) and the audit middleware. Tenant scoping is the RLS-forced
 * `organizationId` default on every row (C1); no resolver forges an organization
 * id.
 *
 * These are back-office configuration commands, not terminal-submitted POS
 * commands, so they carry no device-scoped idempotency key (C7 applies to the
 * terminal order/kitchen commands in L2). Inputs are `.strict()` (house style,
 * directive 6): unknown fields are rejected, never stripped.
 *
 * **Read contract (C10):** `listFloors` (floors → tables + live occupancy),
 * `listSections` (sections → tables + assignments for a businessDate),
 * `listStations` (stations → routing rules). A console lane missing a read routes
 * the defect back through the Chief of Staff to this lane — it never adds its own
 * server query.
 */

const BUSINESS_DATE = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected a "YYYY-MM-DD" business date.');

/** Translate a floor/section/station domain error into the right tRPC status. */
function mapDomainError(err: unknown): never {
  if (err instanceof FloorError || err instanceof SectionError || err instanceof StationError) {
    const notFound = err.reason.endsWith('NOT_FOUND');
    const conflict =
      err.reason === 'DUPLICATE_CODE' ||
      err.reason === 'REFERENCED' ||
      err.reason === 'SECTION_REFERENCED' ||
      err.reason === 'STATION_REFERENCED' ||
      err.reason === 'DEFAULT_CONFLICT';
    const code = notFound ? 'NOT_FOUND' : conflict ? 'CONFLICT' : 'BAD_REQUEST';
    throw new TRPCError({ code, message: err.message });
  }
  throw err;
}

const readProcedure = capabilityProcedure('orders:read');
const manageProcedure = capabilityProcedure('floor:manage');

type FloorCapability = 'orders:read' | 'floor:manage';

/**
 * Floor branch boundary. In addition to the shared Restaurant scope (primary
 * branch, explicit branch assignment, or organization-wide `restaurant:configure`),
 * an ACTIVE linked staff profile holding a job role or direct capability grant at
 * the branch is in scope when its effective capabilities there (DENYs applied)
 * include the procedure's capability. This matches the branch picker, which lists
 * branches from the same job-role/direct-grant links. An explicit DENY of the
 * capability at the branch is enforced before the shared-scope fallback, so a
 * primary or assigned branch link never overrides it.
 */
async function assertActiveBranch(
  ctx: TRPCContext,
  branchId: string,
  capability: FloorCapability = 'floor:manage'
) {
  const user = ctx.session?.user;
  if (!user) throw new TRPCError({ code: 'UNAUTHORIZED' });
  const roleActor = await ctx.db.restaurantStaffProfile.findFirst({
    where: {
      userId: user.id,
      status: 'ACTIVE',
      OR: [
        { jobRoles: { some: { branchId } } },
        { directCapabilityGrants: { some: { branchId } } },
      ],
    },
    select: { id: true },
  });
  if (
    roleActor &&
    (await resolveStaffCapabilities(ctx.db, roleActor.id, branchId)).has(capability)
  ) {
    const organizationId = ctx.entitlements?.organizationId ?? user.organizationId;
    if (!organizationId) throw new TRPCError({ code: 'UNAUTHORIZED' });
    await assertInOrganization(ctx.db.restaurantBranch, organizationId, [branchId], {
      active: true,
    });
    return;
  }
  // An explicit per-person DENY at this branch is authoritative: it must not be
  // bypassed by the primary-branch / branch-assignment / organization-wide
  // fallback below, which only proves the branch link, not the capability.
  const explicitDeny = await ctx.db.restaurantStaffCapabilityGrant.findFirst({
    where: {
      branchId,
      capability,
      effect: 'DENY',
      staffProfile: { userId: user.id, status: 'ACTIVE' },
    },
    select: { id: true },
  });
  if (explicitDeny) {
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: 'You are not authorized for this restaurant branch.',
    });
  }
  await requireRestaurantBranchScope(ctx, branchId);
}

async function requireResourceBranch(
  ctx: TRPCContext,
  resource: 'floor' | 'table' | 'section' | 'station' | 'routingRule',
  id: string,
  capability: FloorCapability = 'floor:manage'
) {
  let branchId: string | undefined;
  if (resource === 'floor') {
    const row = await ctx.db.restaurantFloor.findUnique({
      where: { id },
      select: { branchId: true },
    });
    branchId = row?.branchId;
  } else if (resource === 'table') {
    const row = await ctx.db.restaurantTable.findUnique({
      where: { id },
      select: { floor: { select: { branchId: true } } },
    });
    branchId = row?.floor.branchId;
  } else if (resource === 'section') {
    const row = await ctx.db.restaurantServerSection.findUnique({
      where: { id },
      select: { branchId: true },
    });
    branchId = row?.branchId;
  } else if (resource === 'station') {
    const row = await ctx.db.restaurantKitchenStation.findUnique({
      where: { id },
      select: { branchId: true },
    });
    branchId = row?.branchId;
  } else {
    const row = await ctx.db.restaurantStationRoutingRule.findUnique({
      where: { id },
      select: { station: { select: { branchId: true } } },
    });
    branchId = row?.station.branchId;
  }
  if (!branchId) throw new TRPCError({ code: 'FORBIDDEN' });
  await assertActiveBranch(ctx, branchId, capability);
}

/**
 * Batch form of `requireResourceBranch(ctx, 'table', id)` for set-membership
 * inputs: one lookup for every table, then one branch check per DISTINCT branch
 * (normally one), instead of a guard round-trip per table. An id that does not
 * resolve (unknown or another tenant's, hidden by RLS) is FORBIDDEN, exactly as
 * the single-resource guard.
 */
async function requireTablesBranches(ctx: TRPCContext, tableIds: readonly string[]) {
  const uniqueIds = [...new Set(tableIds)];
  if (uniqueIds.length === 0) return;
  const rows = await ctx.db.restaurantTable.findMany({
    where: { id: { in: uniqueIds } },
    select: { id: true, floor: { select: { branchId: true } } },
  });
  if (rows.length !== uniqueIds.length) throw new TRPCError({ code: 'FORBIDDEN' });
  for (const branchId of new Set(rows.map((row) => row.floor.branchId))) {
    await assertActiveBranch(ctx, branchId);
  }
}

export const restaurantFloorRouter = router({
  access: readProcedure.query(async ({ ctx }) => ({
    canManage: await can(subjectFromSession(ctx.session!.user), 'floor:manage', undefined, {
      db: ctx.db,
    }),
  })),

  // ── Floors & tables ────────────────────────────────────────────────────────
  listFloors: readProcedure
    .input(z.object({ branchId: z.string(), includeInactive: z.boolean().optional() }).strict())
    .query(async ({ ctx, input }) => {
      await assertActiveBranch(ctx, input.branchId, 'orders:read');
      return listFloors(ctx.db, input);
    }),

  createFloor: manageProcedure
    .input(
      z
        .object({
          branchId: z.string(),
          name: z.string().min(1).max(120),
          sortOrder: z.number().int().optional(),
        })
        .strict()
    )
    .mutation(async ({ ctx, input }) => {
      try {
        await assertActiveBranch(ctx, input.branchId);
        const floor = await createFloor(ctx.db, input);
        annotateAudit(ctx, {
          targetType: 'RestaurantFloor',
          targetId: floor.id,
          targetLabel: floor.name,
          description: `Created restaurant floor "${floor.name}"`,
          metadata: { branchId: floor.branchId },
        });
        return floor;
      } catch (err) {
        mapDomainError(err);
      }
    }),

  updateFloor: manageProcedure
    .input(
      z
        .object({
          id: z.string(),
          name: z.string().min(1).max(120).optional(),
          sortOrder: z.number().int().optional(),
          active: z.boolean().optional(),
        })
        .strict()
    )
    .mutation(async ({ ctx, input }) => {
      const { id, ...patch } = input;
      try {
        await requireResourceBranch(ctx, 'floor', id);
        const floor = await updateFloor(ctx.db, id, patch);
        annotateAudit(ctx, {
          targetType: 'RestaurantFloor',
          targetId: floor.id,
          targetLabel: floor.name,
          description: `Updated restaurant floor "${floor.name}"`,
        });
        return floor;
      } catch (err) {
        mapDomainError(err);
      }
    }),

  deleteFloor: manageProcedure
    .input(z.object({ id: z.string() }).strict())
    .mutation(async ({ ctx, input }) => {
      try {
        await requireResourceBranch(ctx, 'floor', input.id);
        const floor = await deleteFloor(ctx.db, input.id);
        annotateAudit(ctx, {
          targetType: 'RestaurantFloor',
          targetId: floor.id,
          targetLabel: floor.name,
          description: `Deleted restaurant floor "${floor.name}"`,
        });
        return floor;
      } catch (err) {
        mapDomainError(err);
      }
    }),

  createTable: manageProcedure
    .input(
      z
        .object({
          floorId: z.string(),
          code: z.string().min(1).max(40),
          capacity: z.number().int().min(1).max(100),
        })
        .strict()
    )
    .mutation(async ({ ctx, input }) => {
      try {
        await requireResourceBranch(ctx, 'floor', input.floorId);
        const table = await createTable(ctx.db, input);
        annotateAudit(ctx, {
          targetType: 'RestaurantTable',
          targetId: table.id,
          targetLabel: table.code,
          description: `Created table "${table.code}"`,
          metadata: { floorId: table.floorId, capacity: table.capacity },
        });
        return table;
      } catch (err) {
        mapDomainError(err);
      }
    }),

  updateTable: manageProcedure
    .input(
      z
        .object({
          id: z.string(),
          code: z.string().min(1).max(40).optional(),
          capacity: z.number().int().min(1).max(100).optional(),
          active: z.boolean().optional(),
        })
        .strict()
    )
    .mutation(async ({ ctx, input }) => {
      const { id, ...patch } = input;
      try {
        await requireResourceBranch(ctx, 'table', id);
        const table = await updateTable(ctx.db, id, patch);
        annotateAudit(ctx, {
          targetType: 'RestaurantTable',
          targetId: table.id,
          targetLabel: table.code,
          description: `Updated table "${table.code}"`,
        });
        return table;
      } catch (err) {
        mapDomainError(err);
      }
    }),

  deleteTable: manageProcedure
    .input(z.object({ id: z.string() }).strict())
    .mutation(async ({ ctx, input }) => {
      try {
        await requireResourceBranch(ctx, 'table', input.id);
        const table = await deleteTable(ctx.db, input.id);
        annotateAudit(ctx, {
          targetType: 'RestaurantTable',
          targetId: table.id,
          targetLabel: table.code,
          description: `Deleted table "${table.code}"`,
        });
        return table;
      } catch (err) {
        mapDomainError(err);
      }
    }),

  // ── Server sections ────────────────────────────────────────────────────────
  listSections: readProcedure
    .input(
      z
        .object({
          branchId: z.string(),
          businessDate: BUSINESS_DATE,
          includeInactive: z.boolean().optional(),
        })
        .strict()
    )
    .query(async ({ ctx, input }) => {
      await assertActiveBranch(ctx, input.branchId, 'orders:read');
      return listSections(ctx.db, {
        branchId: input.branchId,
        businessDate: businessDateToUtcDate(input.businessDate),
        includeInactive: input.includeInactive,
      });
    }),

  createSection: manageProcedure
    .input(z.object({ branchId: z.string(), name: z.string().min(1).max(120) }).strict())
    .mutation(async ({ ctx, input }) => {
      try {
        await assertActiveBranch(ctx, input.branchId);
        const section = await createSection(ctx.db, input);
        annotateAudit(ctx, {
          targetType: 'RestaurantServerSection',
          targetId: section.id,
          targetLabel: section.name,
          description: `Created server section "${section.name}"`,
          metadata: { branchId: section.branchId },
        });
        return section;
      } catch (err) {
        mapDomainError(err);
      }
    }),

  updateSection: manageProcedure
    .input(
      z
        .object({
          id: z.string(),
          name: z.string().min(1).max(120).optional(),
          active: z.boolean().optional(),
        })
        .strict()
    )
    .mutation(async ({ ctx, input }) => {
      const { id, ...patch } = input;
      try {
        await requireResourceBranch(ctx, 'section', id);
        const section = await updateSection(ctx.db, id, patch);
        annotateAudit(ctx, {
          targetType: 'RestaurantServerSection',
          targetId: section.id,
          targetLabel: section.name,
          description: `Updated server section "${section.name}"`,
        });
        return section;
      } catch (err) {
        mapDomainError(err);
      }
    }),

  deleteSection: manageProcedure
    .input(z.object({ id: z.string() }).strict())
    .mutation(async ({ ctx, input }) => {
      try {
        await requireResourceBranch(ctx, 'section', input.id);
        const section = await deleteSection(ctx.db, input.id);
        annotateAudit(ctx, {
          targetType: 'RestaurantServerSection',
          targetId: section.id,
          targetLabel: section.name,
          description: `Deleted server section "${section.name}"`,
        });
        return section;
      } catch (err) {
        mapDomainError(err);
      }
    }),

  setSectionTables: manageProcedure
    .input(z.object({ sectionId: z.string(), tableIds: z.array(z.string()).max(500) }).strict())
    .mutation(async ({ ctx, input }) => {
      try {
        await requireResourceBranch(ctx, 'section', input.sectionId);
        await requireTablesBranches(ctx, input.tableIds);
        const membership = await setSectionTables(ctx.db, input.sectionId, input.tableIds);
        annotateAudit(ctx, {
          targetType: 'RestaurantServerSection',
          targetId: input.sectionId,
          description: `Set ${membership.length} table(s) on server section`,
          metadata: { sectionId: input.sectionId, tableCount: membership.length },
        });
        return membership;
      } catch (err) {
        mapDomainError(err);
      }
    }),

  assignServer: manageProcedure
    .input(
      z
        .object({
          sectionId: z.string(),
          staffProfileId: z.string(),
          businessDate: BUSINESS_DATE,
        })
        .strict()
    )
    .mutation(async ({ ctx, input }) => {
      try {
        await requireResourceBranch(ctx, 'section', input.sectionId);
        const assignment = await assignServer(ctx.db, {
          sectionId: input.sectionId,
          staffProfileId: input.staffProfileId,
          businessDate: businessDateToUtcDate(input.businessDate),
        });
        annotateAudit(ctx, {
          targetType: 'RestaurantServerSectionAssignment',
          targetId: assignment.id,
          description: `Assigned server to section for ${input.businessDate}`,
          metadata: {
            sectionId: input.sectionId,
            staffProfileId: input.staffProfileId,
            businessDate: input.businessDate,
          },
        });
        return assignment;
      } catch (err) {
        mapDomainError(err);
      }
    }),

  unassignServer: manageProcedure
    .input(
      z
        .object({
          sectionId: z.string(),
          staffProfileId: z.string(),
          businessDate: BUSINESS_DATE,
        })
        .strict()
    )
    .mutation(async ({ ctx, input }) => {
      await requireResourceBranch(ctx, 'section', input.sectionId);
      const result = await unassignServer(ctx.db, {
        sectionId: input.sectionId,
        staffProfileId: input.staffProfileId,
        businessDate: businessDateToUtcDate(input.businessDate),
      });
      annotateAudit(ctx, {
        targetType: 'RestaurantServerSectionAssignment',
        targetId: input.sectionId,
        description: `Unassigned server from section for ${input.businessDate}`,
        metadata: {
          sectionId: input.sectionId,
          staffProfileId: input.staffProfileId,
          businessDate: input.businessDate,
          removed: result.count,
        },
      });
      return result;
    }),

  // ── Kitchen stations ───────────────────────────────────────────────────────
  listStations: readProcedure
    .input(z.object({ branchId: z.string(), includeInactive: z.boolean().optional() }).strict())
    .query(async ({ ctx, input }) => {
      await assertActiveBranch(ctx, input.branchId, 'orders:read');
      return listStations(ctx.db, input);
    }),

  createStation: manageProcedure
    .input(
      z
        .object({
          branchId: z.string(),
          name: z.string().min(1).max(120),
          isDefault: z.boolean().optional(),
        })
        .strict()
    )
    .mutation(async ({ ctx, input }) => {
      try {
        await assertActiveBranch(ctx, input.branchId);
        const station = await createStation(ctx.db, input);
        annotateAudit(ctx, {
          targetType: 'RestaurantKitchenStation',
          targetId: station.id,
          targetLabel: station.name,
          description: `Created kitchen station "${station.name}"`,
          metadata: { branchId: station.branchId, isDefault: station.isDefault },
        });
        return station;
      } catch (err) {
        mapDomainError(err);
      }
    }),

  updateStation: manageProcedure
    .input(
      z
        .object({
          id: z.string(),
          name: z.string().min(1).max(120).optional(),
          active: z.boolean().optional(),
        })
        .strict()
    )
    .mutation(async ({ ctx, input }) => {
      const { id, ...patch } = input;
      try {
        await requireResourceBranch(ctx, 'station', id);
        const station = await updateStation(ctx.db, id, patch);
        annotateAudit(ctx, {
          targetType: 'RestaurantKitchenStation',
          targetId: station.id,
          targetLabel: station.name,
          description: `Updated kitchen station "${station.name}"`,
        });
        return station;
      } catch (err) {
        mapDomainError(err);
      }
    }),

  setDefaultStation: manageProcedure
    .input(z.object({ id: z.string() }).strict())
    .mutation(async ({ ctx, input }) => {
      try {
        await requireResourceBranch(ctx, 'station', input.id);
        const station = await setDefaultStation(ctx.db, input.id);
        annotateAudit(ctx, {
          targetType: 'RestaurantKitchenStation',
          targetId: station.id,
          targetLabel: station.name,
          description: `Set kitchen station "${station.name}" as branch default`,
          metadata: { branchId: station.branchId },
        });
        return station;
      } catch (err) {
        mapDomainError(err);
      }
    }),

  deleteStation: manageProcedure
    .input(z.object({ id: z.string() }).strict())
    .mutation(async ({ ctx, input }) => {
      try {
        await requireResourceBranch(ctx, 'station', input.id);
        const station = await deleteStation(ctx.db, input.id);
        annotateAudit(ctx, {
          targetType: 'RestaurantKitchenStation',
          targetId: station.id,
          targetLabel: station.name,
          description: `Deleted kitchen station "${station.name}"`,
        });
        return station;
      } catch (err) {
        mapDomainError(err);
      }
    }),

  createRoutingRule: manageProcedure
    .input(
      z
        .object({
          stationId: z.string(),
          productId: z.string().nullable().optional(),
          categoryId: z.string().nullable().optional(),
          course: z.number().int().min(1).nullable().optional(),
          priority: z.number().int().optional(),
        })
        .strict()
    )
    .mutation(async ({ ctx, input }) => {
      try {
        await requireResourceBranch(ctx, 'station', input.stationId);
        const rule = await createRoutingRule(ctx.db, input);
        annotateAudit(ctx, {
          targetType: 'RestaurantStationRoutingRule',
          targetId: rule.id,
          description: 'Created station routing rule',
          metadata: {
            stationId: rule.stationId,
            productId: rule.productId,
            categoryId: rule.categoryId,
            course: rule.course,
            priority: rule.priority,
          },
        });
        return rule;
      } catch (err) {
        mapDomainError(err);
      }
    }),

  updateRoutingRule: manageProcedure
    .input(z.object({ id: z.string(), priority: z.number().int() }).strict())
    .mutation(async ({ ctx, input }) => {
      try {
        await requireResourceBranch(ctx, 'routingRule', input.id);
        const rule = await updateRoutingRule(ctx.db, input.id, { priority: input.priority });
        annotateAudit(ctx, {
          targetType: 'RestaurantStationRoutingRule',
          targetId: rule.id,
          description: 'Updated station routing rule priority',
          metadata: { priority: rule.priority },
        });
        return rule;
      } catch (err) {
        mapDomainError(err);
      }
    }),

  deleteRoutingRule: manageProcedure
    .input(z.object({ id: z.string() }).strict())
    .mutation(async ({ ctx, input }) => {
      try {
        await requireResourceBranch(ctx, 'routingRule', input.id);
        const rule = await deleteRoutingRule(ctx.db, input.id);
        annotateAudit(ctx, {
          targetType: 'RestaurantStationRoutingRule',
          targetId: rule.id,
          description: 'Deleted station routing rule',
          metadata: { stationId: rule.stationId },
        });
        return rule;
      } catch (err) {
        mapDomainError(err);
      }
    }),
});
