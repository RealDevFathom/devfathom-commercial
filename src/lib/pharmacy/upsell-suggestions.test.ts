import { describe, expect, it } from 'vitest';

import {
  findUpsellSuggestions,
  firedUpsellRules,
  isUpsellSuggestible,
  ruleSuggesting,
  suggestibleMedicineWhere,
  UPSELL_RULES,
  type UpsellCatalogueClass,
} from './upsell-suggestions';

const scope = { organizationId: 'org-a', branchId: 'branch-a' };

const safe: UpsellCatalogueClass = {
  productFamily: 'DEVICE',
  rx: false,
  otc: false,
  restricted: false,
  controlled: false,
  highAlert: false,
  saleable: true,
};

function inhaler(overrides: Record<string, unknown> = {}) {
  return {
    id: 'inhaler',
    productName: 'Salbutamol Inhaler',
    brandName: null,
    strengths: [{ ingredient: { name: 'Salbutamol' } }],
    presentations: [{ dosageForm: 'Inhaler', presentation: '200 doses' }],
    ...overrides,
  };
}

function lot(id: string, medicine: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  return {
    id: `lot-${id}`,
    printedMrpMinor: 45_000,
    balances: [{ onHandUnits: 3 }],
    batch: {
      medicine: { id, productName: 'Spacer Device', brandName: null, ...safe, ...medicine },
    },
    packLevel: { presentation: { id: `presentation-${id}`, presentation: 'Each' } },
    ...extra,
  };
}

function dbWith(triggers: unknown[], lots: unknown[]) {
  const calls: { lotWhere?: unknown } = {};
  return {
    calls,
    db: {
      medicine: { findMany: async () => triggers },
      pharmacyInventoryLot: {
        findMany: async (args: { where: unknown }) => {
          calls.lotWhere = args.where;
          return lots;
        },
      },
    },
  };
}

describe('#730 upsell catalogue-class gate', () => {
  it('admits saleable devices, front-shop and OTC items', () => {
    expect(isUpsellSuggestible(safe)).toBe(true);
    expect(isUpsellSuggestible({ ...safe, productFamily: 'FRONT_SHOP' })).toBe(true);
    expect(isUpsellSuggestible({ ...safe, productFamily: 'PHARMACEUTICAL', otc: true })).toBe(true);
  });

  it.each([
    ['prescription-only', { rx: true }],
    ['controlled', { controlled: true }],
    ['restricted', { restricted: true }],
    ['high-alert', { highAlert: true }],
    ['unsaleable', { saleable: false }],
    ['OTC but prescription-only', { otc: true, rx: true }],
    ['OTC but controlled', { otc: true, controlled: true }],
  ])('never suggests a %s item', (_label, flags) => {
    expect(isUpsellSuggestible({ ...safe, ...flags })).toBe(false);
  });

  it('refuses a pharmaceutical or biological not classed OTC', () => {
    expect(isUpsellSuggestible({ ...safe, productFamily: 'PHARMACEUTICAL' })).toBe(false);
    expect(isUpsellSuggestible({ ...safe, productFamily: 'BIOLOGICAL' })).toBe(false);
    expect(isUpsellSuggestible({ ...safe, productFamily: 'ALTERNATIVE' })).toBe(false);
  });

  it('pins the database predicate to the same exclusions', () => {
    expect(suggestibleMedicineWhere).toMatchObject({
      saleable: true,
      rx: false,
      controlled: false,
      restricted: false,
      highAlert: false,
    });
  });
});

describe('#730 rule matching', () => {
  it('fires on ingredient, dosage form and name, once per rule', () => {
    const fired = firedUpsellRules([
      {
        medicineId: 'a',
        productName: 'Amoxil',
        brandName: null,
        ingredientNames: ['Amoxicillin Trihydrate'],
        forms: ['Oral Suspension'],
      },
      {
        medicineId: 'b',
        productName: 'Augmentin',
        brandName: null,
        ingredientNames: ['Amoxicillin'],
        forms: ['Tablet'],
      },
    ]).map((rule) => rule.id);
    expect(fired).toEqual(['antibiotic-probiotic', 'oral-liquid-measure']);
  });

  it('fires nothing for an unrelated item', () => {
    expect(
      firedUpsellRules([
        {
          medicineId: 'a',
          productName: 'Vitamin C',
          brandName: null,
          ingredientNames: ['Ascorbic acid'],
          forms: ['Tablet'],
        },
      ])
    ).toEqual([]);
  });

  it('matches suggestion keywords case-insensitively on product or brand name', () => {
    const rules = UPSELL_RULES.filter((rule) => rule.id === 'glucometer-consumables');
    const strips = ruleSuggesting({ productName: 'ACCU-CHEK Test Strips', brandName: null }, rules);
    expect(strips?.id).toBe('glucometer-consumables');
    const lancets = ruleSuggesting({ productName: 'Generic', brandName: 'Safety Lancets' }, rules);
    expect(lancets).not.toBe(null);
    expect(ruleSuggesting({ productName: 'Insulin pen', brandName: null }, rules)).toBe(null);
  });

  it('does not match ORS keywords inside unrelated words', () => {
    const rules = UPSELL_RULES.filter((rule) => rule.id === 'diarrhoea-ors');
    const flavors = ruleSuggesting({ productName: 'Flavors syrup base', brandName: null }, rules);
    expect(flavors).toBe(null);
  });

  it('every rule suggests at least one keyword and has a reason', () => {
    for (const rule of UPSELL_RULES) {
      expect(rule.suggest.length).toBeGreaterThan(0);
      expect(rule.reason.trim()).not.toBe('');
      expect(new Set(UPSELL_RULES.map((entry) => entry.id)).size).toBe(UPSELL_RULES.length);
    }
  });
});

