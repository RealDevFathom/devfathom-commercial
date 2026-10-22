import { can, subjectFromSession } from '@/lib/abac';

import { protectedProcedure, router } from '../trpc';

const PHARMACY_RAIL_CAPABILITIES = [
  'pharmacy:counter',
  'pharmacy:procurement',
  'pharmacy:inventory',
  'pharmacy:orders',
  'pharmacy:dispense',
  'pharmacy:safety',
  'reports:operational',
  'reports:financial',
] as const;

/** Resolve the rail through the same ABAC decisions used by pharmacy procedures. */
export const pharmacyAccessRouter = router({
  navigation: protectedProcedure.query(async ({ ctx }) => {
    const subject = subjectFromSession(ctx.session.user);
    const decisions = await Promise.all(
      PHARMACY_RAIL_CAPABILITIES.map(async (capability) => ({
        capability,
        allowed: await can(subject, capability, undefined, {
          db: ctx.db,
          source: 'TRPC',
        }),
      }))
    );
    return decisions.flatMap(({ capability, allowed }) => (allowed ? [capability] : []));
  }),
});
