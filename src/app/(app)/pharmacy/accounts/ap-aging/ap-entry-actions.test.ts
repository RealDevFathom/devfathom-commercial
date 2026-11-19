import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TRPCError } from '@trpc/server';

const mocks = vi.hoisted(() => ({
  record: vi.fn(),
  pay: vi.fn(),
  revalidatePath: vi.fn(),
  createTRPCContext: vi.fn(),
  requestSetOff: vi.fn(),
  approveSetOff: vi.fn(),
  rejectSetOff: vi.fn(),
  reverseSetOff: vi.fn(),
  reverseInvoice: vi.fn(),
  reverseSettlement: vi.fn(),
}));
vi.mock('next/cache', () => ({ revalidatePath: mocks.revalidatePath }));
vi.mock('@/server/trpc', () => ({ createTRPCContext: mocks.createTRPCContext }));
vi.mock('@/server/routers/pharmacy-ap-invoices', () => ({
  pharmacyApInvoicesRouter: {
    createCaller: () => ({
      record: mocks.record,
      pay: mocks.pay,
      requestCreditSetOff: mocks.requestSetOff,
      approveCreditSetOff: mocks.approveSetOff,
      rejectCreditSetOff: mocks.rejectSetOff,
      reverseCreditSetOff: mocks.reverseSetOff,
      reverseInvoice: mocks.reverseInvoice,
      reverseSettlement: mocks.reverseSettlement,
    }),
  },
}));

import {
  approveCreditSetOffFromForm,
  payApInvoiceFromForm,
  recordApInvoiceFromForm,
  rejectCreditSetOffFromForm,
  requestCreditSetOffFromForm,
  reverseApInvoiceFromForm,
  reverseApSettlementFromForm,
  reverseCreditSetOffFromForm,
} from './ap-entry-actions';

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

describe('DEV-694 credit-note set-off actions', () => {
  const requestForm = (fields: Record<string, string> = {}) =>
    form({
      branchId: 'branch_1',
      requestKey: 'ap-set-off:key-0001',
      invoiceId: 'inv_1',
      supplierCreditId: 'cr_1',
      amount: '250.50',
      note: '',
      ...fields,
    });
  const decideForm = (fields: Record<string, string> = {}) =>
    form({
      branchId: 'branch_1',
      setOffId: 'so_1',
      decisionKey: 'ap-set-off-ok:key-0001',
      ...fields,
    });

  it('sends the chosen bill, credit and amount in minor units', async () => {
    mocks.requestSetOff.mockResolvedValue({ id: 'so_1' });
    const result = await requestCreditSetOffFromForm(idle, requestForm());
    expect(mocks.requestSetOff).toHaveBeenCalledWith({
      branchId: 'branch_1',
      invoiceId: 'inv_1',
      supplierCreditId: 'cr_1',
      requestKey: 'ap-set-off:key-0001',
      amountMinor: 25_050,
    });
    expect(result).toEqual({
      status: 'saved',
      message: 'Set-off requested. The bill is unchanged until a manager approves it.',
    });
    expect(mocks.revalidatePath).toHaveBeenCalledWith('/pharmacy/accounts/ap-aging');
  });

  it('refuses a bad amount before calling the server and explains a refused request', async () => {
    expect((await requestCreditSetOffFromForm(idle, requestForm({ amount: '-1' }))).status).toBe(
      'error'
    );
    expect(mocks.requestSetOff).not.toHaveBeenCalled();
    mocks.requestSetOff.mockRejectedValue(
      new TRPCError({ code: 'CONFLICT', message: 'SET_OFF_EXCEEDS_BILL' })
    );
    expect((await requestCreditSetOffFromForm(idle, requestForm())).message).toContain(
      'more than the bill still owes'
    );
  });

  it('approves only with a well-formed PIN and passes the refusal message through', async () => {
    expect((await approveCreditSetOffFromForm(idle, decideForm({ pin: '12' }))).status).toBe(
      'error'
    );
    expect(mocks.approveSetOff).not.toHaveBeenCalled();
    mocks.approveSetOff.mockRejectedValue(
      new TRPCError({
        code: 'FORBIDDEN',
        message: 'Set-off not approved. Enter your manager or owner PIN.',
      })
    );
    const refused = await approveCreditSetOffFromForm(idle, decideForm({ pin: '2468' }));
    expect(refused).toEqual({
      status: 'error',
      message: 'Set-off not approved. Enter your manager or owner PIN.',
    });
    expect(mocks.approveSetOff).toHaveBeenCalledWith({
      branchId: 'branch_1',
      setOffId: 'so_1',
      decisionKey: 'ap-set-off-ok:key-0001',
      pin: '2468',
    });
    expect(JSON.stringify(refused)).not.toContain('2468');
  });

  it('rejects with a reason', async () => {
    expect((await rejectCreditSetOffFromForm(idle, decideForm())).status).toBe('error');
    mocks.rejectSetOff.mockResolvedValue({ id: 'so_1' });
    const result = await rejectCreditSetOffFromForm(idle, decideForm({ reason: 'Wrong bill' }));
    expect(result.status).toBe('saved');
    expect(mocks.rejectSetOff).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'Wrong bill' })
    );
  });

  it('reverses only with a PIN and a reason, and explains a closed period', async () => {
    const reverseForm = (fields: Record<string, string>) =>
      form({
        branchId: 'branch_1',
        setOffId: 'so_1',
        commandKey: 'ap-set-off-rev:key-0001',
        ...fields,
      });
    expect((await reverseCreditSetOffFromForm(idle, reverseForm({ reason: 'x' }))).status).toBe(
      'error'
    );
    expect((await reverseCreditSetOffFromForm(idle, reverseForm({ pin: '2468' }))).status).toBe(
      'error'
    );
    expect(mocks.reverseSetOff).not.toHaveBeenCalled();
    mocks.reverseSetOff.mockResolvedValue({ id: 'so_1' });
    const saved = await reverseCreditSetOffFromForm(
      idle,
      reverseForm({ pin: '2468', reason: 'Wrong bill' })
    );
    expect(saved.status).toBe('saved');
    expect(mocks.reverseSetOff).toHaveBeenCalledWith({
      branchId: 'branch_1',
      setOffId: 'so_1',
      commandKey: 'ap-set-off-rev:key-0001',
      reason: 'Wrong bill',
      pin: '2468',
    });
    mocks.reverseSetOff.mockRejectedValue(
      new TRPCError({ code: 'BAD_REQUEST', message: 'PERIOD_CLOSED' })
    );
    expect(
      (await reverseCreditSetOffFromForm(idle, reverseForm({ pin: '2468', reason: 'Wrong bill' })))
        .message
    ).toContain('closed accounting period');
  });
});

