import { describe, expect, it, vi } from 'vitest';
import {
  assertRxSaleLinesReady,
  dispenseRxSaleLine,
  PharmacyRxSaleGateError,
  reverseSaleFills,
} from './rx-sale-gate';

const base = {
  organizationId: 'org-a',
  branchId: 'branch-a',
  saleLineId: 'sale-line-a',
  prescriptionLineId: 'rx-line-a',
  actorId: 'pharmacist-a',
  idempotencyKey: 'dispense-a',
  at: new Date('2026-10-22T12:00:00Z'),
};

function dispensingDb(overrides: { status?: string; usedUnits?: number } = {}) {
  const fill = {
    id: 'fill-a',
    saleLineId: base.saleLineId,
    prescriptionLineId: base.prescriptionLineId,
    quantityCanonicalUnits: 10,
  };
  const query = vi
    .fn()
    .mockResolvedValueOnce([
      {
        status: overrides.status ?? 'OPEN',
        canonicalUnits: 10,
        medicineId: 'medicine-a',
        rx: true,
        controlled: false,
      },
    ])
    .mockResolvedValueOnce([])
    .mockResolvedValueOnce([
      {
        medicineId: 'medicine-a',
        validFrom: new Date('2026-10-01'),
        validUntil: new Date('2026-11-01'),
        authorizedCanonicalUnits: 10,
        usedUnits: overrides.usedUnits ?? 0,
        nextSequence: 1,
      },
    ])
    .mockResolvedValueOnce([fill]);
  return { db: { $queryRaw: query }, query, fill };
}

describe('Rx-only sale lifecycle gate', () => {
  it('reserves one fill for an open sale line and accepts that bound fill at checkout', async () => {
    const fixture = dispensingDb();
    await expect(dispenseRxSaleLine(fixture.db as never, base)).resolves.toEqual(fixture.fill);

    const checkout = { $queryRaw: vi.fn().mockResolvedValue([{ saleLineId: base.saleLineId }]) };
    await expect(
      assertRxSaleLinesReady(
        checkout as never,
        base.organizationId,
        { lines: [{ id: base.saleLineId, medicine: { rx: true, controlled: false } }] },
        base.at
      )
    ).resolves.toBeUndefined();
  });

  it.each(['VOID', 'HELD'])('refuses dispense against a %s sale', async (status) => {
    const fixture = dispensingDb({ status });
    await expect(dispenseRxSaleLine(fixture.db as never, base)).rejects.toMatchObject({
      code: 'SALE_NOT_OPEN',
    });
    expect(fixture.query).toHaveBeenCalledOnce();
  });

  it('refuses a second locked dispense when the first consumed the authorization', async () => {
    const fixture = dispensingDb({ usedUnits: 10 });
    await expect(dispenseRxSaleLine(fixture.db as never, base)).rejects.toMatchObject({
      code: 'AUTHORIZATION_EXHAUSTED',
    });
  });

  it('refuses checkout without exactly one valid, signed fill bound to the Rx line', async () => {
    const db = { $queryRaw: vi.fn().mockResolvedValue([]) };
    await expect(
      assertRxSaleLinesReady(db as never, base.organizationId, {
        lines: [{ id: base.saleLineId, medicine: { rx: true, controlled: false } }],
      })
    ).rejects.toBeInstanceOf(PharmacyRxSaleGateError);
  });

  it('does not gate OTC or controlled paths', async () => {
    const db = { $queryRaw: vi.fn() };
    await assertRxSaleLinesReady(db as never, base.organizationId, {
      lines: [
        { id: 'otc', medicine: { rx: false, controlled: false } },
        { id: 'controlled', medicine: { rx: true, controlled: true } },
      ],
    });
    expect(db.$queryRaw).not.toHaveBeenCalled();
  });

  it('releases bound fills when their sale is voided', async () => {
    const db = { $executeRaw: vi.fn().mockResolvedValue(1) };
    await reverseSaleFills(db as never, base.organizationId, 'sale-a', base.actorId);
    expect(db.$executeRaw).toHaveBeenCalledOnce();
  });
});
