import { fireEvent, render, screen, waitFor, cleanup } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CustomerPortal } from './customer-portal';
import type { CustomerPortalSummary } from '@/lib/pharmacy/customer-portal-contract';

const fetcher = vi.fn();
beforeEach(() => {
  fetcher.mockReset();
  vi.stubGlobal('fetch', fetcher);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
const bootstrap = {
  signedIn: false,
  pharmacyName: 'Test Pharmacy',
  branches: [{ id: 'branch-a', name: 'Branch A' }],
  smsAvailable: true,
};
const summary: CustomerPortalSummary = {
  customerName: 'Customer A',
  branchName: 'Branch A',
  currency: 'PKR',
  loyaltyLabel: 'Rewards',
  pointsBalance: 15,
  offers: ['Delivery fee waived.'],
  receipts: [{ id: 'sale-a', receiptNumber: 17, completedAt: '2026-01-01T00:00:00Z' }],
  requests: [],
  accounts: [{ id: 'account-a', displayName: 'Family account', balanceMinor: 15000 }],
  raast: { id: '03001234567', payee: 'Test Pharmacy' },
};

describe('customer service interactions', () => {
  it('renders the customer receipt and submits a selected private photo for review', async () => {
    const receipt = {
      saleId: 'sale-a',
      receiptNumber: 17,
      branchName: 'Branch A',
      businessDate: '2026-01-01',
      completedAt: '2026-01-01T00:00:00Z',
      currency: 'PKR',
      lines: [
        {
          saleLineId: 'line-a',
          identityStatus: 'ISSUED',
          medicineName: 'Purchased item',
          strength: null,
          presentation: 'Pack',
          batchNumber: 'A',
          expiresAt: '2027-01-01',
          saleUnit: 'PACK',
          quantity: 1,
          canonicalUnits: 10,
          unitPriceMinor: 15000,
          discountMinor: 0,
          lineTotalMinor: 15000,
        },
      ],
      tenders: [{ tenderId: 'tender-a', type: 'CASH', amountMinor: 15000, changeGivenMinor: 0 }],
      totals: {
        grossMinor: 15000,
        discountMinor: 0,
        netMinor: 15000,
        tenderedMinor: 15000,
        changeMinor: 0,
      },
    };
    fetcher
      .mockResolvedValueOnce(Response.json({ signedIn: true, summary }))
      .mockResolvedValueOnce(Response.json(receipt))
      .mockResolvedValueOnce(Response.json({ id: 'photo-a', status: 'AWAITING_PHARMACIST' }))
      .mockResolvedValueOnce(Response.json({ signedIn: true, summary }));
    render(<CustomerPortal />);
    fireEvent.click(await screen.findByRole('button', { name: 'View receipt 17' }));
    expect(await screen.findByText(/Purchased item/)).toBeInTheDocument();
    expect(fetcher.mock.calls[1][0]).toBe('/api/pharmacy/customer?receipt=sale-a');
    const file = new File(['synthetic-image'], 'rx.png', { type: 'image/png' });
    const BrowserFormData = FormData;
    vi.stubGlobal(
      'FormData',
      class extends BrowserFormData {
        constructor(form?: HTMLFormElement) {
          super(form);
          // Model a browser-selected file: jsdom's FormData ignores the synthetic
          // FileList installed by fireEvent.change and otherwise returns an empty file.
          if (form?.querySelector('input[name=photo]')) this.set('photo', file);
        }
      }
    );
    fireEvent.change(screen.getByLabelText(/^Rx photo/), { target: { files: [file] } });
    // jsdom does not populate the native file input value from a synthetic
    // FileList, so submit the form after selecting the file through its change event.
    fireEvent.submit(screen.getByLabelText(/^Rx photo/).closest('form')!);
    expect(
      await screen.findByText(
        'Photo request received. A pharmacist must verify it before fulfilment.'
      )
    ).toBeInTheDocument();
    const command = JSON.parse(fetcher.mock.calls[2][1].body);
    expect(command).toMatchObject({
      action: 'photo',
      contentType: 'image/png',
      dataBase64: btoa('synthetic-image'),
    });
    expect(command).not.toHaveProperty('patientId');
  });
  it('completes SMS sign-in and presents only the customer workflows', async () => {
    fetcher
      .mockResolvedValueOnce(Response.json(bootstrap))
      .mockResolvedValueOnce(
        Response.json({ challengeId: 'challenge-a', message: 'A code is on its way.' })
      )
      .mockResolvedValueOnce(Response.json({ ok: true }))
      .mockResolvedValueOnce(Response.json({ signedIn: true, summary }));
    render(<CustomerPortal />);
    fireEvent.change(await screen.findByLabelText('Registered phone number'), {
      target: { value: '03001234567' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Send SMS code' }));
    fireEvent.change(await screen.findByLabelText('Six-digit SMS code'), {
      target: { value: '123456' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Verify and sign in' }));
    expect(await screen.findByRole('heading', { name: 'Receipts' })).toBeInTheDocument();
    expect(screen.getByText('Signed in as Customer A.', { exact: false })).toBeInTheDocument();
    expect(screen.getByText('PKR 150.00', { exact: false })).toBeInTheDocument();
    expect(screen.getByText('15 points')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Open workflow' })).not.toBeInTheDocument();
    for (const button of screen.getAllByRole('button')) expect(button).toHaveClass('min-h-11');
    expect(JSON.parse(fetcher.mock.calls[1][1].body)).toEqual({
      action: 'start',
      branchId: 'branch-a',
      phone: '03001234567',
    });
  });
  it('submits a refill and refreshes its persistent review state', async () => {
    fetcher
      .mockResolvedValueOnce(Response.json({ signedIn: true, summary }))
      .mockResolvedValueOnce(Response.json({ id: 'request-a', status: 'AWAITING_PHARMACIST' }))
      .mockResolvedValueOnce(
        Response.json({
          signedIn: true,
          summary: {
            ...summary,
            requests: [
              {
                id: 'request-a',
                kind: 'REFILL',
                status: 'AWAITING_PHARMACIST',
                createdAt: '2026-01-01',
              },
            ],
          },
        })
      );
    render(<CustomerPortal />);
    fireEvent.click(await screen.findByRole('button', { name: 'Request pharmacist review' }));
    expect(await screen.findByText('awaiting pharmacist')).toBeInTheDocument();
    expect(JSON.parse(fetcher.mock.calls[1][1].body)).toMatchObject({
      action: 'refill',
      saleId: 'sale-a',
      idempotencyKey: expect.any(String),
    });
  });
  it('shows consent, empty, and disabled states without inventing balances or payment details', async () => {
    fetcher.mockResolvedValue(
      Response.json({
        signedIn: true,
        summary: {
          ...summary,
          pointsBalance: null,
          receipts: [],
          accounts: [],
          offers: [],
          raast: null,
        },
      })
    );
    render(<CustomerPortal />);
    expect(await screen.findByText('Consent required')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Request pharmacist review' })).toBeDisabled();
    expect(screen.getByText('No active offers.')).toBeInTheDocument();
    expect(screen.queryByText('03001234567')).not.toBeInTheDocument();
  });
  it('preserves form input and re-enables retry after a failed submission', async () => {
    fetcher
      .mockResolvedValueOnce(Response.json(bootstrap))
      .mockResolvedValueOnce(
        Response.json({ error: 'Please wait before requesting another code.' }, { status: 429 })
      );
    render(<CustomerPortal />);
    const phone = await screen.findByLabelText('Registered phone number');
    fireEvent.change(phone, { target: { value: '03001234567' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send SMS code' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Please wait');
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Send SMS code' })).toBeEnabled()
    );
    expect(phone).toHaveValue('03001234567');
  });
});
