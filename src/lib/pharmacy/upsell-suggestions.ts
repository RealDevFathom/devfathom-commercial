import type { Prisma } from '@/generated/prisma/client';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';

/**
 * Pharmacy counter upsell suggestions (#730).
 *
 * Deterministic, rule-based complementary-item suggestions. A rule is fired by
 * a catalogue fact of an item already on the bill (ingredient, dosage form or
 * name) and proposes in-stock items from the *suggestible* catalogue classes
 * only. A suggestion is never clinical advice and never mutates a sale: the
 * operator still searches, prices and adds the item through the normal path.
 *
 * Safety invariant: a prescription-only, controlled, restricted or high-alert
 * medicine is NEVER suggested. The rule is enforced twice — in the database
 * predicate and again in memory — so neither a rule edit nor a loose query
 * can let one through.
 */

export type UpsellCatalogueClass = {
  productFamily: 'PHARMACEUTICAL' | 'BIOLOGICAL' | 'DEVICE' | 'ALTERNATIVE' | 'FRONT_SHOP';
  rx: boolean;
  otc: boolean;
  restricted: boolean;
  controlled: boolean;
  highAlert: boolean;
  saleable: boolean;
};

export type UpsellRule = {
  id: string;
  /** The operator-facing reason shown next to the suggestion. */
  reason: string;
  trigger: {
    /** Matched (substring, case-insensitive) against the item's ingredient names. */
    ingredients?: readonly string[];
    /** Matched against the item's dosage forms and presentation descriptions. */
    forms?: readonly string[];
    /** Matched against the item's product and brand names. */
    names?: readonly string[];
  };
  /** A candidate is suggested when its product or brand name contains one of these. */
  suggest: readonly string[];
};

export const UPSELL_RULES: readonly UpsellRule[] = [
  {
    id: 'inhaler-spacer',
    reason: 'Often bought with inhalers',
    trigger: { forms: ['inhaler', 'inhalation', 'aerosol'] },
    suggest: ['spacer', 'aerochamber'],
  },
  {
    id: 'glucometer-consumables',
    reason: 'Consumables for glucose meters',
    trigger: { names: ['glucometer', 'glucose meter'] },
    suggest: ['test strip', 'lancet', 'alcohol swab'],
  },
  {
    id: 'insulin-pen-needles',
    reason: 'Needles and swabs for insulin',
    trigger: { ingredients: ['insulin'] },
    suggest: ['pen needle', 'insulin syringe', 'alcohol swab'],
  },
  {
    id: 'antibiotic-probiotic',
    reason: 'Commonly paired with antibiotic courses',
    trigger: {
      ingredients: [
        'amoxicillin',
        'amoxycillin',
        'azithromycin',
        'cefixime',
        'cefuroxime',
        'cefadroxil',
        'cephalexin',
        'cefalexin',
        'ciprofloxacin',
        'clarithromycin',
        'doxycycline',
        'levofloxacin',
        'metronidazole',
      ],
    },
    suggest: ['probiotic'],
  },
  {
    id: 'diarrhoea-ors',
    reason: 'Rehydration alongside anti-diarrhoeals',
    trigger: { ingredients: ['loperamide', 'racecadotril', 'nifuroxazide'] },
    suggest: ['oral rehydration', 'ors sachet'],
  },
  {
    id: 'oral-liquid-measure',
    reason: 'Accurate dosing for oral liquids',
    trigger: { forms: ['syrup', 'suspension', 'oral solution', 'oral drops', 'elixir'] },
    suggest: ['measuring cup', 'oral syringe', 'dosing spoon', 'dropper'],
  },
  {
    id: 'antiseptic-dressing',
    reason: 'Dressings alongside wound antiseptics',
    trigger: { ingredients: ['povidone', 'chlorhexidine', 'hydrogen peroxide'] },
    suggest: ['bandage', 'gauze', 'plaster', 'dressing', 'cotton'],
  },
  {
    id: 'fever-thermometer',
    reason: 'Monitor temperature alongside fever relief',
    trigger: { ingredients: ['paracetamol', 'acetaminophen'] },
    suggest: ['thermometer'],
  },
  {
    id: 'nebuliser-kit',
    reason: 'Masks and kits for nebuliser solutions',
    trigger: { forms: ['nebuliser', 'nebulizer', 'respirator solution'] },
    suggest: ['nebuliser mask', 'nebulizer mask', 'nebuliser kit', 'nebulizer kit'],
  },
];

