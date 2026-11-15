import { describe, expect, it } from 'vitest';

import { PurchasingValidationError, purchasingOutcome } from './console';

const DUPLICATE =
  'This GTIN and serial were already received in this pharmacy. Treat it as a duplicate pack and do not stock it in again.';

async function fail(error: unknown, startWrite: boolean) {
  const outcome = purchasingOutcome();
  try {
    if (startWrite) {
      await outcome.write(async () => {
        throw error;
      })();
    } else {
      throw error;
    }
  } catch (caught) {
    return outcome.failure(caught, 'Could not draft the receipt.');
  }
  throw new Error('expected a failure');
}

describe('purchasingOutcome', () => {
  it('shows the duplicate-serial sentence after the write has started', async () => {
    await expect(fail(new Error('DUPLICATE_SERIAL'), true)).resolves.toEqual({
      message: DUPLICATE,
      field: 'serialNumber',
      outcome: 'rejected',
    });
    await expect(
      fail(
        Object.assign(new Error('Unique constraint failed on gtin, serialKey'), {
          code: 'P2002',
          meta: { target: 'pharmacy_grl_org_gtin_serial_key' },
        }),
        true
      )
    ).resolves.toMatchObject({ message: DUPLICATE, outcome: 'rejected' });
  });

  it('keeps an unknown failure locked when the write may have committed', async () => {
    await expect(fail(new Error('CROSS_TENANT_REFERENCE'), true)).resolves.toMatchObject({
      outcome: 'unknown',
    });
    await expect(
      fail(new PurchasingValidationError('cache refresh failed'), true)
    ).resolves.toMatchObject({
      outcome: 'unknown',
    });
  });

  it('still rejects a local validation error before any write', async () => {
    await expect(
      fail(new PurchasingValidationError('Enter a batch number.'), false)
    ).resolves.toMatchObject({
      message: 'Enter a batch number.',
      outcome: 'rejected',
    });
  });
});

it('allows retry after a refused approval PIN without claiming an unknown write', async () => {
  const { APPROVAL_BLOCKED } = await import('@/lib/pharmacy/purchase-approval');
  await expect(
    fail(
      Object.assign(new PurchasingValidationError(APPROVAL_BLOCKED), {
        field: 'bypassApprovalPin',
      }),
      true
    )
  ).resolves.toEqual({
    message: APPROVAL_BLOCKED,
    field: 'bypassApprovalPin',
    outcome: 'rejected',
  });
});

it('explains a receipt reversal refused because the stock moved on (DEV-610)', async () => {
  await expect(fail(new Error('REVERSAL_STOCK_MOVED'), true)).resolves.toMatchObject({
    message: expect.stringContaining('sold, transferred'),
    outcome: 'rejected',
  });
  await expect(fail(new Error('REVERSAL_PACKS_OPENED'), true)).resolves.toMatchObject({
    message: expect.stringContaining('opened into loose units'),
    outcome: 'rejected',
  });
});
