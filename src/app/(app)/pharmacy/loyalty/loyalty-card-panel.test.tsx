import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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

    const popup = document.implementation.createHTMLDocument('');
    const print = vi.fn();
    const open = vi
      .spyOn(window, 'open')
      .mockReturnValue({ document: popup, print, opener: window } as unknown as Window);
    fireEvent.click(screen.getByRole('button', { name: 'Print card' }));
    expect(open).toHaveBeenCalledWith('', '_blank', 'popup,width=420,height=560');
    expect(print).toHaveBeenCalled();
    const printed = popup.body;
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
});
