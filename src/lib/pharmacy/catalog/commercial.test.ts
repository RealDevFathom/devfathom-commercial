import { describe, expect, it, vi } from 'vitest';
import type { Subject } from '@/lib/abac';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import {
  catalogMedicineDetail,
  setCatalogDefaultPrices,
  setCatalogMedicineAvailability,
  setCatalogPackPrice,
  type CatalogPackPriceInput,
} from './commercial';

type Grant = 'OWNER' | 'NO_GRANT' | 'ROLE_DENY' | 'USER_DENY' | 'MISSING_USER' | 'LOOKUP_ERROR';
type RawRow = Record<string, unknown>;

const subject: Subject = { id: 'user-a', role: 'ADMIN', status: 'ACTIVE' };
const actor = { organizationId: 'org-a', subject };

function sqlText(query: unknown): string {
  return (query as { strings: readonly string[] }).strings.join('?');
}

/** A tenant database double: `can()` reads the user, raw SQL is answered by `raw`. */
function fakeDb(grant: Grant, raw: (sql: string) => RawRow[] = () => []) {
  const writes: string[] = [];
  const mock = {
    user: {
      findUnique: vi.fn(async () => {
        if (grant === 'LOOKUP_ERROR') throw new Error('connection reset');
        if (grant === 'MISSING_USER') return null;
        const owner = [{ capability: 'pharmacy:*', effect: 'ALLOW' }];
        return {
          permissionOverrides:
            grant === 'USER_DENY'
              ? [{ capability: 'pharmacy:catalog-settings', effect: 'DENY' }]
              : [],
          organizationRole: {
            permissions:
              grant === 'NO_GRANT'
                ? [{ capability: 'pharmacy:manage', effect: 'ALLOW' }]
                : grant === 'ROLE_DENY'
                  ? [...owner, { capability: 'pharmacy:catalog-settings', effect: 'DENY' }]
                  : owner,
          },
        };
      }),
    },
    $queryRaw: vi.fn(async (query: unknown) => raw(sqlText(query))),
    $executeRaw: vi.fn(async (query: unknown) => {
      writes.push(sqlText(query));
      return 2;
    }),
    pharmacyCatalogSetting: {
      update: vi.fn(async () => {
        writes.push('setting.update');
        return {};
      }),
    },
    packLevel: {
      updateMany: vi.fn(async () => {
        writes.push('pack.updateMany');
        return { count: 1 };
      }),
    },
    medicine: {
      findFirst: vi.fn(async () => null as unknown),
      update: vi.fn(async () => {
        writes.push('medicine.update');
        return {};
      }),
    },
    auditLog: {
      create: vi.fn(async () => {
        writes.push('audit');
        return {};
      }),
    },
  };
  return { db: mock as unknown as ScopedDb, mock, writes };
}

const priceInput: CatalogPackPriceInput = {
  packLevelId: 'pack-a',
  sellingPriceMinor: 1500,
  purchasePriceMinor: null,
  expected: { sellingPriceMinor: null, purchasePriceMinor: null },
};

/** Answers for one catalogue medicine with one current pack. */
function catalogRows(state: {
  saleable: boolean;
  pack?: { effectiveTo?: Date | null; sellingPriceMinor: number | null };
  pricedPack?: boolean;
}) {
  return (sql: string): RawRow[] => {
    if (sql.includes('SELECT presentation."medicineId"')) return [{ medicineId: 'med-a' }];
    if (sql.includes('FOR NO KEY UPDATE')) return [{ id: 'med-a', saleable: state.saleable }];
    if (sql.includes('FOR UPDATE OF pack')) {
      return [
        {
          id: 'pack-a',
          effectiveTo: state.pack?.effectiveTo ?? null,
          sellingPriceMinor: state.pack?.sellingPriceMinor ?? null,
          purchasePriceMinor: null,
        },
      ];
    }
    if (sql.includes('"sellingPriceMinor" > 0')) return state.pricedPack ? [{ id: 'pack-a' }] : [];
    if (sql.includes('pharmacy_catalog_settings')) return [{ useCatalogDefaultPrices: false }];
    return [];
  };
}

const writers = [
  ['setCatalogDefaultPrices', (db: ScopedDb) => setCatalogDefaultPrices(db, actor, true)],
  ['setCatalogPackPrice', (db: ScopedDb) => setCatalogPackPrice(db, actor, priceInput)],
  [
    'setCatalogMedicineAvailability',
    (db: ScopedDb) =>
      setCatalogMedicineAvailability(db, actor, { medicineId: 'med-a', saleable: true }),
  ],
  ['catalogMedicineDetail', (db: ScopedDb) => catalogMedicineDetail(db, actor, 'med-a')],
] as const;

describe.each(writers)('%s authorization (finding 1)', (_name, run) => {
  it.each(['NO_GRANT', 'ROLE_DENY', 'USER_DENY', 'MISSING_USER', 'LOOKUP_ERROR'] as const)(
    'fails closed with FORBIDDEN for %s before reading or writing catalogue data',
    async (grant) => {
      const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      const { db, mock, writes } = fakeDb(grant, catalogRows({ saleable: false }));
      await expect(run(db)).rejects.toMatchObject({ code: 'FORBIDDEN' });
      expect(mock.user.findUnique).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: 'user-a' } })
      );
      expect(mock.$queryRaw).not.toHaveBeenCalled();
      expect(mock.medicine.findFirst).not.toHaveBeenCalled();
      expect(writes).toEqual([]);
      errors.mockRestore();
    }
  );
});

