import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { can, subjectFromSession } from '@/lib/abac';
import type { Action } from '@/lib/abac/policies';
import { protectedProcedure, router } from '../trpc';
import { canAccessPharmacyCounter, canClosePharmacyDay } from './pharmacy-sales';

/**
 * The capabilities the pharmacy rail asks about, each exactly as the page
 * behind the entry checks it:
 *
 * - `pharmacy:procurement` — purchasing consoles and Goods-in.
 * - `pharmacy:prescriptions` — the prescription workspace.
 * - `pharmacy:dispense` — the pharmacist queue and substitution evidence.
 * - `reports:operational` — the pharmacy reports command centre.
 * - `pharmacy:counter` — the counter's capability family and active branch scope.
 * - `pharmacy:close` — the day-close console, answered by the procedures' own
 *   close gate for some branch (an administrator, a member granted
 *   `pharmacy:close`, or a manager actively assigned to a branch).
 * - `pharmacy:inventory` / `pharmacy:manage` — inventory, for stock staff and
 *   managers (DEV-240); administrators keep it as before.
 * - `pharmacy:safety` — with `pharmacy:dispense`, opens the substitution workspace
 *   (DEV-35), so the counter only links there for a holder of either.
 */
export const PHARMACY_NAVIGATION_CAPABILITIES = [
  'pharmacy:procurement',
  'pharmacy:prescriptions',
  'pharmacy:dispense',
  'reports:operational',
  'pharmacy:counter',
  'pharmacy:close',
  'pharmacy:safety',
  'pharmacy:inventory',
  'pharmacy:manage',
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
    // DEV-240: the client keys its cache by member and tenant. The key is never
    // an authority over who is asked about: one naming anyone else is refused.
    .input(z.object({ userId: z.string(), organizationId: z.string() }).strict().optional())
    .query(async ({ ctx, input }) => {
      const user = ctx.session.user;
      if (
        input &&
        (input.userId !== user.id || input.organizationId !== ctx.entitlements?.organizationId)
      )
        throw new TRPCError({
          code: 'FORBIDDEN',
          message: 'Access is read for the signed-in member only.',
        });
      const subject = subjectFromSession(user);
      const options = { db: ctx.db, source: 'TRPC' as const, ip: ctx.requestMeta.ip };
      const decisions = await Promise.all(
        PHARMACY_NAVIGATION_CAPABILITIES.map(async (capability) => {
          const allowed =
            capability === 'pharmacy:counter'
              ? await canAccessPharmacyCounter(ctx)
              : capability === 'pharmacy:close'
                ? await canClosePharmacyDay(ctx)
                : await can(subject, capability, undefined, options);
          return allowed ? capability : null;
        })
      );
      return {
        userId: user.id,
        organizationId: ctx.entitlements?.organizationId ?? null,
        capabilities: decisions.filter(
          (capability): capability is PharmacyNavigationCapability => capability !== null
        ),
      };
    }),
});
