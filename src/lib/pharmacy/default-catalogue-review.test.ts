import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import type { ScopedDb } from '@/lib/tenancy/scoped-db';

import {
  CATALOGUE_REVIEW_RIGHTS,
  catalogueAwaitingReviewWhere,
  catalogueReviewDefaults,
  draftCatalogueReview,
  matchCatalogueMedicine,
  resolveCatalogueReview,
} from './default-catalogue-review';

const item = {
  productName: 'PANADOL 500MG TAB',
  brandName: 'PANADOL 500MG TAB',
  manufacturer: 'GSK',
  strength: '500MG',
  dosageForm: 'Tablet',
};
const copy = {
  productName: 'PANADOL 500MG TAB',
  brandName: 'PANADOL 500MG TAB',
  manufacturer: 'GSK',
  drapRegistrationNumber: null,
  strengths: [],
  presentations: [{ dosageForm: 'Tablet', presentation: '500MG Tablet' }],
};

describe('catalogueAwaitingReviewWhere', () => {
  it('selects only unsaleable copies and NARCOTICS links', () => {
    expect(catalogueAwaitingReviewWhere()).toEqual({
      saleable: false,
      catalogueProvenance: {
        is: { OR: [{ linkedExisting: false }, { controlledCandidate: true }] },
      },
    });
    expect(catalogueAwaitingReviewWhere({ controlledOnly: true })).toEqual({
      saleable: false,
      catalogueProvenance: { is: { controlledCandidate: true } },
    });
  });

  it('searches names case-insensitively and the source key exactly', () => {
    expect(catalogueAwaitingReviewWhere({ query: '  catalog-0 ' })).toMatchObject({
      saleable: false,
      OR: [
        { productName: { contains: 'catalog-0', mode: 'insensitive' } },
        { brandName: { contains: 'catalog-0', mode: 'insensitive' } },
        { catalogueProvenance: { is: { sourceKey: 'catalog-0' } } },
      ],
    });
  });
});

describe('catalogueReviewDefaults', () => {
  it('drafts a copy from its catalogue item and the presentation the catalogue created', () => {
    expect(catalogueReviewDefaults({ linkedExisting: false, item, medicine: copy })).toEqual({
      productName: { value: 'PANADOL 500MG TAB', origin: 'catalogue' },
      brandName: { value: 'PANADOL 500MG TAB', origin: 'catalogue' },
      manufacturer: { value: 'GSK', origin: 'catalogue' },
      strength: { value: '500MG', origin: 'catalogue' },
      dosageForm: { value: 'Tablet', origin: 'catalogue' },
      pack: { value: '500MG Tablet', origin: 'catalogue' },
    });
  });

  it('keeps what the pharmacy edited on a copy, and never puts a cleared field back', () => {
    const defaults = catalogueReviewDefaults({
      linkedExisting: false,
      item,
      medicine: { ...copy, productName: 'Panadol 500 mg (corrected)', brandName: null },
    });
    expect(defaults.productName).toEqual({
      value: 'Panadol 500 mg (corrected)',
      origin: 'medicine',
    });
    expect(defaults.brandName).toBeUndefined();
  });

  it('drafts a linked hand-entered medicine from its own record only', () => {
    expect(
      catalogueReviewDefaults({
        linkedExisting: true,
        item: { ...item, strength: '1000MG' },
        medicine: {
          productName: 'Deltacortril 5mg Tab',
          brandName: null,
          manufacturer: 'Getz',
          drapRegistrationNumber: '067890',
          strengths: [{ value: 5, unit: 'mg' }],
          presentations: [{ dosageForm: 'Tablet', presentation: 'Deltacortril tablet' }],
        },
      })
    ).toEqual({
      productName: { value: 'Deltacortril 5mg Tab', origin: 'medicine' },
      manufacturer: { value: 'Getz', origin: 'medicine' },
      drapRegistrationNumber: { value: '067890', origin: 'medicine' },
      strength: { value: '5 mg', origin: 'medicine' },
      dosageForm: { value: 'Tablet', origin: 'medicine' },
      pack: { value: 'Deltacortril tablet', origin: 'medicine' },
    });
  });
});

