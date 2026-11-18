import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import {
  addMedicineDraftProvenance,
  drapAutofillValues,
  findDrapReferenceByRegistration,
  linkDrapReferenceRows,
  literalSearchTerm,
  loadDrapReference,
  searchDrapReference,
  type DrapReferenceRow,
} from './drap-reference-autofill';
import { DRAP_REGISTRY_RIGHTS } from './reference-connectors';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';

// Synthetic DRAP-shaped fixtures only; none of these are real registrations.
function proposal(id: string, values: Record<string, string>, createdAt = '2030-01-02') {
  return {
    id,
    inputDigest: `digest-${id}`,
    rowSourceKey: `drap-${values.drapRegistrationNumber ?? id}`,
    createdAt: new Date(createdAt),
    payload: {
      values,
      source: {
        connectorId: 'drap-registry',
        label: 'DRAP registry file',
        fileName: 'synthetic-drap.csv',
        batchId: 'batch-synthetic',
        rowSourceKey: `drap-${values.drapRegistrationNumber ?? id}`,
        rights: DRAP_REGISTRY_RIGHTS,
      },
    },
  };
}

function fakeDb(options: {
  connector?: { id: string } | null;
  anyRow?: { id: string } | null;
  rows?: ReturnType<typeof proposal>[];
  existing?: Array<{ drapRegistrationNumber: string }>;
}) {
  const db = {
    pharmacyReferenceConnector: {
      findFirst: vi.fn(async () =>
        options.connector === undefined ? { id: 'conn-drap' } : options.connector
      ),
    },
    pharmacyReferenceConnectorProposal: {
      findFirst: vi.fn(async (args: { where: { id?: string } }) =>
        args.where.id
          ? ((options.rows ?? []).find((row) => row.id === args.where.id) ?? null)
          : options.anyRow === undefined
            ? { id: 'any' }
            : options.anyRow
      ),
      findMany: vi.fn(async () => options.rows ?? []),
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
    medicine: { findMany: vi.fn(async () => options.existing ?? []) },
  };
  return db;
}

describe('DEV-683 DRAP auto-fill values', () => {
  it('copies only name, strength, form, registration and explicit flags, never a price', () => {
    expect(
      drapAutofillValues({
        productName: ' Synthamol ',
        strength: '500 mg',
        dosageForm: 'Tablet',
        drapRegistrationNumber: 'SYN-0001',
        rx: 'true',
        controlled: 'false',
        pack: '10 x 10',
        manufacturer: 'Fixture Labs',
        mrpMinor: '12000',
        price: '120',
      })
    ).toEqual({
      productName: 'Synthamol',
      strength: '500 mg',
      dosageForm: 'Tablet',
      drapRegistrationNumber: 'SYN-0001',
      rx: true,
      controlled: false,
    });
  });

  it('leaves a flag unset when the reference row has no explicit true or false', () => {
    expect(drapAutofillValues({ productName: 'Synthamol', rx: 'maybe', controlled: '' })).toEqual({
      productName: 'Synthamol',
    });
  });
});

describe('DEV-683 DRAP reference search', () => {
  it('says plainly that no reference data exists when no DRAP file was uploaded', async () => {
    const db = fakeDb({ connector: null });
    await expect(searchDrapReference(db as unknown as ScopedDb, 'org-a', 'synth')).resolves.toEqual(
      {
        hasReferenceData: false,
        matches: [],
      }
    );
    expect(db.pharmacyReferenceConnectorProposal.findMany).not.toHaveBeenCalled();
  });

  it('reports no data when the DRAP connector exists but holds no rows', async () => {
    const db = fakeDb({ anyRow: null });
    await expect(
      searchDrapReference(db as unknown as ScopedDb, 'org-a', 'synth')
    ).resolves.toMatchObject({ hasReferenceData: false });
  });

  it('does not search on a one-letter query', async () => {
    const db = fakeDb({});
    await expect(searchDrapReference(db as unknown as ScopedDb, 'org-a', 's')).resolves.toEqual({
      hasReferenceData: true,
      matches: [],
    });
    expect(db.pharmacyReferenceConnectorProposal.findMany).not.toHaveBeenCalled();
  });

  it('searches only this organisation’s unlinked DRAP rows by name or registration number', async () => {
    const db = fakeDb({
      rows: [
        proposal('p-new', {
          productName: 'Synthamol',
          drapRegistrationNumber: 'SYN-0001',
          rx: 'true',
        }),
        proposal(
          'p-old',
          { productName: 'Synthamol', drapRegistrationNumber: 'SYN-0001', rx: 'true' },
          '2030-01-01'
        ),
        proposal('p-known', { productName: 'Synthamol Forte', drapRegistrationNumber: 'SYN-0002' }),
      ],
      existing: [{ drapRegistrationNumber: 'SYN-0002' }],
    });
    const result = await searchDrapReference(db as unknown as ScopedDb, 'org-a', ' synth ');

    expect(db.pharmacyReferenceConnector.findFirst).toHaveBeenCalledWith({
      where: { organizationId: 'org-a', key: 'drap-registry' },
      select: { id: true },
    });
    expect(db.pharmacyReferenceConnectorProposal.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          organizationId: 'org-a',
          connectorId: 'conn-drap',
          // A row a pharmacist rejected or confirmed is never offered.
          status: 'PENDING',
          targetMedicineId: null,
          OR: [
            {
              payload: {
                path: ['values', 'productName'],
                string_contains: 'synth',
                mode: 'insensitive',
              },
            },
            {
              payload: {
                path: ['values', 'drapRegistrationNumber'],
                string_contains: 'synth',
                mode: 'insensitive',
              },
            },
          ],
        },
      })
    );
    // A repeated export of one registration is offered once, newest first.
    expect(result.matches.map((row) => [row.referenceId, row.inCatalogue])).toEqual([
      ['p-new', false],
      ['p-known', true],
    ]);
    expect(result.matches[0]).toMatchObject({
      fileName: 'synthetic-drap.csv',
      batchId: 'batch-synthetic',
      values: { productName: 'Synthamol', drapRegistrationNumber: 'SYN-0001', rx: true },
    });
  });

  it('loads a row only through this organisation’s DRAP connector and unlinked rows', async () => {
    const db = fakeDb({ rows: [proposal('p-new', { productName: 'Synthamol' })] });
    await expect(
      loadDrapReference(db as unknown as ScopedDb, 'org-a', 'p-new')
    ).resolves.toMatchObject({
      referenceId: 'p-new',
    });
    expect(db.pharmacyReferenceConnectorProposal.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: 'p-new',
          organizationId: 'org-a',
          connectorId: 'conn-drap',
          status: 'PENDING',
          targetMedicineId: null,
        },
      })
    );
    const none = fakeDb({ connector: null });
    await expect(
      loadDrapReference(none as unknown as ScopedDb, 'org-a', 'p-new')
    ).resolves.toBeNull();
  });
});

