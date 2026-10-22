import { z } from 'zod';
import { TRPCError } from '@trpc/server';

import { assertInOrganization } from '../org-refs';
import { router, capabilityProcedure, type TRPCContext } from '../trpc';
import { annotateAudit } from '../audit';
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

async function assertActiveBranch(ctx: TRPCContext, branchId: string) {
  const organizationId = ctx.entitlements.organizationId ?? ctx.session?.user.organizationId;
  if (!organizationId) throw new TRPCError({ code: 'UNAUTHORIZED' });
  await assertInOrganization(ctx.db.restaurantBranch, organizationId, [branchId], { active: true });
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
