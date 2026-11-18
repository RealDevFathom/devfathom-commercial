import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TRPCError } from '@trpc/server';

const mocks = vi.hoisted(() => ({
  record: vi.fn(),
  pay: vi.fn(),
  revalidatePath: vi.fn(),
  createTRPCContext: vi.fn(),
}));
vi.mock('next/cache', () => ({ revalidatePath: mocks.revalidatePath }));
vi.mock('@/server/trpc', () => ({ createTRPCContext: mocks.createTRPCContext }));
vi.mock('@/server/routers/pharmacy-ap-invoices', () => ({
  pharmacyApInvoicesRouter: { createCaller: () => ({ record: mocks.record, pay: mocks.pay }) },
}));

import { payApInvoiceFromForm, recordApInvoiceFromForm } from './ap-entry-actions';

const idle = { status: 'idle' as const, message: '' };

function form(fields: Record<string, string>) {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) data.set(key, value);
  return data;
}

const invoiceForm = (fields: Record<string, string> = {}) =>
  form({
    branchId: 'branch_1',
    createKey: 'ap-invoice:key-0001',
    payeeName: ' K-Electric ',
    supplierInvoiceRef: 'KE-11',
    reference: 'AP-0001',
    invoiceDate: '2026-11-01',
    dueDate: '2026-11-30',
    currency: 'PKR',
    amount: '1234.56',
    description: 'November electricity',
    evidenceReference: 'Bills folder 11',
    ...fields,
  });

const paymentForm = (fields: Record<string, string> = {}) =>
  form({
    branchId: 'branch_1',
    commandKey: 'ap-payment:key-0001',
    invoiceId: 'inv_1',
    amount: '500',
    paidAt: '2026-11-15T10:30',
    fundingAccount: 'BANK',
    reference: 'PV-0107',
    bankReference: 'HBL-998',
    ...fields,
  });

beforeEach(() => {
  vi.clearAllMocks();
  mocks.createTRPCContext.mockResolvedValue({ organization: { timezone: 'Asia/Karachi' } });
  mocks.record.mockResolvedValue({ id: 'inv_1', reference: 'AP-0001' });
  mocks.pay.mockResolvedValue({ id: 'set_1', amountMinor: 50_000 });
});

describe('DEV-103 record supplier expense invoice form action', () => {
  it('sends the invoice in minor units with the form command key and refreshes the aging page', async () => {
    await expect(recordApInvoiceFromForm(idle, invoiceForm())).resolves.toEqual({
      status: 'saved',
      message: 'Invoice AP-0001 recorded and posted to accounts payable.',
    });
    expect(mocks.record).toHaveBeenCalledWith({
      branchId: 'branch_1',
      createKey: 'ap-invoice:key-0001',
      reference: 'AP-0001',
      payeeName: 'K-Electric',
      supplierInvoiceRef: 'KE-11',
      invoiceDate: '2026-11-01',
      dueDate: '2026-11-30',
      amountMinor: 123_456,
      currency: 'PKR',
      description: 'November electricity',
      evidenceReference: 'Bills folder 11',
    });
    expect(mocks.revalidatePath).toHaveBeenCalledWith('/pharmacy/accounts/ap-aging');
  });

  it.each(['0', '-5', '1.234', 'abc', '', '10000000.00'])(
    'refuses amount %j before calling the server',
    async (amount) => {
      await expect(recordApInvoiceFromForm(idle, invoiceForm({ amount }))).resolves.toMatchObject({
        status: 'error',
      });
      expect(mocks.record).not.toHaveBeenCalled();
      expect(mocks.revalidatePath).not.toHaveBeenCalled();
    }
  );

  it('refuses a currency the ledger does not carry', async () => {
    await expect(
      recordApInvoiceFromForm(idle, invoiceForm({ currency: 'EUR' }))
    ).resolves.toMatchObject({ status: 'error' });
    expect(mocks.record).not.toHaveBeenCalled();
  });

  it.each([
    ['DUPLICATE_INVOICE', 'already recorded'],
    ['DUPLICATE_REFERENCE', 'already uses this reference'],
    ['PERIOD_CLOSED', 'closed accounting period'],
    ['IDEMPOTENCY_CONFLICT', 'different details'],
    ['INVALID_DATE', 'due date on or after it'],
  ])('explains the server refusal %s', async (reason, text) => {
    mocks.record.mockRejectedValue(new TRPCError({ code: 'CONFLICT', message: reason }));
    const result = await recordApInvoiceFromForm(idle, invoiceForm());
    expect(result.status).toBe('error');
    expect(result.message).toContain(text);
    expect(mocks.revalidatePath).not.toHaveBeenCalled();
  });

  it.each(['FORBIDDEN', 'UNAUTHORIZED'] as const)(
    'reports a %s refusal as denied',
    async (code) => {
      mocks.record.mockRejectedValue(new TRPCError({ code }));
      const result = await recordApInvoiceFromForm(idle, invoiceForm());
      expect(result).toMatchObject({ status: 'error' });
      expect(result.message).toContain('Only an owner with Pharmacy Finance access');
    }
  );

  it('never echoes an unexpected error message', async () => {
    mocks.record.mockRejectedValue(new Error('relation pharmacy_ap_invoices does not exist'));
    const result = await recordApInvoiceFromForm(idle, invoiceForm());
    expect(result.status).toBe('error');
    expect(result.message).not.toContain('pharmacy_ap_invoices');
  });
});

