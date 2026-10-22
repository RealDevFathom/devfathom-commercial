import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ scope: vi.fn(), capabilities: [] as string[] }));
vi.mock('server-only', () => ({}));
vi.mock('@/server/hotel-property-scope', async (importOriginal) => ({ ...(await importOriginal<typeof import('@/server/hotel-property-scope')>()), requireHotelPropertyScope: mocks.scope }));
vi.mock('../trpc', async () => { const { initTRPC, TRPCError } = await import('@trpc/server'); const t = initTRPC.context<{ denied?: string; [key: string]: unknown }>().create(); return { router: t.router, capabilityProcedure: (action: string) => { mocks.capabilities.push(action); return t.procedure.use(({ ctx, next }) => { if (ctx.denied === action) throw new TRPCError({ code: 'FORBIDDEN' }); return next(); }); } }; });
import { hotelFoliosRouter } from './hotel-folios';
import { hotelReservationsRouter, reservationStayInput } from './hotel-reservations';

const folio = { id: 'folio_1', folioNumber: 'FOL-1', status: 'OPEN', version: 2, currency: 'PKR', reservation: { confirmationNumber: 'RSV-1', arrivalDate: new Date(), departureDate: new Date(), primaryGuest: {} }, postings: [{ totalMinor: 12_000, currency: 'PKR', postedAt: new Date(), id: 'post' }], payments: [{ amountMinor: 5_000, currency: 'PKR', direction: 'COLLECTION', settledAt: new Date(), id: 'payment' }] };
const db = { hotelProperty: { findFirst: vi.fn() }, hotelReservation: { findFirst: vi.fn() }, hotelFolio: { findFirst: vi.fn() } };
const context = (denied?: string) => ({ denied, session: { user: { id: 'agent' } }, entitlements: { organizationId: 'org', enabledModules: ['hotel-reservations', 'hotel-folio'], limits: {} }, db, requestMeta: {}, audit: { detail: {} } });

beforeEach(() => { vi.clearAllMocks(); mocks.scope.mockResolvedValue(undefined); db.hotelProperty.findFirst.mockResolvedValue({ branchId: 'property', active: true }); db.hotelReservation.findFirst.mockResolvedValue({ id: 'reservation', primaryGuest: {}, stayUnits: [], events: [], folio }); db.hotelFolio.findFirst.mockResolvedValue(folio); });

describe('hotel reservation financial boundaries', () => {
  it('returns only a calculated folio summary to hotel:reservations readers', async () => { const result = await hotelReservationsRouter.createCaller(context() as never).get({ branchId: 'property', reservationId: 'reservation' }); expect(result.reservation.folio).toEqual({ id: 'folio_1', status: 'OPEN', version: 2, currency: 'PKR', balanceMinor: 7_000 }); expect(result.reservation.folio).not.toHaveProperty('postings'); expect(result.reservation.folio).not.toHaveProperty('payments'); });
  it('denies the complete ledger without hotel:folio', async () => { await expect(hotelFoliosRouter.createCaller(context('hotel:folio') as never).get({ branchId: 'property', folioId: 'folio_1' })).rejects.toMatchObject({ code: 'FORBIDDEN' }); expect(db.hotelFolio.findFirst).not.toHaveBeenCalled(); });
  it('uses distinct reservation and folio capability procedures', () => expect(new Set(mocks.capabilities)).toEqual(new Set(['hotel:reservations', 'hotel:folio'])));
  it.each(['nightlyRateMinor', 'taxMinorPerNight', 'amountMinor', 'totalMinor'])('rejects client-authored %s', (field) => { const result = reservationStayInput.safeParse({ roomTypeId: 'room_type', ratePlanId: 'rate', ratePlanVersion: 3, adults: 2, children: 0, [field]: 0 }); expect(result.success).toBe(false); });
});
