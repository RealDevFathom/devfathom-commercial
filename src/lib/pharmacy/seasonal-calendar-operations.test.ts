import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import { demandDateAfter } from './demand-evidence';
import { readSaltDemandSpikes, saveSeasonalWindow } from './seasonal-calendar-operations';

const scope = { organizationId: 'org', branchId: 'branch' };

function line(medicineId: string, date: string, units: number) {
  return {
    medicineId,
    canonicalUnits: units,
    sale: { businessDate: new Date(`${date}T00:00:00Z`) },
  };
}

describe('per-salt outbreak spike detection', () => {
  it('flags a synthetic paracetamol spike on the branch without flagging a steady salt', async () => {
    const lines = [];
    for (let i = 0; i < 40; i += 1) {
      const date = demandDateAfter('2026-08-01', i);
      lines.push(line('panadol', date, 6), line('calpol', date, 4), line('amox', date, 8));
    }
    // Synthetic outbreak day: both paracetamol products jump; amoxicillin stays flat.
    lines.push(line('panadol', '2026-09-10', 30), line('calpol', '2026-09-10', 20));
    lines.push(line('amox', '2026-09-10', 8));
    const findMany = vi.fn().mockResolvedValue(lines);
    const components = vi.fn().mockResolvedValue([
      { medicineId: 'panadol', ingredient: { id: 'para', name: 'Paracetamol' } },
      { medicineId: 'calpol', ingredient: { id: 'para', name: 'Paracetamol' } },
      { medicineId: 'amox', ingredient: { id: 'amoxi', name: 'Amoxicillin' } },
    ]);
    const db = {
      pharmacySaleLine: { findMany },
      medicineStrengthComponent: { findMany: components },
    } as unknown as ScopedDb;
    const report = await readSaltDemandSpikes(db, scope, {
      branchId: 'branch',
      from: '2026-09-01',
      to: '2026-09-10',
    });
    expect(report.label).toBe('ESTIMATE');
    expect(report.salts).toEqual([
      {
        ingredientId: 'para',
        name: 'Paracetamol',
        spikes: [
          expect.objectContaining({
            date: '2026-09-10',
            units: 50,
            baselineMeanUnits: 10,
            upliftBps: 50_000,
            baselineDays: 28,
          }),
        ],
      },
    ]);
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          organizationId: 'org',
          branchId: 'branch',
          sale: expect.objectContaining({ organizationId: 'org', branchId: 'branch' }),
        }),
      })
    );
  });

  it('rejects a mismatched branch and an over-long period before reading', async () => {
    const findMany = vi.fn();
    const db = { pharmacySaleLine: { findMany } } as unknown as ScopedDb;
    await expect(
      readSaltDemandSpikes(db, scope, { branchId: 'other', from: '2026-09-01', to: '2026-09-10' })
    ).rejects.toThrow(RangeError);
    await expect(
      readSaltDemandSpikes(db, scope, { branchId: 'branch', from: '2026-01-01', to: '2026-09-10' })
    ).rejects.toThrow(RangeError);
    expect(findMany).not.toHaveBeenCalled();
  });

  it('edits only a window inside the caller organization and branch', async () => {
    const updateMany = vi.fn().mockResolvedValue({ count: 0 });
    const db = { pharmacySeasonalWindow: { updateMany } } as unknown as ScopedDb;
    await expect(
      saveSeasonalWindow(
        db,
        { ...scope, actorId: 'owner' },
        {
          id: 'foreign',
          branchId: 'branch',
          kind: 'RAMADAN',
          label: 'Ramadan 1448',
          startDate: '2027-02-08',
          endDateExclusive: '2027-03-10',
        }
      )
    ).rejects.toThrow('Seasonal window not found');
    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'foreign', organizationId: 'org', branchId: 'branch' },
        data: expect.objectContaining({ updatedByUserId: 'owner', kind: 'RAMADAN' }),
      })
    );
  });
});
