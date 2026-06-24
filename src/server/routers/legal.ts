import { createHash } from 'node:crypto';
import { z } from 'zod';
import { router, protectedProcedure } from '../trpc';
import { annotateAudit } from '@/server/audit';
import {
  AGREEMENT_VERSION,
  AGREEMENT_TITLE,
  AGREEMENT_CANONICAL_TEXT,
} from '@/lib/legal-agreement';

/**
 * Confidentiality & Non-Replication Agreement (owned by Intelligent Health
 * Partners LLC) that every user must accept once, on first use of DevFathom Hub.
 *
 * Acceptance leaves two records:
 *   1. A fast-path flag in `User.preferences.legalAcceptance` used to decide
 *      whether to show the gate (no migration — schema-first repo).
 *   2. The append-only `audit_logs` row the tRPC audit middleware writes for
 *      this mutation automatically — capturing actor id/name/email, IP, user
 *      agent, the typed name (input), and a server timestamp. We enrich it via
 *      annotateAudit() with the agreement version and a SHA-256 hash of the
 *      exact text that was accepted, so the record is tamper-evident.
 *
 * Bump AGREEMENT_VERSION (in src/lib/legal-agreement.ts) on any material change
 * to the terms to force everyone to read and re-accept.
 */
export const LEGAL_AGREEMENT_VERSION = AGREEMENT_VERSION;

/** SHA-256 of the canonical agreement text, computed once at module load. */
export const AGREEMENT_HASH = createHash('sha256').update(AGREEMENT_CANONICAL_TEXT).digest('hex');

type LegalAcceptance = {
  version: string;
  acceptedAt: string;
  name: string;
  agreementHash: string;
};

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
          agreementHash: typeof o.agreementHash === 'string' ? o.agreementHash : '',
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
      currentVersion: AGREEMENT_VERSION,
      accepted: acceptance?.version === AGREEMENT_VERSION,
      acceptedAt: acceptance?.acceptedAt ?? null,
    };
  }),

  // Record a one-time acceptance: a flag on the user, plus an enriched,
  // append-only audit row (actor, IP, UA, typed name, timestamp, version, hash).
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
        version: AGREEMENT_VERSION,
        acceptedAt: new Date().toISOString(),
        name: input.name,
        agreementHash: AGREEMENT_HASH,
      };

      await ctx.db.user.update({
        where: { id: ctx.session.user.id },
        data: { preferences: { ...base, legalAcceptance: acceptance } },
      });

      // Enrich the audit entry the middleware writes for this mutation.
      annotateAudit(ctx, {
        category: 'LEGAL',
        operation: 'EXECUTE',
        action: 'legal.accept',
        description: `Accepted ${AGREEMENT_TITLE} v${AGREEMENT_VERSION} as "${input.name}"`,
        targetType: 'LegalAgreement',
        targetId: AGREEMENT_VERSION,
        targetLabel: AGREEMENT_TITLE,
        metadata: {
          version: AGREEMENT_VERSION,
          agreementHash: AGREEMENT_HASH,
          signedName: input.name,
        },
      });

      return { success: true };
    }),
});
