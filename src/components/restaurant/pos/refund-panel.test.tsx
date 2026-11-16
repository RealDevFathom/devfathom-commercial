import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { RefundPanel } from './refund-panel';
import type { TerminalRequest, TerminalRequestOptions } from './checkout-panel';

const managers = [
  { id: 'actor', displayName: 'Amina Rahman', role: 'Shift lead' },
  { id: 'manager', displayName: 'Bilal Khan', role: 'Manager' },
];
const tender = {
  tenderId: 'tender-hidden',
  orderNumber: 42,
  receiptNumber: 'R-0042',
  type: 'CARD',
  paidAmount: '24.00',
  refundedAmount: '4.00',
  remainingAmount: '20.00',
  tipPaidAmount: '2.00',
  tipRefundedAmount: '0.00',
  tipRemainingAmount: '2.00',
  paidAt: '2026-08-30T01:00:00Z',
};

function mockRequest(
  handler: (path: string, options?: TerminalRequestOptions) => Promise<unknown>
): TerminalRequest {
  return vi.fn(handler) as unknown as TerminalRequest;
}

async function open(request: TerminalRequest = mockRequest(async () => ({ tenders: [tender] }))) {
  render(<RefundPanel request={request} operators={managers} actingOperatorId="actor" />);
  fireEvent.click(screen.getByRole('button', { name: 'Refund' }));
  await screen.findByRole('option', { name: /R-0042/ });
  return request;
}

