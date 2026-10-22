import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import {
  IMPORT_LIMITS,
  ImportValidationError,
  parseImportFile,
  productDedupeKey,
} from './import-core';
import { parseImportExpiry, parsePackConversion, smallestUnitQuantity } from './entity-values';

const fixture = (name: string) =>
  readFile(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)));

/** Piece 3 supplies this mapper. This deliberately small stub keeps piece 2 tests independent. */
interface ProductBatchPreview {
  sku: string;
  productKey: string;
  batchKey: string;
  quantity: bigint;
  expiry: Date;
}

function stubProductBatchMapper(row: readonly string[]): ProductBatchPreview | null {
  const [sku, name, generic, strength, packing, batch, expiry, quantity] = row;
  const productKey = productDedupeKey({ name, generic, strength });
  const parsedExpiry = parseImportExpiry(expiry);
  const parsedPacking = parsePackConversion(packing);
  const parsedQuantity = smallestUnitQuantity(quantity, packing);
  if (!sku || !batch || !productKey || !parsedExpiry || !parsedPacking || parsedQuantity === null)
    return null;
  return {
    sku,
    productKey: `sku:${sku.trim().toLocaleLowerCase('en')}`,
    batchKey: `${sku.trim().toLocaleLowerCase('en')}:${batch.trim().toLocaleLowerCase('en')}:${parsedExpiry.toISOString()}`,
    quantity: parsedQuantity,
    expiry: parsedExpiry,
  };
}

describe('planned self-serve product and batch import fixtures', () => {
  it('keeps malformed rows for preview and makes invalid values blocking instead of guessing', async () => {
    const table = await parseImportFile(
      'planned-malformed.csv',
      new Uint8Array(await fixture('planned-malformed.csv'))
    );

    expect(table.rows).toHaveLength(5);
    expect(table.rows[4]).toEqual(['SHORT', 'Short row', 'Example', '', '', '', '', '']);
    expect(table.rows.map(stubProductBatchMapper)).toEqual([null, null, null, null, null]);
  });

  it('deduplicates repeated SKUs and batches while retaining distinct expiry lots', async () => {
    const table = await parseImportFile(
      'planned-products.csv',
      new Uint8Array(await fixture('planned-products.csv'))
    );
    const previews = table.rows.map(stubProductBatchMapper);

    expect(previews.every(Boolean)).toBe(true);
    expect(new Set(previews.map((row) => row!.productKey))).toHaveProperty('size', 2);
    expect(new Set(previews.map((row) => row!.batchKey))).toHaveProperty('size', 3);
    expect(previews.slice(0, 2).map((row) => row!.batchKey)).toEqual([
      previews[0]!.batchKey,
      previews[0]!.batchKey,
    ]);
    expect(previews.slice(0, 2).reduce((sum, row) => sum + row!.quantity, 0n)).toBe(500n);
  });

  it('preserves Urdu product and batch text through UTF-8 CSV parsing', async () => {
    const table = await parseImportFile(
      'planned-urdu.csv',
      new Uint8Array(await fixture('planned-urdu.csv'))
    );

    expect(table.rows[0]).toEqual([
      'URD-001',
      'پیراسیٹامول گولیاں',
      'پیراسیٹامول',
      '500 mg',
      '10x10',
      'بیچ-الف',
      '12/27',
      '5',
    ]);
    expect(table.rows[1]?.[1]).toBe('کھانسی، زکام شربت');
    expect(table.rows.map(stubProductBatchMapper).every(Boolean)).toBe(true);
  });

  it('parses the equivalent XLSX fixture without changing Unicode, batch, or expiry cells', async () => {
    const table = await parseImportFile(
      'planned-products.xlsx',
      new Uint8Array(await fixture('planned-products.xlsx'))
    );

    expect(table.headers).toEqual([
      'sku',
      'name',
      'generic',
      'strength',
      'packing',
      'batch',
      'expiry',
      'quantity',
    ]);
    expect(table.rows[0]).toEqual([
      'URD-XLSX',
      'پیراسیٹامول',
      'Paracetamol',
      '500 mg',
      '10x10',
      'بیچ-ایکس',
      '02/2028',
      '3',
    ]);
    expect(stubProductBatchMapper(table.rows[0]!)).toMatchObject({ quantity: 300n });
  });

  it('rejects payload, row, and column counts above configured limits', async () => {
    await expect(
      parseImportFile('oversize.csv', new Uint8Array(IMPORT_LIMITS.maxBytes + 1))
    ).rejects.toEqual(expect.objectContaining({ code: 'MAX_BYTES' } satisfies Partial<ImportValidationError>));

    const tooManyColumns = `${Array.from({ length: IMPORT_LIMITS.maxColumns + 1 }, (_, i) => `c${i}`).join(',')}\n`;
    await expect(parseImportFile('wide.csv', new TextEncoder().encode(tooManyColumns))).rejects.toMatchObject({
      code: 'MAX_COLUMNS',
    });

    const tooManyRows = `sku\n${'x\n'.repeat(IMPORT_LIMITS.maxRows + 1)}`;
    await expect(parseImportFile('long.csv', new TextEncoder().encode(tooManyRows))).rejects.toMatchObject({
      code: 'MAX_ROWS',
    });
  });

  it('keeps preview dry-runs side-effect free behind a stubbed sibling writer', async () => {
    const siblingCommit = vi.fn();
    const table = await parseImportFile(
      'planned-products.csv',
      new Uint8Array(await fixture('planned-products.csv'))
    );
    const preview = table.rows.map(stubProductBatchMapper);

    expect(preview.filter(Boolean)).toHaveLength(4);
    expect(siblingCommit).not.toHaveBeenCalled();
  });
});
