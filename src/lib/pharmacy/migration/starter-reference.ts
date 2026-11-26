import { z } from 'zod';
import { isLegacyControlledClass, legacyProductNameKey } from './legacy-class';

// Both arguments must already be approved, catalogue-only projections. Keep ICode as text:
// numeric coercion loses leading zeroes and can bind a medicine to a different product.
const label = z.string().trim().min(1);
const fields = {
  sourceId: label,
  legacyCode: label.nullable(),
  name: label,
  packSize: z.number().int().positive().max(2147483647).nullable(),
  class: label.nullable(),
  verifiedGeneric: label.nullable(),
  manufacturerLabel: label.nullable(),
  active: z.boolean(),
  controlled: z.boolean(),
};
const reference = z.strictObject(fields);
const overlay = z.strictObject({
  sourceId: fields.sourceId,
  name: fields.name,
  packSize: fields.packSize.optional(),
  verifiedGeneric: fields.verifiedGeneric.optional(),
  manufacturerLabel: fields.manufacturerLabel.optional(),
});
export type StarterProduct = z.infer<typeof reference>;

function bySource<T extends { sourceId: string }>(rows: T[]) {
  const result = new Map<string, T>();
  for (const item of rows) {
    if (result.has(item.sourceId)) throw new Error('Duplicate starter source identity.');
    result.set(item.sourceId, item);
  }
  return result;
}

export function validateStarterCatalogue(input: unknown) {
  const rows = z.array(reference).min(1).parse(input);
  bySource(rows);
  if (rows.some((row) => isLegacyControlledClass(row.class) && !row.controlled))
    throw new Error('NARCOTICS products must remain controlled.');
  return rows;
}

export function buildStarterCatalogue(source: unknown, verified: unknown) {
  const products = bySource(z.array(reference).min(1).parse(source));
  const reconciliation = { matched: 0, differentName: 0, absentCode: 0 };
  for (const patch of bySource(z.array(overlay).parse(verified)).values()) {
    const product = products.get(patch.sourceId);
    if (!product) reconciliation.absentCode++;
    else if (legacyProductNameKey(product.name) !== legacyProductNameKey(patch.name))
      reconciliation.differentName++;
    else {
      reconciliation.matched++;
      product.packSize = patch.packSize ?? product.packSize;
      product.verifiedGeneric = patch.verifiedGeneric ?? product.verifiedGeneric;
      product.manufacturerLabel = patch.manufacturerLabel ?? product.manufacturerLabel;
    }
  }
  const rows = Array.from(products.values(), (product) => ({
    ...product,
    controlled: product.controlled || isLegacyControlledClass(product.class),
  })).sort((a, b) => (a.sourceId < b.sourceId ? -1 : a.sourceId > b.sourceId ? 1 : 0));
  return { rows: validateStarterCatalogue(rows), reconciliation };
}