describe('RefundPanel', () => {
  it('defaults both balances, uses human labels, excludes self-approval, validates over-refunds, and previews explicitly', async () => {
    await open();
    expect(screen.queryByText('tender-hidden')).not.toBeInTheDocument();
    expect(screen.queryByRole('option', { name: /Amina/ })).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Settled receipt'), {
      target: { value: tender.tenderId },
    });
    expect(screen.getByLabelText('Refund amount')).toHaveValue('20.00');
    expect(screen.getByLabelText('Tip refund')).toHaveValue('2.00');
    fireEvent.change(screen.getByLabelText('Refund amount'), { target: { value: '20.01' } });
    fireEvent.change(screen.getByLabelText('Reason'), { target: { value: 'Guest complaint' } });
    fireEvent.change(screen.getByLabelText('Approving manager'), { target: { value: 'manager' } });
    fireEvent.change(screen.getByLabelText('Manager PIN'), { target: { value: '1234' } });
    fireEvent.click(screen.getByRole('button', { name: 'Review refund' }));
    expect(screen.getByRole('alert')).toHaveTextContent('remaining refundable balance');
    fireEvent.change(screen.getByLabelText('Refund amount'), { target: { value: '10.00' } });
    fireEvent.click(screen.getByRole('button', { name: 'Review refund' }));
    expect(screen.getByRole('heading', { name: 'Confirm destructive refund' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Confirm refund' })).toBeVisible();
  });

  it('allows a tip-only refund when the principal is exhausted', async () => {
    const tipOnly = { ...tender, refundedAmount: '24.00', remainingAmount: '0.00' };
    const request = mockRequest(async (_path, options) =>
      options?.method === 'POST'
        ? {
            amount: '0.00',
            tipRefundAmount: '2.00',
            businessDate: '2026-08-30',
            paymentStatus: 'REFUNDED',
            taxRefundAmount: '0.00',
            serviceChargeRefundAmount: '0.00',
            replayed: false,
          }
        : { tenders: [tipOnly] }
    );
    await open(request);
    fireEvent.change(screen.getByLabelText('Settled receipt'), {
      target: { value: tipOnly.tenderId },
    });
    expect(screen.getByLabelText('Refund amount')).toHaveValue('0.00');
    expect(screen.getByLabelText('Tip refund')).toHaveValue('2.00');
    fireEvent.change(screen.getByLabelText('Reason'), {
      target: { value: 'Return remaining tip' },
    });
    fireEvent.change(screen.getByLabelText('Approving manager'), { target: { value: 'manager' } });
    fireEvent.change(screen.getByLabelText('Manager PIN'), { target: { value: '1234' } });
    fireEvent.click(screen.getByRole('button', { name: 'Review refund' }));
    expect(screen.getByRole('heading', { name: 'Confirm destructive refund' })).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Confirm refund' }));
    await screen.findByText('refund recorded');
    const submission = vi
      .mocked(request)
      .mock.calls.find(([, options]) => options?.method === 'POST');
    expect(submission?.[1]?.body).toEqual({
      originalTenderId: tipOnly.tenderId,
      amount: '0.00',
      tipRefundAmount: '2.00',
      reason: 'Return remaining tip',
      approving: { staffProfileId: 'manager', type: 'PIN', secret: '1234' },
    });
  });

  it('rejects a refund when both principal and tip are zero', async () => {
    const request = await open();
    fireEvent.change(screen.getByLabelText('Settled receipt'), {
      target: { value: tender.tenderId },
    });
    fireEvent.change(screen.getByLabelText('Refund amount'), { target: { value: '0.00' } });
    fireEvent.change(screen.getByLabelText('Tip refund'), { target: { value: '0.00' } });
    fireEvent.change(screen.getByLabelText('Reason'), { target: { value: 'No value selected' } });
    fireEvent.change(screen.getByLabelText('Approving manager'), { target: { value: 'manager' } });
    fireEvent.change(screen.getByLabelText('Manager PIN'), { target: { value: '1234' } });

    fireEvent.click(screen.getByRole('button', { name: 'Review refund' }));

    expect(screen.getByRole('alert')).toHaveTextContent(
      'Enter a principal or tip amount to refund.'
    );
    expect(
      screen.queryByRole('heading', { name: 'Confirm destructive refund' })
    ).not.toBeInTheDocument();
    expect(vi.mocked(request).mock.calls.some(([, options]) => options?.method === 'POST')).toBe(
      false
    );
  });

  it('submits one terminal refund and renders the durable server-authored tax receipt', async () => {
    const request = mockRequest(async (_path, options) =>
      options?.method === 'POST'
        ? {
            amount: '10.00',
            tipRefundAmount: '0.00',
            businessDate: '2026-08-30',
            paymentStatus: 'PARTIALLY_REFUNDED',
            taxRefundAmount: '1.25',
            serviceChargeRefundAmount: '0.75',
            replayed: false,
          }
        : { tenders: [tender] }
    );
    await open(request);
    fireEvent.change(screen.getByLabelText('Settled receipt'), {
      target: { value: tender.tenderId },
    });
    fireEvent.change(screen.getByLabelText('Refund amount'), { target: { value: '10.00' } });
    fireEvent.change(screen.getByLabelText('Reason'), { target: { value: 'Guest complaint' } });
    fireEvent.change(screen.getByLabelText('Approving manager'), { target: { value: 'manager' } });
    fireEvent.change(screen.getByLabelText('Manager PIN'), { target: { value: '1234' } });
    fireEvent.click(screen.getByRole('button', { name: 'Review refund' }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm refund' }));
    await screen.findByText(/Tax 1.25/);
    expect(request).toHaveBeenCalledWith(
      '/api/restaurant/checkout/refund',
      expect.objectContaining({ method: 'POST' })
    );
    expect(screen.queryByDisplayValue('1234')).not.toBeInTheDocument();
    const submission = vi
      .mocked(request)
      .mock.calls.find(([, options]) => options?.method === 'POST');
    expect(submission?.[1]?.intent).toContain('"approvingStaffProfileId":"manager"');
    expect(submission?.[1]?.intent).not.toContain('1234');
  });

  it('uses the explicit server-side approval mode for a demo without exposing a PIN', async () => {
    const demoApproval = {
      staffProfileId: 'manager',
      displayName: 'Bilal Khan',
      expiresAt: Date.now() + 60_000,
    };
    const request = mockRequest(async (_path, options) =>
      options?.method === 'POST'
        ? {
            amount: '20.00',
            tipRefundAmount: '0.00',
            businessDate: '2026-08-30',
            paymentStatus: 'REFUNDED',
            taxRefundAmount: '2.50',
            serviceChargeRefundAmount: '1.50',
            replayed: false,
          }
        : { tenders: [tender], demoApproval }
    );
    render(
      <RefundPanel
        request={request}
        operators={[
          { id: 'other-manager', displayName: 'Aaron Manager', role: 'Manager' },
          ...managers,
        ]}
        actingOperatorId="actor"
        demo
      />
    );
    fireEvent.click(screen.getByRole('button', { name: 'Refund' }));
    await screen.findByRole('option', { name: /R-0042/ });
    expect(screen.queryByLabelText('Manager PIN')).not.toBeInTheDocument();
    expect(screen.getByText(/approval is ready with the designated manager/i)).toBeVisible();
    expect(screen.getByLabelText('Demo approving manager')).toHaveValue('manager');
    expect(screen.queryByRole('option', { name: /Aaron Manager/ })).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Settled receipt'), {
      target: { value: tender.tenderId },
    });
    fireEvent.change(screen.getByLabelText('Reason'), { target: { value: 'Demo walkthrough' } });
    fireEvent.click(screen.getByRole('button', { name: 'Review refund' }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm refund' }));
    await screen.findByText('refund recorded');
    const submission = vi
      .mocked(request)
      .mock.calls.find(([, options]) => options?.method === 'POST');
    expect(submission?.[1]?.body).toEqual({
      originalTenderId: tender.tenderId,
      amount: '20.00',
      tipRefundAmount: '2.00',
      reason: 'Demo walkthrough',
      approving: { staffProfileId: 'manager', type: 'DEMO' },
    });
    expect(submission?.[1]?.intent).toContain('"approvingStaffProfileId":"manager"');
    expect(JSON.stringify(submission?.[1])).not.toContain('secret');
  });

  it.each([
    ['missing', undefined],
    [
      'expired',
      { staffProfileId: 'manager', displayName: 'Bilal Khan', expiresAt: Date.now() - 1 },
    ],
  ])(
    'does not offer DEMO approval when public approval metadata is %s',
    async (_label, approval) => {
      const request = mockRequest(async () => ({
        tenders: [tender],
        ...(approval ? { demoApproval: approval } : {}),
      }));
      render(<RefundPanel request={request} operators={managers} actingOperatorId="actor" demo />);
      fireEvent.click(screen.getByRole('button', { name: 'Refund' }));
      await screen.findByRole('option', { name: /R-0042/ });

      expect(screen.getByRole('alert')).toHaveTextContent('Demo access expired');
      expect(screen.getByLabelText('Demo approving manager')).toHaveValue('');
      expect(screen.getByRole('button', { name: 'Review refund' })).toBeDisabled();
      expect(vi.mocked(request).mock.calls.some(([, options]) => options?.method === 'POST')).toBe(
        false
      );
    }
  );

  it('surfaces a permission denial without exposing a retry loop', async () => {
    const denied = mockRequest(async () => {
      throw new Error('Permission denied: capability missing');
    });
    render(<RefundPanel request={denied} operators={managers} actingOperatorId="actor" />);
    fireEvent.click(screen.getByRole('button', { name: 'Refund' }));
    await waitFor(() => expect(screen.getByText('permission denied')).toBeVisible());
    expect(screen.queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument();
  });

  it('labels an idempotent replay as an existing durable receipt', async () => {
    const request = mockRequest(async (_path, options) =>
      options?.method === 'POST'
        ? {
            amount: '20.00',
            tipRefundAmount: '0.00',
            businessDate: '2026-08-30',
            paymentStatus: 'REFUNDED',
            taxRefundAmount: '2.50',
            serviceChargeRefundAmount: '1.50',
            replayed: true,
          }
        : { tenders: [tender] }
    );
    await open(request);
    fireEvent.change(screen.getByLabelText('Settled receipt'), {
      target: { value: tender.tenderId },
    });
    fireEvent.change(screen.getByLabelText('Reason'), { target: { value: 'Duplicate charge' } });
    fireEvent.change(screen.getByLabelText('Approving manager'), { target: { value: 'manager' } });
    fireEvent.change(screen.getByLabelText('Manager PIN'), { target: { value: '1234' } });
    fireEvent.click(screen.getByRole('button', { name: 'Review refund' }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm refund' }));
    expect(await screen.findByText('receipt replayed')).toBeVisible();
  });
});

it('submits the optional MANUAL machine reference with the refund and its retry intent', async () => {
  const request = mockRequest(async (_path, options) =>
    options?.method === 'POST'
      ? {
          amount: '20.00',
          tipRefundAmount: '2.00',
          businessDate: '2026-08-30',
          paymentStatus: 'REFUNDED',
          taxRefundAmount: '0.00',
          serviceChargeRefundAmount: '0.00',
          replayed: false,
        }
      : { tenders: [{ ...tender, paymentProvider: 'MANUAL' }] }
  );
  await open(request);
  fireEvent.change(screen.getByLabelText('Settled receipt'), {
    target: { value: tender.tenderId },
  });
  const reference = screen.getByLabelText('Card machine refund reference (optional)');
  expect(reference).toHaveAttribute('maxlength', '120');
  fireEvent.change(reference, { target: { value: '  BANK-REFUND-123  ' } });
  fireEvent.change(screen.getByLabelText('Reason'), { target: { value: 'Returned meal' } });
  fireEvent.change(screen.getByLabelText('Approving manager'), { target: { value: 'manager' } });
  fireEvent.change(screen.getByLabelText('Manager PIN'), { target: { value: '1234' } });
  fireEvent.click(screen.getByRole('button', { name: 'Review refund' }));
  fireEvent.click(screen.getByRole('button', { name: 'Confirm refund' }));
  await screen.findByText('refund recorded');
  const options = vi
    .mocked(request)
    .mock.calls.find(([, options]) => options?.method === 'POST')?.[1];
  expect(options?.body).toMatchObject({ cardMachineRefundReference: 'BANK-REFUND-123' });
  expect(options?.intent).toContain('BANK-REFUND-123');
});