describe('DEV-103 pay supplier expense invoice form action', () => {
  it('reads the picker on the workspace clock and sends one invoice-directed payment', async () => {
    await expect(payApInvoiceFromForm(idle, paymentForm())).resolves.toMatchObject({
      status: 'saved',
    });
    expect(mocks.pay).toHaveBeenCalledWith({
      branchId: 'branch_1',
      invoiceId: 'inv_1',
      commandKey: 'ap-payment:key-0001',
      reference: 'PV-0107',
      amountMinor: 50_000,
      paidAt: '2026-11-15T05:30:00Z',
      fundingAccount: 'BANK',
      bankReference: 'HBL-998',
    });
    expect(mocks.revalidatePath).toHaveBeenCalledWith('/pharmacy/accounts/ap-aging');
  });

  it('omits a blank bank reference', async () => {
    await payApInvoiceFromForm(idle, paymentForm({ bankReference: ' ', fundingAccount: 'CASH' }));
    const sent = mocks.pay.mock.calls[0]?.[0];
    expect(sent).not.toHaveProperty('bankReference');
    expect(sent).toMatchObject({ fundingAccount: 'CASH' });
  });

  it.each<Record<string, string>>([
    { amount: '0' },
    { amount: '12.345' },
    { fundingAccount: 'CARD' },
    { paidAt: '' },
    { paidAt: '2026-11-15T10:30:00Z' },
  ])('refuses %j before calling the server', async (fields) => {
    await expect(payApInvoiceFromForm(idle, paymentForm(fields))).resolves.toMatchObject({
      status: 'error',
    });
    expect(mocks.pay).not.toHaveBeenCalled();
  });

  it.each([
    ['OVERPAYMENT', 'more than the invoice still owed'],
    ['INVALID_DATE', 'on or after the invoice date'],
    ['NOT_FOUND', 'not open for payment'],
    ['INVALID_STATE', 'not open for payment'],
    ['PERIOD_CLOSED', 'closed accounting period'],
  ])('explains the server refusal %s', async (reason, text) => {
    mocks.pay.mockRejectedValue(new TRPCError({ code: 'CONFLICT', message: reason }));
    const result = await payApInvoiceFromForm(idle, paymentForm());
    expect(result.status).toBe('error');
    expect(result.message).toContain(text);
    expect(mocks.revalidatePath).not.toHaveBeenCalled();
  });

  it('reports a FORBIDDEN refusal as denied', async () => {
    mocks.pay.mockRejectedValue(new TRPCError({ code: 'FORBIDDEN' }));
    const result = await payApInvoiceFromForm(idle, paymentForm());
    expect(result.message).toContain('Only an owner with Pharmacy Finance access');
  });
});
