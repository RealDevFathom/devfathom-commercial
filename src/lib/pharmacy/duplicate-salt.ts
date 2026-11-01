/**
 * #724 Phase 1 — duplicate active-salt detection for the counter.
 *
 * Pure and database-free so the counter console (client) and the
 * acknowledgement mutation (server) agree on exactly the same groups.
 *
 * The data source is the same ingredient graph the substitute finder walks
 * (`MedicineStrengthComponent -> Ingredient`), so no licensed interaction
 * reference is needed. This is a duplicate-therapy notice, not an interaction
 * check: two different medicines on one bill that share an active ingredient
 * (two paracetamol brands) raise ONE warning per shared ingredient.
 *
 * The warning never blocks a sale. Two lines of the SAME medicine (a second
 * batch, a split pack) are not a duplicate-salt case and raise nothing here.
 */

export type DuplicateSaltIngredient = { ingredientId: string; name: string };

export type DuplicateSaltLine = {
  ref: string;
  medicineId: string;
  displayName: string;
  activeIngredients: readonly DuplicateSaltIngredient[];
};

export type DuplicateSaltGroup = {
  /** Stable, tenant-catalog-independent identity: the normalized salt name. */
  ingredientKey: string;
  ingredientName: string;
  /** One entry per distinct medicine, in cart order (first line kept). */
  medicines: Array<{ medicineId: string; displayName: string; ref: string }>;
};

export function duplicateSaltIngredientKey(name: string): string {
  return name.trim().replace(/\s+/g, ' ').toLocaleLowerCase('en');
}

/** Match the audited medicines and representative sale lines, regardless of order. */
export function duplicateSaltGroupFingerprint(
  medicines: readonly Pick<DuplicateSaltGroup['medicines'][number], 'medicineId' | 'ref'>[]
): string {
  return JSON.stringify(
    medicines.map(({ medicineId, ref }) => JSON.stringify([medicineId, ref])).sort()
  );
}

/**
 * Every active ingredient shared by two or more DISTINCT medicines on the bill,
 * ordered by ingredient key so the result is deterministic.
 */
export function duplicateSaltGroups(lines: readonly DuplicateSaltLine[]): DuplicateSaltGroup[] {
  const byKey = new Map<string, DuplicateSaltGroup>();
  for (const line of lines) {
    const seenOnLine = new Set<string>();
    for (const ingredient of line.activeIngredients) {
      const ingredientKey = duplicateSaltIngredientKey(ingredient.name);
      if (!ingredientKey || seenOnLine.has(ingredientKey)) continue;
      seenOnLine.add(ingredientKey);
      const group = byKey.get(ingredientKey) ?? {
        ingredientKey,
        ingredientName: ingredient.name.trim(),
        medicines: [],
      };
      if (!group.medicines.some((medicine) => medicine.medicineId === line.medicineId)) {
        group.medicines.push({
          medicineId: line.medicineId,
          displayName: line.displayName,
          ref: line.ref,
        });
      }
      byKey.set(ingredientKey, group);
    }
  }
  return [...byKey.values()]
    .filter((group) => group.medicines.length > 1)
    .sort((left, right) => left.ingredientKey.localeCompare(right.ingredientKey, 'en'));
}