describe('resolveCatalogueReview', () => {
  const defaults = catalogueReviewDefaults({ linkedExisting: false, item, medicine: copy });

  it('overlays pharmacist entries; an entry equal to the default keeps its origin', () => {
    const { values, problems } = resolveCatalogueReview({
      defaults,
      entered: {
        productName: 'PANADOL 500MG TAB',
        pack: ' 10 x 10 ',
        drapRegistrationNumber: '01',
      },
      productFamily: 'PHARMACEUTICAL',
      controlledCandidate: false,
    });
    expect(problems).toEqual([]);
    expect(values.productName).toEqual({ value: 'PANADOL 500MG TAB', origin: 'catalogue' });
    expect(values.pack).toEqual({ value: '10 x 10', origin: 'pharmacist' });
    expect(values.drapRegistrationNumber).toEqual({ value: '01', origin: 'pharmacist' });
  });

  it('names every reason a draft could never publish', () => {
    const { problems } = resolveCatalogueReview({
      defaults: { productName: { value: 'SOSEGON TAB', origin: 'catalogue' } },
      entered: { strength: '5mg/5ml' },
      productFamily: 'PHARMACEUTICAL',
      controlledCandidate: true,
    });
    expect(problems).toEqual([
      'Enter dosageForm, pack before review.',
      'Strength "5mg/5ml" cannot be structured; enter one number and unit, e.g. 500 mg.',
      'Enter the DRAP registration number before review.',
      'This item was filed under NARCOTICS in the default catalogue; record a controlled decision (true or false).',
    ]);
  });

  it('takes only true or false as a decision; front shop needs no registration', () => {
    expect(
      resolveCatalogueReview({
        defaults,
        entered: { controlled: 'maybe' },
        productFamily: 'FRONT_SHOP',
        controlledCandidate: true,
      }).problems
    ).toEqual(['The controlled decision must be true or false.']);
    expect(
      resolveCatalogueReview({
        defaults,
        entered: { controlled: 'FALSE' },
        productFamily: 'FRONT_SHOP',
        controlledCandidate: true,
      })
    ).toMatchObject({ problems: [], values: { controlled: { value: 'false' } } });
  });
});

function draftDb(overrides: { medicine?: unknown; openAssertion?: boolean } = {}) {
  const created: Array<{ data: Record<string, unknown> }> = [];
  const medicine =
    overrides.medicine === undefined
      ? {
          id: 'med-1',
          organizationId: 'org-a',
          productFamily: 'PHARMACEUTICAL',
          ...copy,
          provenance: overrides.openAssertion ? [{ id: 'open' }] : [],
          catalogueProvenance: {
            id: 'prov-1',
            source: 'platform-default',
            catalogueKey: 'pharmacy-default',
            catalogueVersion: 1,
            catalogueVersionId: 'v1',
            sourceKey: 'catalog-27',
            controlledCandidate: false,
            linkedExisting: false,
          },
        }
      : overrides.medicine;
  const db = {
    medicine: { findFirst: vi.fn().mockResolvedValue(medicine) },
    platformMedicineCatalogueItem: { findUnique: vi.fn().mockResolvedValue(item) },
    medicineProvenance: {
      create: vi.fn().mockImplementation(async (args: { data: Record<string, unknown> }) => {
        created.push(args);
        return { id: `a-${created.length}`, ...args.data };
      }),
    },
  };
  return { db: db as unknown as ScopedDb, raw: db, created };
}

