import { describe, expect, it, vi } from 'vitest';
import { searchCounterCatalog } from './counter';

const scope = { organizationId: 'org-a', branchId: 'branch-a' };
const medicine = (
  id: string,
  productName: string,
  brandName: string | null = null,
  manufacturer: string | null = null
) => ({
  id,
  productName,
  brandName,
  manufacturer,
  strengths: [],
  presentations: [{ id: `p-${id}`, presentation: 'Tablet', dosageForm: 'Tablet' }],
});

// Evaluate the actual read predicates, ordering and take: a sorter after a
// limited substring read alone must not make the limit regression pass.
function catalog(
  medicines: ReturnType<typeof medicine>[],
  aliases: { medicineId: string; normalizedValue: string }[] = []
) {
  const matchText = (text: string | null, filter: Record<string, string>) => {
    const value = (text ?? '').toLowerCase();
    return filter.startsWith !== undefined
      ? value.startsWith(filter.startsWith.toLowerCase())
      : value.includes(filter.contains.toLowerCase());
  };
  const db = {
    medicineBarcode: { findFirst: vi.fn(async () => null) },
    medicineAlias: {
      findMany: vi.fn(
        async ({
          where,
          take,
        }: {
          where: { normalizedValue: Record<string, string> };
          take?: number;
        }) =>
          aliases.filter((a) => matchText(a.normalizedValue, where.normalizedValue)).slice(0, take)
      ),
    },
    medicine: {
      findMany: vi.fn(
        async ({
          where,
          take,
        }: {
          where: {
            organizationId: string;
            saleable: boolean;
            id?: { in: string[] };
            OR?: Record<string, Record<string, string>>[];
          };
          take?: number;
        }) => {
          expect(where.organizationId).toBe(scope.organizationId);
          expect(where.saleable).toBe(true);
          const ids = where.id?.in;
          if (ids) return medicines.filter((m) => ids.includes(m.id));
          // DEV-878's same-ingredient alternatives read: this fixture has no lots, so
          // no medicine is an in-stock alternative.
          if (!where.OR) return [];
          return medicines
            .filter((m) =>
              where.OR!.some((clause: Record<string, Record<string, string>>) =>
                Object.entries(clause).some(([field, filter]) =>
                  matchText(m[field as keyof typeof m] as string | null, filter)
                )
              )
            )
            .sort((a, b) => a.productName.localeCompare(b.productName))
            .slice(0, take);
        }
      ),
    },
    medicineStrengthComponent: { findMany: vi.fn(async () => []) },
    presentation: { findMany: vi.fn(async () => []) },
    pharmacyInventoryLot: { findMany: vi.fn(async () => []) },
    packLevel: { findMany: vi.fn(async () => []) },
    medicinePackMrp: { findMany: vi.fn(async () => []) },
  };
  return db;
}

describe('counter search relevance (DEV-500)', () => {
  it('returns the recorded salt and strength as the row composition (DEV-862)', async () => {
    const withStrength = {
      ...medicine('with', 'Paracetamol', 'Panadol'),
      strengths: [{ value: '500.000000', unit: 'mg', ingredient: { name: 'paracetamol' } }],
    } as unknown as ReturnType<typeof medicine>;
    const db = catalog([withStrength, medicine('without', 'Paracetab')]);
    const result = await searchCounterCatalog(db as never, scope, { query: 'para' });
    const byId = new Map(result.rows.map((r) => [r.medicineId, r]));
    expect(byId.get('with')?.composition).toBe('paracetamol 500 mg');
    // Nothing recorded: nothing invented.
    expect(byId.get('without')?.composition).toBeNull();
  });

  it('ranks a prefix ahead of an alphabetically earlier substring', async () => {
    const db = catalog([medicine('substring', 'Apara'), medicine('prefix', 'Paracetamol')]);
    const result = await searchCounterCatalog(db as never, scope, { query: ' PARA ' });
    expect(result.rows.map((r) => r.medicineId)).toEqual(['prefix', 'substring']);
  });

  it('finds a prefix before substring candidates consume the result limit', async () => {
    const db = catalog([medicine('substring', 'Apara'), medicine('prefix', 'Paracetamol')]);
    const result = await searchCounterCatalog(db as never, scope, { query: 'para', limit: 1 });
    expect(result.rows.map((r) => r.medicineId)).toEqual(['prefix']);
    expect(result.truncated).toBe(true);
  });

  it('keeps a brand alias first after hydration and display-name sorting', async () => {
    const db = catalog(
      [medicine('generic', 'A headache alternative'), medicine('brand', 'Paracetamol', 'Panadol')],
      [{ medicineId: 'brand', normalizedValue: 'headache' }]
    );
    const result = await searchCounterCatalog(db as never, scope, { query: 'headache' });
    expect(result.rows.map((r) => [r.medicineId, r.matchedOn])).toEqual([
      ['brand', 'ALIAS'],
      ['generic', 'NAME'],
    ]);
    expect(result.rows[0].brandName).toBe('Panadol');
  });

  it('puts the branded prefix before a generic reached through a brand alias, including at the limit', async () => {
    const db = catalog(
      [medicine('generic', 'Acetaminophen'), medicine('brand', 'Paracetamol', 'Panadol')],
      [{ medicineId: 'generic', normalizedValue: 'panadol' }]
    );
    expect(
      (await searchCounterCatalog(db as never, scope, { query: 'panadol' })).rows.map(
        (r) => r.medicineId
      )
    ).toEqual(['brand', 'generic']);
    expect(
      (await searchCounterCatalog(db as never, scope, { query: 'panadol', limit: 1 })).rows.map(
        (r) => r.medicineId
      )
    ).toEqual(['brand']);
  });

  it('does not let a manufacturer prefix displace a brand alias at the limit', async () => {
    const db = catalog(
      [
        medicine('maker', 'Aspirin', null, 'Panadolia Labs'),
        medicine('brand', 'Paracetamol', 'Calpol'),
      ],
      [{ medicineId: 'brand', normalizedValue: 'panadol' }]
    );
    const limited = await searchCounterCatalog(db as never, scope, { query: 'panadol', limit: 1 });
    expect(limited.rows.map((r) => r.medicineId)).toEqual(['brand']);
    const all = await searchCounterCatalog(db as never, scope, { query: 'panadol' });
    expect(all.rows.map((r) => r.medicineId)).toEqual(['brand', 'maker']);
  });

  it('ranks a brand-name prefix even when no alias was stored', async () => {
    const db = catalog([
      medicine('substring', 'A Panadol alternative'),
      medicine('brand', 'Paracetamol', 'Panadol'),
    ]);
    const result = await searchCounterCatalog(db as never, scope, { query: 'panad' });
    expect(result.rows.map((r) => r.medicineId)).toEqual(['brand', 'substring']);
  });

  it('keeps deterministic ties and returns no unrelated medicine', async () => {
    const db = catalog([
      medicine('b', 'Paracetamol B'),
      medicine('a', 'Paracetamol A'),
      medicine('x', 'Ibuprofen'),
    ]);
    expect(
      (await searchCounterCatalog(db as never, scope, { query: 'para' })).rows.map(
        (r) => r.medicineId
      )
    ).toEqual(['a', 'b']);
    expect(await searchCounterCatalog(db as never, scope, { query: 'missing' })).toEqual({
      rows: [],
      truncated: false,
    });
  });
});
