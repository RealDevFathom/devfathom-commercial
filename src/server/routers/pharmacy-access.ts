import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { can, subjectFromSession } from '@/lib/abac';
import type { Action } from '@/lib/abac/policies';
import { protectedProcedure, router } from '../trpc';
import { canAccessPharmacyCounter, pharmacyCloseBranchIds } from './pharmacy-sales';

/**
 * The capabilities the pharmacy rail asks about, each exactly as the page
 * behind the entry checks it:
 *
 * - `pharmacy:procurement` — purchasing consoles and Goods-in.
 * - `pharmacy:prescriptions` — the prescription workspace.
 * - `pharmacy:dispense` — the pharmacist queue and substitution evidence.
 * - `reports:operational` — the pharmacy reports command centre.
 * - `pharmacy:inventory` — inventory operations.
 * - `pharmacy:close` — day close at an admitted branch.
 * - `pharmacy:counter` — the counter's capability family and active branch scope.
 */
export const PHARMACY_NAVIGATION_CAPABILITIES = [
  'pharmacy:procurement',
  'pharmacy:prescriptions',
  'pharmacy:dispense',
  'reports:operational',
  'pharmacy:counter',
  'pharmacy:inventory',
  'pharmacy:close',
] as const satisfies readonly Action[];

export type PharmacyNavigationCapability = (typeof PHARMACY_NAVIGATION_CAPABILITIES)[number];

/**
 * #979 — one read for the pharmacy rail. Every answer goes through the same
 * ABAC engine the pages and procedures use, so the rail never offers an entry
 * its page would refuse (a cashier no longer sees prescriptions, the
 * pharmacist queue, substitution, reports or purchasing).
 */
export const pharmacyAccessRouter = router({
  navigation: protectedProcedure
    // Identity is a cache key, never an authority to choose the actor or tenant.
    .input(z.object({ userId: z.string(), organizationId: z.string() }).optional())
    .query(async ({ ctx, input }) => {
      const user = ctx.session.user;
      if (
        input &&
        (input.userId !== user.id || input.organizationId !== ctx.entitlements?.organizationId)
      ) {
        throw new TRPCError({ code: 'FORBIDDEN' });
      }
      const closeBranchIds = await pharmacyCloseBranchIds(ctx);
      const subject = subjectFromSession(user);
      const options = { db: ctx.db, source: 'TRPC' as const, ip: ctx.requestMeta.ip };
      const decisions = await Promise.all(
        PHARMACY_NAVIGATION_CAPABILITIES.map(async (capability) => {
          const allowed =
            capability === 'pharmacy:counter'
              ? await canAccessPharmacyCounter(ctx)
              : capability === 'pharmacy:close'
                ? closeBranchIds.length > 0
                : await can(subject, capability, undefined, options);
          return allowed ? capability : null;
        })
      );
      return {
        userId: user.id,
        closeBranchIds,
        organizationId: ctx.entitlements?.organizationId ?? null,
        capabilities: decisions.filter(
          (capability): capability is PharmacyNavigationCapability => capability !== null
        ),
      };
    }),
});