describe('DEV-683 literal search terms', () => {
  it('escapes LIKE wildcards so % and _ match themselves', () => {
    expect(literalSearchTerm('50%_off\\x')).toBe('50\\%\\_off\\\\x');
  });

  it('searches with the escaped term', async () => {
    const db = fakeDb({});
    await searchDrapReference(db as unknown as ScopedDb, 'org-a', 'SYN_%');
    const calls = db.pharmacyReferenceConnectorProposal.findMany.mock.calls as unknown[][];
    const where = calls[0]![0] as {
      where: { OR: Array<{ payload: { string_contains: string } }> };
    };
    expect(where.where.OR.map((item) => item.payload.string_contains)).toEqual([
      'SYN\\_\\%',
      'SYN\\_\\%',
    ]);
  });
});

describe('DEV-683 registration lookup and linking', () => {
  it('finds the newest DRAP row for a registration number in this organisation', async () => {
    const db = fakeDb({});
    await findDrapReferenceByRegistration(db as unknown as ScopedDb, 'org-a', 'SYN-0001');
    expect(db.pharmacyReferenceConnectorProposal.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          organizationId: 'org-a',
          connectorId: 'conn-drap',
          payload: { path: ['values', 'drapRegistrationNumber'], equals: 'SYN-0001' },
        },
        orderBy: { createdAt: 'desc' },
      })
    );
    const none = fakeDb({ connector: null });
    await expect(
      findDrapReferenceByRegistration(none as unknown as ScopedDb, 'org-a', 'SYN-0001')
    ).resolves.toBeNull();
  });

  it('links only pending, unlinked rows of this organisation to the new draft', async () => {
    const db = fakeDb({});
    await expect(
      linkDrapReferenceRows(db as unknown as ScopedDb, 'org-a', {
        referenceId: 'p-new',
        registration: 'SYN-0001',
        medicineId: 'medicine-new',
      })
    ).resolves.toEqual({ referenceLinked: true });
    const pending = {
      organizationId: 'org-a',
      connectorId: 'conn-drap',
      status: 'PENDING',
      targetMedicineId: null,
    };
    expect(db.pharmacyReferenceConnectorProposal.updateMany.mock.calls).toEqual([
      [{ where: { ...pending, id: 'p-new' }, data: { targetMedicineId: 'medicine-new' } }],
      [
        {
          where: {
            ...pending,
            payload: { path: ['values', 'drapRegistrationNumber'], equals: 'SYN-0001' },
          },
          data: { targetMedicineId: 'medicine-new' },
        },
      ],
    ]);
  });

  it('reports a chosen row that was decided or used in the meantime', async () => {
    const db = fakeDb({});
    db.pharmacyReferenceConnectorProposal.updateMany.mockResolvedValueOnce({ count: 0 });
    await expect(
      linkDrapReferenceRows(db as unknown as ScopedDb, 'org-a', {
        referenceId: 'p-new',
        registration: 'SYN-0001',
        medicineId: 'medicine-new',
      })
    ).resolves.toEqual({ referenceLinked: false });
  });
});