const SUGGESTIBLE_FAMILIES = ['FRONT_SHOP', 'DEVICE'] as const;

/**
 * The catalogue classes an upsell may come from: saleable, never Rx-only,
 * controlled, restricted or high-alert, and either a front-shop/device item
 * or a medicine explicitly classed OTC.
 */
export function isUpsellSuggestible(item: UpsellCatalogueClass) {
  if (!item.saleable || item.rx || item.controlled || item.restricted || item.highAlert) {
    return false;
  }
  return item.otc || (SUGGESTIBLE_FAMILIES as readonly string[]).includes(item.productFamily);
}

/** The same rule, as a Prisma predicate. Kept beside the in-memory check on purpose. */
export const suggestibleMedicineWhere = {
  saleable: true,
  rx: false,
  controlled: false,
  restricted: false,
  highAlert: false,
  OR: [{ otc: true }, { productFamily: { in: [...SUGGESTIBLE_FAMILIES] } }],
} satisfies Prisma.MedicineWhereInput;

function normalized(value: string | null | undefined) {
  return ` ${(value ?? '').trim().toLocaleLowerCase('en').replace(/\s+/g, ' ')} `;
}

function anyContains(haystacks: readonly string[], needles: readonly string[] | undefined) {
  if (!needles?.length) return false;
  return haystacks.some((haystack) =>
    needles.some((needle) => haystack.includes(needle.toLocaleLowerCase('en')))
  );
}

export type UpsellTrigger = {
  medicineId: string;
  productName: string;
  brandName: string | null;
  ingredientNames: readonly string[];
  forms: readonly (string | null)[];
};

/** The rules a set of bill items fires, in rule order, each at most once. */
export function firedUpsellRules(
  triggers: readonly UpsellTrigger[],
  rules: readonly UpsellRule[] = UPSELL_RULES
) {
  return rules.filter((rule) =>
    triggers.some((item) => {
      const names = [normalized(item.productName), normalized(item.brandName)];
      const ingredients = item.ingredientNames.map(normalized);
      const forms = item.forms.map(normalized);
      return (
        anyContains(ingredients, rule.trigger.ingredients) ||
        anyContains(forms, rule.trigger.forms) ||
        anyContains(names, rule.trigger.names)
      );
    })
  );
}

/** The first fired rule whose suggestion keywords match the candidate's names. */
export function ruleSuggesting(
  candidate: { productName: string; brandName: string | null },
  rules: readonly UpsellRule[]
) {
  const names = [normalized(candidate.productName), normalized(candidate.brandName)];
  return rules.find((rule) => anyContains(names, rule.suggest)) ?? null;
}

export type UpsellSuggestion = {
  medicineId: string;
  presentationId: string;
  displayName: string;
  presentation: string;
  availableCanonicalUnits: number;
  packMrpMinor: number;
  ruleId: string;
  reason: string;
};

export const UPSELL_MAX_TRIGGERS = 50;
export const UPSELL_DEFAULT_LIMIT = 5;

const candidateArgs = {
  include: {
    balances: { where: { disposition: 'AVAILABLE' as const, onHandUnits: { gt: 0 } } },
    batch: { include: { medicine: true } },
    packLevel: { include: { presentation: true } },
  },
} satisfies Prisma.PharmacyInventoryLotDefaultArgs;

type CandidateLot = Prisma.PharmacyInventoryLotGetPayload<typeof candidateArgs>;

/**
 * #730: complementary in-stock items for the medicines on the bill.
 *
 * Read-only and branch-scoped. Items already on the bill are never suggested,
 * and each suggested medicine appears once (its earliest-expiring lot).
 */
