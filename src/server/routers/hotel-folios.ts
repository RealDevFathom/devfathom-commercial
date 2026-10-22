import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { hasModule } from '@/lib/entitlements';
import { calculateFolioBalance } from '@/lib/hotel/folios';
import { currentProperty } from '@/server/hotel-property-context';
import { hotelPropertySelectionInput } from '@/server/hotel-property-scope';
import { capabilityProcedure, router } from '../trpc';
const folios = capabilityProcedure('hotel:folio');
const input = hotelPropertySelectionInput.extend({ folioId: z.string().min(1) });
function requireModule(ctx: { entitlements: Parameters<typeof hasModule>[0] }) { if (!hasModule(ctx.entitlements, 'hotel-folio')) throw new TRPCError({ code: 'FORBIDDEN', message: 'Folios are not enabled.' }); }
async function read(ctx: any, branchId: string | undefined, folioId: string) { requireModule(ctx); const property = await currentProperty(ctx, branchId, 'hotel:folio'); const folio = await ctx.db.hotelFolio.findFirst({ where: { id: folioId, organizationId: ctx.entitlements.organizationId, branchId: property.branchId }, include: { reservation: { include: { primaryGuest: true } }, postings: { orderBy: [{ postedAt: 'asc' }, { id: 'asc' }] }, payments: { orderBy: [{ settledAt: 'asc' }, { id: 'asc' }] } } }); if (!folio) throw new TRPCError({ code: 'NOT_FOUND', message: 'Folio not found.' }); const balanceMinor = calculateFolioBalance(folio.currency, folio.postings, folio.payments); return { folio, balanceMinor }; }
export const hotelFoliosRouter = router({
  get: folios.input(input).query(({ ctx, input }) => read(ctx, input.branchId, input.folioId)),
  statement: folios.input(input).query(async ({ ctx, input }) => { const { folio, balanceMinor } = await read(ctx, input.branchId, input.folioId); return { folioNumber: folio.folioNumber, status: folio.status, currency: folio.currency, guest: folio.reservation.primaryGuest, reservation: { confirmationNumber: folio.reservation.confirmationNumber, arrivalDate: folio.reservation.arrivalDate, departureDate: folio.reservation.departureDate }, postings: folio.postings, payments: folio.payments, balanceMinor }; }),
});
