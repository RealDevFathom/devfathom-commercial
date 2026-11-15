import { describe, expect, it, vi } from 'vitest';

import { MarketingWorkflowError } from './marketing-service';
import { VOUCHER_PRINT_FOOTER, VOUCHER_WHATSAPP_FOOTER } from './voucher-scope';
import { issueVoucher, listVouchers, voucherIssueInput } from './vouchers';

const scope = {
  organizationId: 'org-a',
  branchId: 'branch-a',
  actorId: 'owner-a',
  timezone: 'Asia/Karachi',
};
const input = {
  branchId: 'branch-a',
  code: 'gift10',
  name: 'Gift sets',
  body: 'Rs 100 off gift sets this week. Reply STOP to opt out.',
  discountMinor: 10_000,
  reviewed: true as const,
};

function db() {
  const create = vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({
    id: 'voucher-a',
    ...data,
  }));
  return { create, pharmacyVoucher: { create, findMany: vi.fn(async () => []) } };
}

describe('DEV-27 voucher issue', () => {
  it('stores the non-drug allowlist on the voucher and renders each channel footer', async () => {
    const fake = db();
    const { voucher, messages } = await issueVoucher(fake as never, scope, input);
    expect(fake.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        organizationId: 'org-a',
        branchId: 'branch-a',
        code: 'GIFT10',
        eligibleCategories: ['NON_DRUG'],
        issuedByUserId: 'owner-a',
      }),
    });
    expect(voucher.eligibleCategories).toEqual(['NON_DRUG']);
    expect(messages.whatsapp).toBe(`${input.body}\n${VOUCHER_WHATSAPP_FOOTER}`);
    expect(messages.whatsapp).not.toMatch(/medicine/i);
    expect(messages.print).toBe(`${input.body}\n${VOUCHER_PRINT_FOOTER}`);
    expect(messages.inApp).toBe(`${input.body}\n${VOUCHER_PRINT_FOOTER}`);
  });

  it('refuses a drug category in the allowlist', async () => {
    for (const category of ['RX', 'OTC_DRUG', 'SUPPLEMENT', 'MEDICAL_DEVICE']) {
      expect(
        voucherIssueInput.safeParse({ ...input, eligibleCategories: [category] }).success
      ).toBe(false);
    }
  });

  it('refuses voucher copy that names a drug or medicine category', async () => {
    for (const body of [
      'Save on vitamins. Reply STOP to opt out.',
      'Discount on medicines. Reply STOP to opt out.',
    ]) {
      const fake = db();
      await expect(issueVoucher(fake as never, scope, { ...input, body })).rejects.toThrow(
        MarketingWorkflowError
      );
      expect(fake.create).not.toHaveBeenCalled();
    }
  });

  it('lists vouchers with their rendered footers', async () => {
    const fake = db();
    fake.pharmacyVoucher.findMany.mockResolvedValueOnce([
      { id: 'voucher-a', body: input.body } as never,
    ]);
    const [listed] = await listVouchers(fake as never, scope);
    expect(listed?.messages.whatsapp.endsWith(VOUCHER_WHATSAPP_FOOTER)).toBe(true);
  });
});
