import { describe, expect, it } from 'vitest';

import { stagingInput } from './staging-input';

const upload = {
  fileName: 'products.csv',
  content: Buffer.from('Product name\nExample\n').toString('base64'),
  branchId: 'branch_1',
};

describe('DEV-912 staging input', () => {
  it('stages a products-only file with no quantity column and no packs-or-units choice', () => {
    expect(stagingInput.safeParse({ ...upload, mapping: { product: 0 } }).success).toBe(true);
  });

  it('still requires the packs-or-units choice when a quantity column is mapped', () => {
    const refused = stagingInput.safeParse({ ...upload, mapping: { product: 0, quantity: 1 } });
    expect(refused.success).toBe(false);
    expect(refused.error?.issues[0]?.path).toEqual(['quantityUnit']);
    expect(
      stagingInput.safeParse({
        ...upload,
        quantityUnit: 'PACKS',
        mapping: { product: 0, quantity: 1 },
      }).success
    ).toBe(true);
  });

  it('still requires the medicine name column', () => {
    expect(stagingInput.safeParse({ ...upload, mapping: {} }).success).toBe(false);
  });
});
