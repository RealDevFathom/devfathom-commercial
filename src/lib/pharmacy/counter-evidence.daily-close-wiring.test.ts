import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

const finance = vi.hoisted(() => ({ postDailyCloseEntry: vi.fn() }));
vi.mock('./finance-postings', async () => ({
  ...(await vi.importActual<typeof import('./finance-postings')>('./finance-postings')),
  postDailyCloseEntry: finance.postDailyCloseEntry,
}));

import { cutPharmacyDailyClose } from '@/lib/pharmacy/settlement';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';

/**
 * CAM-2 DAILY_CLOSE evidence wiring on the integrated tip: cutPharmacyDailyClose requests the
 * still on its own client, after the close row, so both callers (the cutDailyClose mutation and
 * closePharmacyDay) get it. A close belongs to no sale, so the request carries saleId null.
 */
const scope = { organizationId: 'org-1', branchId: 'branch-1', actorId: 'actor-1' };
const input = { businessDate: new Date('2026-09-29') };

function fixture(camera: { id: string } | null) {
  finance.postDailyCloseEntry.mockReset();
  finance.postDailyCloseEntry.mockResolvedValue(null);
  const db = {
    $queryRaw: vi.fn().mockResolvedValue([]),
    pharmacyDrawerSession: {
      count: vi.fn().mockResolvedValue(0),
      findMany: vi.fn().mockResolvedValue([]),
    },
    pharmacyDailyClose: {
      // No prior close for the day; the evidence subject lookup finds the new one.
      findFirst: vi.fn(async ({ where }) => (where.id === 'close-1' ? { id: 'close-1' } : null)),
      create: vi.fn(async ({ data }) => ({ id: 'close-1', ...data })),
    },
    pharmacySale: { findMany: vi.fn().mockResolvedValue([]) },
    pharmacyRefund: { findMany: vi.fn().mockResolvedValue([]) },
    // No parallel run: the close is final without touching migration comparisons.
    pharmacyParallelRunWindow: { count: vi.fn().mockResolvedValue(0) },
    camera: { findFirst: vi.fn().mockResolvedValue(camera) },
    cameraEvidence: {
      createMany: vi.fn().mockResolvedValue({ count: 1 }),
      findUniqueOrThrow: vi.fn().mockResolvedValue({ id: 'evidence-1' }),
    },
  };
  return db;
}

const run = (db: ReturnType<typeof fixture>) =>
  cutPharmacyDailyClose(db as unknown as ScopedDb, scope, input);

describe('DAILY_CLOSE counter evidence wiring (service-level, integrated tip)', () => {
  it('writes the evidence outbox row on the close client, after the close row', async () => {
    const db = fixture({ id: 'camera-1' });
    await expect(run(db)).resolves.toMatchObject({ id: 'close-1', sequence: 1, isFinal: true });
    expect(db.pharmacyDailyClose.findFirst).toHaveBeenCalledWith({
      where: { id: 'close-1', organizationId: 'org-1', branchId: 'branch-1' },
      select: { id: true },
    });
    expect(db.cameraEvidence.createMany).toHaveBeenCalledWith({
      data: [
        {
          organizationId: 'org-1',
          branchId: 'branch-1',
          subjectKind: 'PHARMACY_DAILY_CLOSE',
          subjectId: 'close-1',
          saleId: null,
          cameraId: 'camera-1',
        },
      ],
      skipDuplicates: true,
    });
    // The request is written after the close row, so a failed close writes nothing.
    expect(db.pharmacyDailyClose.create.mock.invocationCallOrder[0]).toBeLessThan(
      db.cameraEvidence.createMany.mock.invocationCallOrder[0]!
    );
    expect(finance.postDailyCloseEntry).toHaveBeenCalledWith(
      db,
      scope,
      expect.objectContaining({ closeId: 'close-1' })
    );
    expect(finance.postDailyCloseEntry.mock.invocationCallOrder[0]).toBeLessThan(
      db.cameraEvidence.createMany.mock.invocationCallOrder[0]!
    );
  });

  it('writes nothing beyond the close when the branch has no usable evidence camera', async () => {
    const db = fixture(null);
    await expect(run(db)).resolves.toMatchObject({ id: 'close-1' });
    expect(db.camera.findFirst.mock.calls[0]![0].where).toMatchObject({
      organizationId: 'org-1',
      branchId: 'branch-1',
      enabled: true,
      counterEvidence: true,
      gateway: { status: 'ACTIVE', revokedAt: null },
    });
    expect(db.cameraEvidence.createMany).not.toHaveBeenCalled();
    expect(db.pharmacyDailyClose.create).toHaveBeenCalledTimes(1);
  });

  it('fails the close when the outbox write fails, so its transaction rolls back', async () => {
    const db = fixture({ id: 'camera-1' });
    db.cameraEvidence.createMany.mockRejectedValue(new Error('outbox down'));
    await expect(run(db)).rejects.toThrow('outbox down');
    // The close row was written in the same transaction; only the thrown error rolls it back.
    expect(db.pharmacyDailyClose.create).toHaveBeenCalledTimes(1);
  });

  it('does not request evidence when the finance posting fails', async () => {
    const db = fixture({ id: 'camera-1' });
    finance.postDailyCloseEntry.mockRejectedValueOnce(new Error('journal down'));

    await expect(run(db)).rejects.toThrow('journal down');

    expect(db.pharmacyDailyClose.create).toHaveBeenCalledTimes(1);
    expect(db.camera.findFirst).not.toHaveBeenCalled();
    expect(db.cameraEvidence.createMany).not.toHaveBeenCalled();
  });
});