describe('#730 findUpsellSuggestions', () => {
  it('returns nothing and skips the database for an empty bill', async () => {
    const { db, calls } = dbWith([], []);
    expect(await findUpsellSuggestions(db as never, scope, { medicineIds: [] })).toEqual([]);
    expect(calls.lotWhere).toBeUndefined();
  });

  it('does not query stock when no rule fires', async () => {
    const vitamin = inhaler({
      productName: 'Vitamin C',
      presentations: [{ dosageForm: 'Tablet', presentation: 'Strip' }],
    });
    const { db, calls } = dbWith([vitamin], []);
    const rows = await findUpsellSuggestions(db as never, scope, { medicineIds: ['inhaler'] });
    expect(rows).toEqual([]);
    expect(calls.lotWhere).toBeUndefined();
  });

  it('suggests an in-stock complementary device with its reason', async () => {
    const { db } = dbWith([inhaler()], [lot('spacer', {})]);
    const rows = await findUpsellSuggestions(db as never, scope, { medicineIds: ['inhaler'] });
    expect(rows).toEqual([
      {
        medicineId: 'spacer',
        presentationId: 'presentation-spacer',
        displayName: 'Spacer Device',
        presentation: 'Each',
        availableCanonicalUnits: 3,
        packMrpMinor: 45_000,
        ruleId: 'inhaler-spacer',
        reason: 'Often bought with inhalers',
      },
    ]);
  });

  it('sends the class exclusions, branch scope and stock predicates to the database', async () => {
    const at = new Date('2026-10-31T00:00:00.000Z');
    const { db, calls } = dbWith([inhaler()], []);
    await findUpsellSuggestions(db as never, scope, { medicineIds: ['inhaler'], at });
    expect(calls.lotWhere).toMatchObject({
      organizationId: 'org-a',
      branchId: 'branch-a',
      receivedAt: { not: null },
      balances: { some: { disposition: 'AVAILABLE', onHandUnits: { gt: 0 } } },
      batch: {
        medicineId: { notIn: ['inhaler'] },
        state: 'ACTIVE',
        expiresAt: { gt: at },
        medicine: {
          organizationId: 'org-a',
          saleable: true,
          rx: false,
          controlled: false,
          restricted: false,
          highAlert: false,
        },
      },
    });
  });

  it('re-checks the class gate in memory even if the database returns a forbidden item', async () => {
    const { db } = dbWith(
      [inhaler()],
      [
        lot('rx-spacer', { rx: true }),
        lot('controlled-spacer', { controlled: true }),
        lot('restricted-spacer', { restricted: true }),
        lot('high-alert-spacer', { highAlert: true }),
        lot('pharma-spacer', { productFamily: 'PHARMACEUTICAL', otc: false }),
      ]
    );
    expect(await findUpsellSuggestions(db as never, scope, { medicineIds: ['inhaler'] })).toEqual(
      []
    );
  });

  it('never suggests an item already on the bill and lists each medicine once', async () => {
    const { db } = dbWith(
      [inhaler()],
      [
        lot('inhaler', { productName: 'Spacer bundle' }),
        lot('spacer', {}),
        lot('spacer', {}, { id: 'lot-spacer-2' }),
      ]
    );
    const rows = await findUpsellSuggestions(db as never, scope, { medicineIds: ['inhaler'] });
    expect(rows.map((row) => row.medicineId)).toEqual(['spacer']);
  });

  it('ignores a candidate that matches no fired rule', async () => {
    const { db } = dbWith(
      [inhaler()],
      [lot('thermo', { productName: 'Digital Thermometer' })]
    );
    expect(await findUpsellSuggestions(db as never, scope, { medicineIds: ['inhaler'] })).toEqual(
      []
    );
  });

  it('caps the result at the requested limit', async () => {
    const { db } = dbWith(
      [inhaler()],
      ['a', 'b', 'c'].map((id) => lot(id, { productName: `Spacer ${id}` }))
    );
    const rows = await findUpsellSuggestions(db as never, scope, {
      medicineIds: ['inhaler'],
      limit: 2,
    });
    expect(rows.map((row) => row.displayName)).toEqual(['Spacer a', 'Spacer b']);
  });
});