describe('DEV-103: reversing an invoice or a payment', () => {
  const reverseForm = (fields: Record<string, string> = {}) =>
    form({
      branchId: 'branch_1',
      commandKey: 'ap-reverse:key-0001',
      reason: ' Entered twice ',
      pin: '2468',
      ...fields,
    });

  beforeEach(() => {
    mocks.reverseInvoice.mockResolvedValue({ id: 'inv_1', reference: 'AP-0001' });
    mocks.reverseSettlement.mockResolvedValue({ id: 'set_1' });
  });

  it('sends an invoice reversal with the PIN and reason, and no date (the server dates it)', async () => {
    const state = await reverseApInvoiceFromForm(idle, reverseForm({ invoiceId: 'inv_1' }));
    expect(mocks.reverseInvoice).toHaveBeenCalledWith({
      branchId: 'branch_1',
      invoiceId: 'inv_1',
      commandKey: 'ap-reverse:key-0001',
      reason: 'Entered twice',
      pin: '2468',
    });
    expect(state).toMatchObject({ status: 'saved' });
    expect(state.message).toContain('AP-0001');
    expect(state.message).not.toContain('2468');
    expect(mocks.revalidatePath).toHaveBeenCalledWith('/pharmacy/accounts/ap-aging');
  });

  it('sends a payment reversal against the chosen payment', async () => {
    const state = await reverseApSettlementFromForm(idle, reverseForm({ settlementId: 'set_1' }));
    expect(mocks.reverseSettlement).toHaveBeenCalledWith(
      expect.objectContaining({ settlementId: 'set_1', pin: '2468', reason: 'Entered twice' })
    );
    expect(state).toMatchObject({ status: 'saved' });
    expect(state.message).toContain('owes that amount again');
  });

  it.each([
    [{ pin: '12' }, 'Enter your 4 to 8 digit manager or owner PIN.'],
    [{ pin: '' }, 'Enter your 4 to 8 digit manager or owner PIN.'],
    [{ reason: '   ' }, 'Say why it is being reversed.'],
  ])('refuses %o before calling the server', async (fields, message) => {
    const state = await reverseApInvoiceFromForm(
      idle,
      reverseForm({ invoiceId: 'inv_1', ...fields })
    );
    expect(state).toEqual({ status: 'error', message });
    expect(mocks.reverseInvoice).not.toHaveBeenCalled();
  });

  it('shows the server refusal for a forbidden reversal as written', async () => {
    mocks.reverseSettlement.mockRejectedValue(
      new TRPCError({
        code: 'FORBIDDEN',
        message:
          'Another manager or owner must reverse an entry you recorded. Ask Hina or another manager or owner to reverse it.',
      })
    );
    const state = await reverseApSettlementFromForm(idle, reverseForm({ settlementId: 'set_1' }));
    expect(state).toEqual({
      status: 'error',
      message:
        'Another manager or owner must reverse an entry you recorded. Ask Hina or another manager or owner to reverse it.',
    });
    expect(mocks.revalidatePath).not.toHaveBeenCalled();
  });

  it.each([
    ['ACTIVE_SETTLEMENTS', 'Reverse every payment and approved credit set-off'],
    ['PERIOD_CLOSED', 'closed accounting period'],
    ['ALREADY_REVERSED', 'already reversed'],
  ])('explains %s', async (reason, text) => {
    mocks.reverseInvoice.mockRejectedValue(new TRPCError({ code: 'CONFLICT', message: reason }));
    const state = await reverseApInvoiceFromForm(idle, reverseForm({ invoiceId: 'inv_1' }));
    expect(state.status).toBe('error');
    expect(state.message).toContain(text);
  });
});