describe('draftCatalogueReview', () => {
  const input = {
    organizationId: 'org-a',
    medicineId: 'med-1',
    actorId: 'pharmacist-1',
    values: { drapRegistrationNumber: '012345' },
    now: new Date('2026-11-01T10:00:00.000Z'),
  };

  it('seeds UNREVIEWED assertions in the workbench envelope, attributed by origin', async () => {
    const { db, raw, created } = draftDb();
    const result = await draftCatalogueReview(db, input);

    // Only a medicine awaiting catalogue review, in this organization.
    expect(raw.medicine.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: 'med-1', organizationId: 'org-a', saleable: false }),
      })
    );
    expect(raw.platformMedicineCatalogueItem.findUnique).toHaveBeenCalledWith({
      where: { versionId_sourceKey: { versionId: 'v1', sourceKey: 'catalog-27' } },
    });
    expect(created.map(({ data }) => data.field)).toEqual([
      'productName',
      'brandName',
      'manufacturer',
      'drapRegistrationNumber',
      'strength',
      'dosageForm',
      'pack',
    ]);
    expect(created.every(({ data }) => data.status === 'UNREVIEWED' && !data.reviewer)).toBe(true);
    expect(created[0]!.data).toMatchObject({
      organizationId: 'org-a',
      medicineId: 'med-1',
      source: 'platform-default:pharmacy-default:v1:catalog-27',
      sourceType: 'IMPORT',
      assertedValue: {
        value: 'PANADOL 500MG TAB',
        connectorId: 'platform-default',
        sourceLabel: 'Default catalogue pharmacy-default:v1',
        batchId: `catalogue-review:prov-1:${input.now.getTime()}`,
        rowSourceKey: 'catalog-27',
        rights: CATALOGUE_REVIEW_RIGHTS,
        blockingIssues: [],
      },
    });
    expect(created[3]!.data).toMatchObject({
      source: 'pharmacist:pharmacist-1',
      sourceType: 'USER',
      assertedValue: { value: '012345', connectorId: 'pharmacist-entry' },
    });
    expect(result).toMatchObject({
      medicineId: 'med-1',
      assertionIds: created.map((_, index) => `a-${index + 1}`),
    });
  });

  it('refuses a medicine not awaiting catalogue review', async () => {
    const { db } = draftDb({ medicine: null });
    await expect(draftCatalogueReview(db, input)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('refuses a second draft while assertions are in review', async () => {
    const { db, created } = draftDb({ openAssertion: true });
    await expect(draftCatalogueReview(db, input)).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(created).toEqual([]);
  });

  it('refuses a draft that could never publish, writing nothing', async () => {
    const { db, created } = draftDb();
    await expect(draftCatalogueReview(db, { ...input, values: {} })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: 'Enter the DRAP registration number before review.',
    });
    expect(created).toEqual([]);
  });
});

describe('matchCatalogueMedicine', () => {
  function matchDb(keyed: string[], named: string[]) {
    const db = {
      medicineCatalogueProvenance: {
        findMany: vi.fn().mockResolvedValue(keyed.map((medicineId) => ({ medicineId }))),
      },
      medicine: { findMany: vi.fn().mockResolvedValue(named.map((id) => ({ id }))) },
    };
    return { db: db as unknown as ScopedDb, raw: db };
  }
  const row = {
    organizationId: 'org-a',
    rowSourceKey: 'catalog-0',
    productName: 'X',
    manufacturer: 'Y',
  };

  it('prefers the exact source key', async () => {
    const { db, raw } = matchDb(['med-1'], ['med-2']);
    await expect(matchCatalogueMedicine(db, row)).resolves.toEqual({
      kind: 'match',
      medicineId: 'med-1',
      by: 'sourceKey',
    });
    expect(raw.medicineCatalogueProvenance.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { organizationId: 'org-a', sourceKey: 'catalog-0' } })
    );
    expect(raw.medicine.findMany).not.toHaveBeenCalled();
  });

  it('falls back to one copy by name and manufacturer; several are ambiguous', async () => {
    await expect(matchCatalogueMedicine(matchDb([], ['med-2']).db, row)).resolves.toEqual({
      kind: 'match',
      medicineId: 'med-2',
      by: 'name',
    });
    await expect(matchCatalogueMedicine(matchDb([], ['a', 'b']).db, row)).resolves.toEqual({
      kind: 'ambiguous',
      medicineIds: ['a', 'b'],
    });
    await expect(matchCatalogueMedicine(matchDb([], []).db, row)).resolves.toEqual({
      kind: 'none',
    });
  });

  it('never matches by name without a product name', async () => {
    const { db, raw } = matchDb([], ['med-2']);
    await expect(
      matchCatalogueMedicine(db, { ...row, productName: '   ' })
    ).resolves.toEqual({ kind: 'none' });
    expect(raw.medicine.findMany).not.toHaveBeenCalled();
  });
});