export async function findUpsellSuggestions(
  db: ScopedDb,
  scope: { organizationId: string; branchId: string },
  input: { medicineIds: readonly string[]; limit?: number; at?: Date }
): Promise<UpsellSuggestion[]> {
  const at = input.at ?? new Date();
  const limit = Math.max(1, Math.min(input.limit ?? UPSELL_DEFAULT_LIMIT, 20));
  const medicineIds = [...new Set(input.medicineIds)].slice(0, UPSELL_MAX_TRIGGERS);
  if (medicineIds.length === 0) return [];

  const triggers = await db.medicine.findMany({
    where: { organizationId: scope.organizationId, id: { in: medicineIds } },
    select: {
      id: true,
      productName: true,
      brandName: true,
      strengths: { select: { ingredient: { select: { name: true } } } },
      presentations: { select: { dosageForm: true, presentation: true } },
    },
  });
  const rules = firedUpsellRules(
    triggers.map((medicine) => ({
      medicineId: medicine.id,
      productName: medicine.productName,
      brandName: medicine.brandName,
      ingredientNames: medicine.strengths.map((strength) => strength.ingredient.name),
      forms: medicine.presentations.flatMap((presentation) => [
        presentation.dosageForm,
        presentation.presentation,
      ]),
    }))
  );
  if (rules.length === 0) return [];

  const keywords = [...new Set(rules.flatMap((rule) => rule.suggest.map((word) => word.trim())))];
  const lots: CandidateLot[] = await db.pharmacyInventoryLot.findMany({
    where: {
      organizationId: scope.organizationId,
      branchId: scope.branchId,
      receivedAt: { not: null },
      batch: {
        medicineId: { notIn: medicineIds },
        state: 'ACTIVE',
        expiresAt: { gt: at },
        medicine: {
          organizationId: scope.organizationId,
          ...suggestibleMedicineWhere,
          AND: [
            {
              OR: keywords.flatMap((word) => [
                { productName: { contains: word, mode: 'insensitive' as const } },
                { brandName: { contains: word, mode: 'insensitive' as const } },
              ]),
            },
          ],
        },
      },
      balances: { some: { disposition: 'AVAILABLE', onHandUnits: { gt: 0 } } },
    },
    orderBy: [{ batch: { expiresAt: 'asc' } }, { id: 'asc' }],
    take: 200,
    ...candidateArgs,
  });

  const excluded = new Set(medicineIds);
  const seen = new Set<string>();
  const suggestions: UpsellSuggestion[] = [];
  for (const lot of lots) {
    const medicine = lot.batch.medicine;
    if (excluded.has(medicine.id) || seen.has(medicine.id)) continue;
    // Defence in depth: the class gate is re-checked on the loaded row.
    if (!isUpsellSuggestible(medicine)) continue;
    const rule = ruleSuggesting(medicine, rules);
    if (!rule) continue;
    const availableCanonicalUnits = lot.balances.reduce(
      (total, balance) => total + balance.onHandUnits,
      0
    );
    if (availableCanonicalUnits <= 0) continue;
    seen.add(medicine.id);
    suggestions.push({
      medicineId: medicine.id,
      presentationId: lot.packLevel.presentation.id,
      displayName: medicine.productName,
      presentation: lot.packLevel.presentation.presentation,
      availableCanonicalUnits,
      packMrpMinor: lot.printedMrpMinor,
      ruleId: rule.id,
      reason: rule.reason,
    });
  }

  const ruleOrder = new Map(rules.map((rule, index) => [rule.id, index]));
  return suggestions
    .sort(
      (left, right) =>
        (ruleOrder.get(left.ruleId) ?? 0) - (ruleOrder.get(right.ruleId) ?? 0) ||
        left.displayName.localeCompare(right.displayName, 'en') ||
        left.medicineId.localeCompare(right.medicineId, 'en')
    )
    .slice(0, limit);
}
