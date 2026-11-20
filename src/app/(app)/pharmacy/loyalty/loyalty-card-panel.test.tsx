import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installFakePrintWindows } from '@/lib/testing/print-window';

const actions = vi.hoisted(() => ({ issue: vi.fn(), revoke: vi.fn() }));
vi.mock('./loyalty-card-actions', () => ({
  issueLoyaltyCard: actions.issue,
  revokeLoyaltyCard: actions.revoke,
}));

import { encodeQr, qrSvgPath } from '@/lib/qr/qr-code';
import { LoyaltyCardPanel } from './loyalty-card-panel';

const CODE = 'DFLCABCDEFGHIJKLMNOPQRSTUVWXYZ';

beforeEach(() => {
  vi.clearAllMocks();
  actions.issue.mockResolvedValue({ status: 'issued', message: 'Card issued.', code: CODE });
  actions.revoke.mockResolvedValue({ status: 'revoked', message: 'Card revoked.' });
});
afterEach(() => cleanup());

describe('DEV-748 loyalty card panel', () => {
  it('shows the new card’s QR and code once, and prints it black on white', async () => {
    render(<LoyaltyCardPanel branchId="branch-a" customerId="customer-a" activeCard={null} />);
    fireEvent.click(screen.getByRole('button', { name: 'Issue card' }));
    await waitFor(() => expect(screen.getByText('Card issued.')).toBeInTheDocument());
    const form = actions.issue.mock.calls[0]![1] as FormData;
    expect(Object.fromEntries(form)).toMatchObject({
      branchId: 'branch-a',
      customerId: 'customer-a',
      intent: 'issue',
    });
    expect(screen.getByText('DFLC ABCD EFGH IJKL MNOP QRST UVWX YZ')).toBeInTheDocument();
    const preview = screen.getByRole('img', { name: 'Loyalty card QR code preview' });
    expect(preview.querySelector('path')).toHaveAttribute('d', qrSvgPath(encodeQr(CODE), 4));
    // Dark modules on a light quiet zone in either theme, never theme-inverted.
    expect(preview.querySelector('path')).toHaveAttribute('fill', '#000');
    expect(preview.querySelector('rect')).toHaveAttribute('fill', '#fff');

    const windows = installFakePrintWindows();
    const open = windows.open;
    fireEvent.click(screen.getByRole('button', { name: 'Print card' }));
    // DEV-973: the isolated print page, which prints itself; never print() from here.
    expect(open).toHaveBeenCalledWith(
      expect.stringMatching(/^\/print-window\.html#[0-9a-f-]{36}$/),
      '_blank',
      'popup,width=420,height=560'
    );
    expect(windows.last().printRequests()).toBe(1);
    expect(windows.last().proxy.print).not.toHaveBeenCalled();
    expect(windows.last().document()!.title).toBe('Loyalty card');
    const printed = windows.last().document()!.body;
    // Elements of the print window's own document: compare attributes directly.
    expect(printed.querySelector('path')?.getAttribute('fill')).toBe('#000');
    expect(printed.querySelector('path')?.getAttribute('d')).toBe(qrSvgPath(encodeQr(CODE), 4));
    expect(printed.querySelector('rect')?.getAttribute('fill')).toBe('#fff');
    // The card prints exactly a heading and the code, and no other text (no name, phone or
    // balance). Compared per line, whitespace-normalized, so wrapping cannot break it.
    const lines = [...printed.querySelectorAll('p')].map((p) =>
      (p.textContent ?? '').replace(/\s+/g, ' ').trim()
    );
    expect(lines).toEqual(['Loyalty card', 'DFLC ABCD EFGH IJKL MNOP QRST UVWX YZ']);
    expect((printed.textContent ?? '').replace(/\s+/g, '')).toBe(
      lines.join('').replace(/\s+/g, '')
    );
    open.mockRestore();
  });

  it('asks to allow pop-ups when the print window is blocked', async () => {
    render(<LoyaltyCardPanel branchId="branch-a" customerId="customer-a" activeCard={null} />);
    fireEvent.click(screen.getByRole('button', { name: 'Issue card' }));
    await screen.findByText('Card issued.');
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    fireEvent.click(screen.getByRole('button', { name: 'Print card' }));
    expect(screen.getByRole('alert')).toHaveTextContent('Allow pop-ups');
    open.mockRestore();
  });

  it('revokes a working card with the reason, without showing any code', async () => {
    render(
      <LoyaltyCardPanel
        branchId="branch-a"
        customerId="customer-a"
        activeCard={{ issuedAt: '2026-11-01T09:00:00.000Z' }}
      />
    );
    fireEvent.change(screen.getByLabelText('Reason for replacing or revoking the card'), {
      target: { value: 'Card stolen' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Revoke without replacing' }));
    await screen.findByText('Card revoked.');
    expect(actions.issue).not.toHaveBeenCalled();
    expect(Object.fromEntries(actions.revoke.mock.calls[0]![1] as FormData)).toMatchObject({
      intent: 'revoke',
      reason: 'Card stolen',
    });
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
  });

  it('shows the issue date on the organisation clock, without UTC wording (DEV-722)', () => {
    // 00:30 in Karachi on 1 Nov is still 31 Oct on the UTC calendar.
    const card = { issuedAt: '2026-10-31T19:30:00.000Z' };
    const { rerender } = render(
      <LoyaltyCardPanel
        branchId="branch-a"
        customerId="customer-a"
        activeCard={card}
        timeZone="Asia/Karachi"
      />
    );
    expect(screen.getByText('Issued 1 Nov 2026')).toBeInTheDocument();
    rerender(<LoyaltyCardPanel branchId="branch-a" customerId="customer-a" activeCard={card} />);
    expect(screen.getByText('Issued 31 Oct 2026')).toBeInTheDocument();
    expect(document.body).not.toHaveTextContent(/\bUTC\b/);
  });

  it('shows a refusal without a code', async () => {
    actions.issue.mockResolvedValue({
      status: 'error',
      message: 'This customer has not given loyalty consent. Record consent before issuing a card.',
    });
    render(<LoyaltyCardPanel branchId="branch-a" customerId="customer-a" activeCard={null} />);
    fireEvent.click(screen.getByRole('button', { name: 'Issue card' }));
    expect(await screen.findByText(/has not given loyalty consent/)).toHaveClass(
      'text-destructive'
    );
    expect(screen.queryByRole('button', { name: 'Print card' })).not.toBeInTheDocument();
  });
  it('DEV-747: offers the same card as Apple and Google Wallet test passes', async () => {
    const walletTestPasses = {
      mode: 'TEST',
      notice: 'Test pass: not signed by an issuer.',
      balancePoints: 1250,
      pointValueMinor: 100,
      apple: { serialNumber: 'plw_1', barcodes: [{ message: CODE }] },
      google: { id: 'test-issuer.plw_1', barcode: { value: CODE } },
    };
    actions.issue.mockResolvedValue({
      status: 'issued',
      message: 'Card issued.',
      code: CODE,
      walletTestPasses,
    });
    render(<LoyaltyCardPanel branchId="branch-a" customerId="customer-a" activeCard={null} />);
    fireEvent.click(screen.getByRole('button', { name: 'Issue card' }));
    await screen.findByText('Card issued.');
    expect(screen.getByRole('heading', { name: 'Wallet passes' })).toBeInTheDocument();
    expect(screen.getByText('Test only')).toBeInTheDocument();
    expect(screen.getByText(/1 point = PKR 1\./)).toHaveTextContent('1,250 points');

    const saved: Blob[] = [];
    const names: string[] = [];
    const create = vi.fn((blob: Blob) => {
      saved.push(blob);
      return 'blob:pass';
    });
    const revoke = vi.fn();
    Object.assign(URL, { createObjectURL: create, revokeObjectURL: revoke });
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
      this: HTMLAnchorElement
    ) {
      names.push(this.download);
    });
    fireEvent.click(screen.getByRole('button', { name: 'Download Apple Wallet test pass' }));
    fireEvent.click(screen.getByRole('button', { name: 'Download Google Wallet test pass' }));
    expect(names).toEqual([
      'loyalty-card-apple-wallet-test-pass.json',
      'loyalty-card-google-wallet-test-pass.json',
    ]);
    expect(revoke).toHaveBeenCalledTimes(2);
    const [apple, google] = await Promise.all(
      saved.map(async (blob) => JSON.parse(await blob.text()))
    );
    expect(apple).toEqual({
      mode: 'TEST',
      platform: 'APPLE_WALLET',
      notice: walletTestPasses.notice,
      pass: walletTestPasses.apple,
    });
    expect(google).toMatchObject({
      mode: 'TEST',
      platform: 'GOOGLE_WALLET',
      pass: walletTestPasses.google,
    });
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    click.mockRestore();
    Reflect.deleteProperty(URL, 'createObjectURL');
    Reflect.deleteProperty(URL, 'revokeObjectURL');
  });

  it('DEV-747: offers no wallet pass when none came with the card', async () => {
    render(<LoyaltyCardPanel branchId="branch-a" customerId="customer-a" activeCard={null} />);
    fireEvent.click(screen.getByRole('button', { name: 'Issue card' }));
    await screen.findByText('Card issued.');
    expect(screen.queryByRole('button', { name: /Wallet test pass/ })).not.toBeInTheDocument();
  });
});
