import { TRPCError } from '@trpc/server';
import { z } from 'zod';

import { Prisma } from '@/generated/prisma/client';
import { recordHotelAudit } from '@/lib/hotel/audit';
import { createFolioLedgerService, folioPostingInput } from '@/lib/hotel/folio-ledger';
import { createPrismaFolioLedgerStore, type FolioSqlClient } from '@/lib/hotel/folio-ledger-store';
import { calculateFolioBalance } from '@/lib/hotel/folios';
import {
  currentProperty,
  hasSqlState,
  withLockedProperty,
  type HotelCapability,
  type PropertyContext,
} from '@/server/hotel-property-context';
import { hotelPropertySelectionInput } from '@/server/hotel-property-scope';
import { capabilityProcedure, router } from '../trpc';

/**
 * FOL-01 over the single `hotel_folio_entries` ledger. Reads and posting need
 * `hotel:folio`; a reversal is an adjustment and needs `hotel:folio-adjust`.
 * Each is re-checked against the selected property before any ledger query.
 */
const folio = capabilityProcedure('hotel:folio');
const adjust = capabilityProcedure('hotel:folio-adjust');

const folioIdInput = hotelPropertySelectionInput
  .extend({ folioId: z.string().trim().min(1).max(191) })
  .strict();
export const folioPostExtraInput = hotelPropertySelectionInput.extend(folioPostingInput.shape).strict();
export const folioReverseInput = hotelPropertySelectionInput
  .extend({ entryId: z.string().trim().min(1).max(191), reason: z.string().trim().min(3).max(500) })
  .strict();

function actorId(ctx: { session: { user?: { id?: string } } | null }): string {
  const value = ctx.session?.user?.id;
  if (!value) throw new TRPCError({ code: 'UNAUTHORIZED' });
  return value;
}

/** A ledger service whose authorization is the property-scoped capability check. */
function ledgerFor(
  ctx: PropertyContext,
  db: FolioSqlClient,
  branchId: string,
  capability: HotelCapability,
  actor: string
) {
  return createFolioLedgerService(createPrismaFolioLedgerStore(db, actor), async () => {
    await currentProperty(ctx, branchId, capability);
  });
}

function mapLedgerError(error: unknown): never {
  if (error instanceof TRPCError) throw error;
  if (error instanceof z.ZodError) throw new TRPCError({ code: 'BAD_REQUEST', message: 'Invalid posting.' });
  if (hasSqlState(error, '23505')) {
    throw new TRPCError({ code: 'CONFLICT', message: 'That entry has already been reversed.' });
  }
  if (error instanceof Error && /unavailable|Invalid|too large/.test(error.message)) {
    throw new TRPCError({ code: 'NOT_FOUND', message: error.message });
  }
  throw error;
}

export const hotelFoliosRouter = router({
  get: folio.input(folioIdInput).query(async ({ ctx, input }) => {
    const actor = actorId(ctx);
    const scope = { organizationId: ctx.entitlements.organizationId, branchId: input.branchId };
    const ledger = ledgerFor(ctx, ctx.db, input.branchId, 'hotel:folio', actor);
    const header = await ledger.get(scope, input.folioId);
    if (!header) throw new TRPCError({ code: 'NOT_FOUND', message: 'Folio not found.' });
    const entries = await ledger.entries(scope, input.folioId);
    const payments = await ctx.db.$queryRaw<
      { id: string; direction: 'COLLECTION' | 'REFUND'; amountMinor: bigint; currency: string; refundsPaymentId: string | null; createdAt: Date }[]
    >(Prisma.sql`
      SELECT id, direction::text AS direction, "amountMinor", currency, "refundsPaymentId", "createdAt"
      FROM hotel_folio_payments
      WHERE "organizationId" = ${scope.organizationId}
        AND "branchId" = ${scope.branchId}
        AND "folioId" = ${input.folioId}
      ORDER BY "createdAt", id`);
    const balanceMinor = calculateFolioBalance(
      String(header.currency),
      entries.map((entry) => ({
        grossMinor: entry.grossMinor as bigint,
        currency: String(entry.currency),
        reversesEntryId: (entry.reversesEntryId as string | null) ?? null,
      })),
      payments
    );
    return { folio: header, entries, payments, balanceMinor };
  }),

  /** The server prices the charge from the property's catalog; no money is accepted. */
  postExtra: folio.input(folioPostExtraInput).mutation(({ ctx, input }) => {
    const actor = actorId(ctx);
    return withLockedProperty(
      ctx,
      input.branchId,
      async (tx, property) => {
        const scope = { organizationId: tx.entitlements.organizationId, branchId: property.branchId };
        const posting = {
          folioId: input.folioId,
          catalogItemId: input.catalogItemId,
          quantity: input.quantity,
          ...(input.reason ? { reason: input.reason } : {}),
        };
        const entry = await ledgerFor(tx, tx.db, property.branchId, 'hotel:folio', actor)
          .post(scope, posting)
          .catch(mapLedgerError);
        recordHotelAudit(ctx, {
          entity: { type: 'HotelFolioEntry', id: String(entry.id) },
          action: 'hotel.folio.postExtra',
          operation: 'CREATE',
          after: {
            folioId: input.folioId,
            catalogItemId: input.catalogItemId,
            quantity: input.quantity,
            grossMinor: String(entry.grossMinor),
          },
          metadata: { branchId: property.branchId },
        });
        return entry;
      },
      'hotel:folio'
    );
  }),

  /** A correction is a positive copy naming the original; an entry is reversed once. */
  reverse: adjust.input(folioReverseInput).mutation(({ ctx, input }) => {
    const actor = actorId(ctx);
    return withLockedProperty(
      ctx,
      input.branchId,
      async (tx, property) => {
        const scope = { organizationId: tx.entitlements.organizationId, branchId: property.branchId };
        const entry = await ledgerFor(tx, tx.db, property.branchId, 'hotel:folio-adjust', actor)
          .reverse(scope, input.entryId, input.reason)
          .catch(mapLedgerError);
        recordHotelAudit(ctx, {
          entity: { type: 'HotelFolioEntry', id: String(entry.id) },
          action: 'hotel.folio.reverse',
          operation: 'CREATE',
          after: { reversesEntryId: input.entryId, reason: input.reason },
          metadata: { branchId: property.branchId },
        });
        return entry;
      },
      'hotel:folio-adjust'
    );
  }),
});
