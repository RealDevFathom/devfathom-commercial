import { describe, expect, it } from 'vitest';
import { encodeQrCode, QrCodeTooLongError } from './qr-code';

/**
 * DEV-879: the authenticator set-up QR code. The encoder was checked against an independent
 * decoder for every supported version; these tests pin the structure a scanner relies on.
 */

function finderAt(m: boolean[][], x0: number, y0: number): boolean {
  for (let dy = 0; dy < 7; dy++) {
    for (let dx = 0; dx < 7; dx++) {
      const ring = Math.max(Math.abs(dx - 3), Math.abs(dy - 3));
      if (m[y0 + dy][x0 + dx] !== (ring !== 2)) return false;
    }
  }
  return true;
}

/** The two copies of the 15 format-information bits must agree. */
function formatCopies(m: boolean[][]): [string, string] {
  const size = m.length;
  const first: boolean[] = [];
  for (let i = 0; i <= 5; i++) first.push(m[i][8]);
  first.push(m[7][8], m[8][8], m[8][7]);
  for (let i = 9; i < 15; i++) first.push(m[8][14 - i]);
  const second: boolean[] = [];
  for (let i = 0; i < 8; i++) second.push(m[8][size - 1 - i]);
  for (let i = 8; i < 15; i++) second.push(m[size - 15 + i][8]);
  const bits = (list: boolean[]) => list.map((dark) => (dark ? '1' : '0')).join('');
  return [bits(first), bits(second)];
}

describe('encodeQrCode', () => {
  it('picks the smallest version that holds the text', () => {
    expect(encodeQrCode('A')).toHaveLength(21);
    expect(encodeQrCode('x'.repeat(15))).toHaveLength(25);
    expect(encodeQrCode('x'.repeat(214))).toHaveLength(61);
  });

  it('draws the three finder patterns, timing lines and the dark module', () => {
    const m = encodeQrCode(
      'otpauth://totp/DevFathom%20Approvals%3Amanager%40example.test?secret=JBSWY3DPEHPK3PXP&issuer=DevFathom%20Approvals&algorithm=SHA1&digits=6&period=30'
    );
    const size = m.length;
    expect(finderAt(m, 0, 0)).toBe(true);
    expect(finderAt(m, size - 7, 0)).toBe(true);
    expect(finderAt(m, 0, size - 7)).toBe(true);
    for (let i = 8; i < size - 8; i++) {
      expect(m[6][i]).toBe(i % 2 === 0);
      expect(m[i][6]).toBe(i % 2 === 0);
    }
    expect(m[size - 8][8]).toBe(true);
    const [first, second] = formatCopies(m);
    expect(first).toBe(second);
  });

  it('is deterministic for the same text', () => {
    expect(encodeQrCode('same text')).toEqual(encodeQrCode('same text'));
  });

  it('refuses text too long for the supported versions', () => {
    expect(() => encodeQrCode('z'.repeat(667))).toThrow(QrCodeTooLongError);
  });
});
