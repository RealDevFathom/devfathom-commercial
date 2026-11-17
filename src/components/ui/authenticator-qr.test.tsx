import { render, screen } from '@testing-library/react';
import { encode } from 'uqr';
import { describe, expect, it } from 'vitest';
import { totpAuthUri } from '@/lib/totp';
import { AuthenticatorQr, authenticatorQrPath } from './authenticator-qr';

const SECRET = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';
const URI = totpAuthUri('owner@example.test', SECRET, 'DevFathom Control');

/** Rebuilds the on/off grid from the drawn path, so the test reads what a camera would. */
function gridFromPath(path: string, size: number): boolean[][] {
  const grid = Array.from({ length: size }, () => Array<boolean>(size).fill(false));
  for (const match of path.matchAll(/M(\d+) (\d+)h1v1h-1z/g)) {
    grid[Number(match[2])][Number(match[1])] = true;
  }
  return grid;
}

describe('AuthenticatorQr (DEV-898)', () => {
  it('draws exactly the QR matrix of the same setup link the manual key comes from', () => {
    const expected = encode(URI, { ecc: 'M', border: 4 });
    const { path, size } = authenticatorQrPath(URI);
    expect(size).toBe(expected.size);
    expect(gridFromPath(path, size)).toEqual(expected.data);
    // The link carries the same secret the person would otherwise type.
    expect(URI).toContain(`secret=${SECRET}`);
  });

  it('keeps the four-module white margin a phone camera needs', () => {
    const { path, size } = authenticatorQrPath(URI);
    const grid = gridFromPath(path, size);
    for (let i = 0; i < size; i += 1) {
      for (const edge of [0, 1, 2, 3, size - 4, size - 3, size - 2, size - 1]) {
        expect(grid[edge][i]).toBe(false);
        expect(grid[i][edge]).toBe(false);
      }
    }
    // Top-left finder pattern starts right after the margin.
    expect(grid[4][4]).toBe(true);
  });

  it('draws a different code for a different secret', () => {
    const other = totpAuthUri('owner@example.test', 'KRSXG5CTMVRXEZLUKRSXG5CTMVRXEZLU');
    expect(authenticatorQrPath(other).path).not.toBe(authenticatorQrPath(URI).path);
  });

  it('renders black on white in every theme and is named for screen readers', () => {
    render(<AuthenticatorQr uri={URI} />);
    const qr = screen.getByRole('img', { name: 'QR code to scan with your authenticator app' });
    expect(qr.querySelector('rect')).toHaveAttribute('fill', '#ffffff');
    expect(qr.querySelector('path')).toHaveAttribute('fill', '#000000');
    expect(qr.querySelector('path')).toHaveAttribute('d', authenticatorQrPath(URI).path);
    // The secret is drawn, never written out as text or sent anywhere.
    expect(qr.outerHTML).not.toContain(SECRET);
  });
});