describe('DEV-683 draft provenance', () => {
  const reference: DrapReferenceRow = {
    referenceId: 'p-new',
    inputDigest: 'digest-a',
    rowSourceKey: 'drap-SYN-0001',
    batchId: 'batch-synthetic',
    fileName: 'synthetic-drap.csv',
    retrievedAt: new Date('2030-01-02'),
    values: {
      productName: 'Synthamol',
      strength: '500 mg',
      dosageForm: 'Tablet',
      drapRegistrationNumber: 'SYN-0001',
      rx: true,
      controlled: false,
    },
  };
  const input = {
    productName: 'Synthamol',
    strength: '650 mg',
    dosageForm: 'Tablet',
    pack: '10 tablets',
    drapRegistrationNumber: 'SYN-0001',
    rx: true,
    controlled: false,
  };
  const options = {
    editorId: 'editor-a',
    entryId: 'add-medicine:entry',
    now: new Date('2030-02-01'),
  };

  it('records reference values as unreviewed regulator data and edits as the person’s own', () => {
    const provenance = addMedicineDraftProvenance(input, reference, options);
    const byField = Object.fromEntries(provenance.map((item) => [item.field, item]));
    expect(Object.keys(byField).sort()).toEqual([
      'controlled',
      'dosageForm',
      'drapRegistrationNumber',
      'pack',
      'productName',
      'rx',
      'strength',
    ]);
    expect(provenance.every((item) => item.status === 'UNREVIEWED')).toBe(true);
    expect(provenance.every((item) => item.editorId === 'editor-a')).toBe(true);
    expect(byField.rx).toMatchObject({
      sourceType: 'REGULATOR',
      source: 'drap-registry:digest-a:drap-SYN-0001',
      assertedValue: { value: 'true', connectorId: 'drap-registry', rowSourceKey: 'drap-SYN-0001' },
    });
    expect(byField.controlled).toMatchObject({
      sourceType: 'REGULATOR',
      assertedValue: { value: 'false' },
    });
    // The person changed strength and typed the pack: their own entries, not regulator data.
    expect(byField.strength).toMatchObject({
      sourceType: 'USER',
      assertedValue: { value: '650 mg', connectorId: 'add-medicine-form' },
    });
    expect(byField.pack).toMatchObject({ sourceType: 'USER' });
    expect(provenance.some((item) => /price|mrp/i.test(item.field))).toBe(false);
  });

  it('records every field as the person’s entry when no reference row was used', () => {
    const provenance = addMedicineDraftProvenance(input, null, options);
    expect(provenance.every((item) => item.sourceType === 'USER')).toBe(true);
  });
});
