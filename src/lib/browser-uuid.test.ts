import { webcrypto } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { browserUuid } from './browser-uuid';

afterEach(() => vi.unstubAllGlobals());

describe('browserUuid', () => {
  it('uses native randomUUID with its Crypto receiver', () => {
    const crypto = {
      randomUUID() {
        expect(this).toBe(crypto);
        return '12345678-1234-4234-8234-123456789abc';
      },
      getRandomValues: vi.fn(),
    };
    vi.stubGlobal('crypto', crypto);
    expect(browserUuid()).toBe('12345678-1234-4234-8234-123456789abc');
    expect(crypto.getRandomValues).not.toHaveBeenCalled();
  });

  it('works with secure getRandomValues and no randomUUID, as on HTTP LAN', () => {
    vi.stubGlobal('crypto', { getRandomValues: webcrypto.getRandomValues.bind(webcrypto) });
    const ids = Array.from({ length: 128 }, () => browserUuid());
    expect(new Set(ids).size).toBe(128);
    for (const id of ids) {
      expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    }
  });

  it.each([0, 255])('sets version and variant bits while retaining random bits (%i)', (value) => {
    const crypto = {
      getRandomValues(bytes: Uint8Array) {
        expect(this).toBe(crypto);
        expect(bytes).toHaveLength(16);
        return bytes.fill(value);
      },
    };
    vi.stubGlobal('crypto', crypto);
    expect(browserUuid()).toBe(
      value === 0 ? '00000000-0000-4000-8000-000000000000' : 'ffffffff-ffff-4fff-bfff-ffffffffffff'
    );
  });

  it.each([undefined, {}])('fails explicitly without secure randomness (%j)', (crypto) => {
    vi.stubGlobal('crypto', crypto);
    expect(browserUuid).toThrow('Secure randomness is unavailable; cannot generate a command ID.');
  });

  it('propagates CSPRNG failures', () => {
    vi.stubGlobal('crypto', {
      getRandomValues: () => {
        throw new Error('CSPRNG failed');
      },
    });
    expect(browserUuid).toThrow('CSPRNG failed');
  });
});
