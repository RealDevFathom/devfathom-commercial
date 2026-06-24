import { z } from 'zod';
import { router, protectedProcedure } from '../trpc';

/**
 * Confidentiality & Non-Replication Agreement that every user must accept once,
 * on first use of DevFathom Hub. Acceptance is recorded per-account inside
 * `User.preferences.legalAcceptance` — this is a schema-first repo and the
 * existing `preferences` Json blob already carries other per-user config, so no
 * dedicated column/migration is needed. Bump LEGAL_AGREEMENT_VERSION to force
 * everyone to read and re-accept after a material change to the terms.
 */
export const LEGAL_AGREEMENT_VERSION = '1.0';

type LegalAcceptance = { version: string; acceptedAt: string; name: string };

function readAcceptance(raw: unknown): LegalAcceptance | null {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    const value = (raw as Record<string, unknown>).legalAcceptance;
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const o = value as Record<string, unknown>;
      if (typeof o.version === 'string' && typeof o.acceptedAt === 'string') {
        return {
          version: o.version,
          acceptedAt: o.acceptedAt,
          name: typeof o.name === 'string' ? o.name : '',
        };
      }
    }
  }
  return null;
}

export const legalRouter = router({
  // Has the current user accepted the current version of the agreement?
  status: protectedProcedure.query(async ({ ctx }) => {
    const user = await ctx.db.user.findUnique({
      where: { id: ctx.session.user.id },
      select: { preferences: true },
    });
    const acceptance = readAcceptance(user?.preferences);
    return {
      currentVersion: LEGAL_AGREEMENT_VERSION,
      accepted: acceptance?.version === LEGAL_AGREEMENT_VERSION,
      acceptedAt: acceptance?.acceptedAt ?? null,
    };
  }),

  // Record a one-time acceptance, merged into the existing preferences blob.
  accept: protectedProcedure
    .input(z.object({ name: z.string().trim().min(2).max(120) }))
    .mutation(async ({ ctx, input }) => {
      const existing = await ctx.db.user.findUnique({
        where: { id: ctx.session.user.id },
        select: { preferences: true },
      });
      const base =
        existing?.preferences &&
        typeof existing.preferences === 'object' &&
        !Array.isArray(existing.preferences)
          ? (existing.preferences as Record<string, unknown>)
          : {};

      const acceptance: LegalAcceptance = {
        version: LEGAL_AGREEMENT_VERSION,
        acceptedAt: new Date().toISOString(),
        name: input.name,
      };

      await ctx.db.user.update({
        where: { id: ctx.session.user.id },
        data: { preferences: { ...base, legalAcceptance: acceptance } },
      });

      return { success: true };
    }),
});
