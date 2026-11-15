import { describe, expect, it } from 'vitest';
import { pharmacyMedicineRouter } from '@/server/routers/pharmacy-medicine';
import { pharmacyPrescriptionsRouter } from '@/server/routers/pharmacy-prescriptions';
import { pharmacyPurchasingRouter } from '@/server/routers/pharmacy-purchasing';
import { REORDER_MAX_DRAFT_LINES } from '@/lib/pharmacy/reorder-drafts';

// DEV-145: every array, string and record key a pharmacy router accepts must have
// a business-sized ceiling, so an oversized payload is a validation error before
// any DB work instead of a held worker, a held connection or a bind-limit error.

type ZodLike = { _zod?: { def?: Record<string, unknown> } };
type Check = { check?: string; format?: string; pattern?: RegExp };

const checksOf = (def: Record<string, unknown>): Check[] =>
  ((def.checks as ZodLike[] | undefined) ?? []).map((check) => (check._zod?.def ?? {}) as Check);

// An anchored pattern with only fixed or bounded repeats ({n} / {n,m}) cannot match
// an arbitrarily long string.
const boundedPattern = (pattern: RegExp | undefined) =>
  !!pattern &&
  pattern.source.startsWith('^') &&
  pattern.source.endsWith('$') &&
  !/[*+]|\{\d+,\}/.test(pattern.source.replace(/\\./g, ''));

const isBounded = (def: Record<string, unknown>) =>
  checksOf(def).some(
    (check) =>
      check.check === 'max_length' ||
      check.check === 'length_equals' ||
      (check.check === 'string_format' &&
        (check.format === 'regex' ? boundedPattern(check.pattern) : true))
  );

function unbounded(schema: unknown, path: string, out: string[], seen = new Set<unknown>()) {
  const def = (schema as ZodLike | undefined)?._zod?.def;
  if (!def || seen.has(schema)) return out;
  seen.add(schema);
  const walk = (child: unknown, suffix = '') => unbounded(child, path + suffix, out, seen);
  switch (def.type) {
    case 'string':
      if (!isBounded(def)) out.push(`string ${path}`);
      break;
    case 'array':
      if (!isBounded(def)) out.push(`array ${path}`);
      walk(def.element, '[]');
      break;
    case 'object':
      for (const [key, child] of Object.entries(def.shape as Record<string, unknown>))
        walk(child, `.${key}`);
      break;
    case 'record':
      walk(def.keyType, '{key}');
      walk(def.valueType, '{}');
      break;
    case 'union':
      (def.options as unknown[]).forEach((option, index) => walk(option, `|${index}`));
      break;
    case 'intersection':
      walk(def.left);
      walk(def.right);
      break;
    case 'pipe':
      walk(def.in);
      walk(def.out);
      break;
    case 'tuple':
      (def.items as unknown[]).forEach((item, index) => walk(item, `[${index}]`));
      break;
    case 'lazy':
      walk((def.getter as () => unknown)());
      break;
    default:
      if ('innerType' in def) walk(def.innerType);
  }
  return out;
}

type ProcedureLike = { _def: { inputs?: unknown[] } };
const routers = {
  pharmacyPurchasing: pharmacyPurchasingRouter,
  pharmacyPrescriptions: pharmacyPrescriptionsRouter,
  pharmacyMedicine: pharmacyMedicineRouter,
} as const;

function procedures(router: unknown) {
  return Object.entries(
    (router as { _def: { procedures: Record<string, ProcedureLike> } })._def.procedures
  );
}

function inputOf(router: unknown, name: string) {
  const procedure = procedures(router).find(([procedureName]) => procedureName === name)?.[1];
  const [input] = procedure?._def.inputs ?? [];
  return input as { safeParse: (value: unknown) => { success: boolean } };
}

describe('pharmacy router input bounds', () => {
  for (const [routerName, router] of Object.entries(routers)) {
    it(`${routerName} caps every array, string and record key it accepts`, () => {
      const found = procedures(router).flatMap(([name, procedure]) =>
        (procedure._def.inputs ?? []).flatMap((input) => unbounded(input, name, []))
      );
      expect(found).toEqual([]);
    });
  }

  const line = {
    requisitionLineId: 'line-1',
    pricePerPackMinor: 100,
    forecastSellThroughPacks: 1,
    canonicalUnitsPerPack: 10,
  };
  const quote = (count: number) => ({
    requisitionId: 'req-1',
    supplierId: 'sup-1',
    quotedAt: new Date('2026-11-01'),
    validUntil: new Date('2026-11-30'),
    lines: Array.from({ length: count }, () => line),
  });

  it('rejects an oversized quote before any DB work and accepts a business-sized one', () => {
    const input = inputOf(pharmacyPurchasingRouter, 'recordQuote');
    expect(input.safeParse(quote(100)).success).toBe(true);
    expect(input.safeParse(quote(101)).success).toBe(false);
  });

  const orderLine = {
    medicineId: 'medicine-1',
    packLevelId: 'pack-1',
    orderedPacks: 1,
    canonicalUnitsPerPack: 10,
    listPricePerPackMinor: 100,
  };
  const order = (count: number) => ({
    reference: 'PO-1',
    supplierId: 'sup-1',
    lines: Array.from({ length: count }, () => orderLine),
  });

  it('accepts a purchase order as large as the largest reorder draft, and no larger', () => {
    const input = inputOf(pharmacyPurchasingRouter, 'createPurchaseOrder');
    expect(input.safeParse(order(REORDER_MAX_DRAFT_LINES)).success).toBe(true);
    expect(input.safeParse(order(REORDER_MAX_DRAFT_LINES + 1)).success).toBe(false);
  });

  const serializedPack = (index: number) => ({
    medicineId: 'medicine-1',
    packLevelId: 'pack-1',
    batchNumber: 'B1',
    printedExpiry: new Date('2028-01-01'),
    expiryPrecision: 'MONTH' as const,
    printedMrpMinor: 500,
    canonicalUnitsPerPack: 1,
    receivedPacks: 1,
    invoicedPricePerPackMinor: 400,
    stockLocationId: 'loc-1',
    gtin: '08901234567890',
    serialNumber: `S${index}`,
  });
  const receipt = (count: number) => ({
    reference: 'GRN-1',
    branchId: 'branch-1',
    supplierId: 'sup-1',
    purchaseOrderId: 'po-1',
    supplierInvoiceRef: 'INV-1',
    supplierInvoiceDate: new Date('2026-11-01'),
    warrantyEvidenceRef: 'warranty on invoice',
    receivedAt: new Date('2026-11-02'),
    lines: Array.from({ length: count }, (_, index) => serializedPack(index)),
  });

  it('receives a large serialized invoice in one receipt, up to the hard invoice ceiling', () => {
    const input = inputOf(pharmacyPurchasingRouter, 'createGoodsReceipt');
    expect(input.safeParse(receipt(1_000)).success).toBe(true);
    expect(input.safeParse(receipt(20_000)).success).toBe(true);
    expect(input.safeParse(receipt(20_001)).success).toBe(false);
  });

  it('rejects an oversized record ID', () => {
    const input = inputOf(pharmacyPurchasingRouter, 'submitRequisition');
    expect(input.safeParse({ requisitionId: 'r'.repeat(200) }).success).toBe(true);
    expect(input.safeParse({ requisitionId: 'r'.repeat(201) }).success).toBe(false);
  });
});