describe('catalogue pack price compare-and-set (finding 2)', () => {
  it('rejects a stale expected price with CONFLICT and writes nothing', async () => {
    const { db, writes } = fakeDb(
      'OWNER',
      catalogRows({ saleable: false, pack: { sellingPriceMinor: 1200 } })
    );
    await expect(setCatalogPackPrice(db, actor, priceInput)).rejects.toMatchObject({
      code: 'CONFLICT',
    });
    expect(writes).toEqual([]);
  });

  it('locks the medicine before the pack and writes only when the expected values hold', async () => {
    const { db, mock, writes } = fakeDb('OWNER', catalogRows({ saleable: false }));
    await expect(setCatalogPackPrice(db, actor, priceInput)).resolves.toMatchObject({
      packLevelId: 'pack-a',
      sellingPriceMinor: 1500,
    });
    const statements = mock.$queryRaw.mock.calls.map(([query]) => sqlText(query));
    const medicineLock = statements.findIndex((sql) => sql.includes('FOR NO KEY UPDATE'));
    const packLock = statements.findIndex((sql) => sql.includes('FOR UPDATE OF pack'));
    expect(medicineLock).toBeGreaterThanOrEqual(0);
    expect(packLock).toBeGreaterThan(medicineLock);
    expect(mock.packLevel.updateMany).toHaveBeenCalledWith({
      where: {
        id: 'pack-a',
        organizationId: 'org-a',
        sellingPriceMinor: null,
        purchasePriceMinor: null,
      },
      data: { sellingPriceMinor: 1500, purchasePriceMinor: null },
    });
    expect(writes).toEqual(['pack.updateMany', 'audit']);
  });

  it('refuses to price a superseded pack version', async () => {
    const { db, writes } = fakeDb(
      'OWNER',
      catalogRows({ saleable: false, pack: { effectiveTo: new Date(0), sellingPriceMinor: null } })
    );
    await expect(setCatalogPackPrice(db, actor, priceInput)).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
    expect(writes).toEqual([]);
  });

  it('applies default prices with set-based NULL-guarded updates, never a read-then-write loop', async () => {
    const { db, mock, writes } = fakeDb('OWNER', catalogRows({ saleable: false }));
    await expect(setCatalogDefaultPrices(db, actor, true)).resolves.toEqual({
      enabled: true,
      saleApplied: 2,
      purchaseApplied: 2,
    });
    const updates = writes.filter((sql) => sql.includes('UPDATE "pharmacy_pack_levels"'));
    expect(updates).toHaveLength(2);
    expect(updates[0]).toContain('"sellingPriceMinor" IS NULL');
    expect(updates[1]).toContain('"purchasePriceMinor" IS NULL');
    const settingLock = mock.$queryRaw.mock.calls
      .map(([query]) => sqlText(query))
      .find((sql) => sql.includes('pharmacy_catalog_settings'));
    expect(settingLock).toContain('FOR UPDATE');
  });
});

describe('catalogue availability (finding 3)', () => {
  it('will not make a catalogue medicine saleable without a positive current-pack price', async () => {
    const { db, writes } = fakeDb('OWNER', catalogRows({ saleable: false, pricedPack: false }));
    await expect(
      setCatalogMedicineAvailability(db, actor, { medicineId: 'med-a', saleable: true })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(writes).toEqual([]);
  });

  it('still applies the regulated saleability rules when a price exists', async () => {
    const { db, mock, writes } = fakeDb(
      'OWNER',
      catalogRows({ saleable: false, pricedPack: true })
    );
    mock.medicine.findFirst.mockResolvedValue({
      productFamily: 'PHARMACEUTICAL',
      drapRegistrationNumber: null,
      presentations: [{ id: 'pres-a' }],
      strengths: [],
      provenance: [],
    });
    await expect(
      setCatalogMedicineAvailability(db, actor, { medicineId: 'med-a', saleable: true })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(writes).toEqual([]);
  });

  it('makes a reviewed, priced catalogue medicine saleable and audits it', async () => {
    const { db, mock, writes } = fakeDb(
      'OWNER',
      catalogRows({ saleable: false, pricedPack: true })
    );
    mock.medicine.findFirst.mockResolvedValue({
      productFamily: 'PHARMACEUTICAL',
      drapRegistrationNumber: 'DRAP-1',
      presentations: [{ id: 'pres-a' }],
      strengths: [{ id: 'strength-a' }],
      provenance: [{ field: 'drapRegistrationNumber' }],
    });
    await expect(
      setCatalogMedicineAvailability(db, actor, { medicineId: 'med-a', saleable: true })
    ).resolves.toEqual({ medicineId: 'med-a', saleable: true, changed: true });
    expect(mock.medicine.update).toHaveBeenCalledWith({
      where: { id: 'med-a' },
      data: { saleable: true },
    });
    expect(writes).toEqual(['medicine.update', 'audit']);
  });

  it('refuses to remove the last selling price of a saleable catalogue medicine', async () => {
    const { db, writes } = fakeDb(
      'OWNER',
      catalogRows({ saleable: true, pack: { sellingPriceMinor: 1500 }, pricedPack: false })
    );
    await expect(
      setCatalogPackPrice(db, actor, {
        ...priceInput,
        sellingPriceMinor: null,
        expected: { sellingPriceMinor: 1500, purchasePriceMinor: null },
      })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(writes).toEqual([]);
  });
});
