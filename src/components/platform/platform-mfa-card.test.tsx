import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { authenticatorQrPath } from '@/components/ui/authenticator-qr';
import { PlatformMfaCard } from './platform-mfa-card';

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const SECRET = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';
const URI = `otpauth://totp/DevFathom%20Control:op%40example.test?secret=${SECRET}&issuer=DevFathom%20Control`;

function json(body: unknown) {
  return Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));
}

describe('PlatformMfaCard authenticator setup (DEV-898)', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      vi.fn((_url: string, init?: RequestInit) =>
        init?.method === 'POST'
          ? json({ secret: SECRET, otpauthUri: URI })
          : json({ enabled: false, required: true, recoveryCodes: 0 })
      )
    );
  });
  afterEach(() => vi.unstubAllGlobals());

  it('shows a QR code of the setup link and keeps the key to type as a fallback', async () => {
    render(<PlatformMfaCard />);
    expect(screen.queryByRole('img', { name: /QR code/ })).not.toBeInTheDocument();
    fireEvent.click(await screen.findByRole('button', { name: /Begin enrollment/ }));
    const qr = await screen.findByRole('img', {
      name: 'QR code to scan with your authenticator app',
    });
    expect(qr.querySelector('path')).toHaveAttribute('d', authenticatorQrPath(URI).path);
    expect(screen.getByText('Scan this code with your authenticator app.')).toBeVisible();
    expect(screen.getByText(SECRET)).toBeVisible();
    expect(screen.getByRole('button', { name: /Copy authenticator URI/ })).toBeVisible();
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(3));
    // Nothing but our own endpoint is called: the QR is drawn in the browser.
    for (const call of vi.mocked(fetch).mock.calls) expect(call[0]).toBe('/api/platform/mfa');
  });
});
