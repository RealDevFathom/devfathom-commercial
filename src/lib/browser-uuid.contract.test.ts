import { afterEach, describe, expect, it, vi } from 'vitest';

import { browserUuid } from './browser-uuid';

// Synthetic Web Crypto interfaces only; these tests do not use a browser or network.
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('synthetic browser UUID contract', () => {
  it('prefers native UUID generation with its original receiver', () => {
    const value = '16a3bbcf-643a-40c4-b753-88444a14ae36';
    const native = vi.fn(() => value);
    const fallback = vi.fn();
    const crypto = { randomUUID: native, getRandomValues: fallback };
    vi.stubGlobal('crypto', crypto);

    expect(browserUuid()).toBe(value);
    expect(native.mock.contexts).toEqual([crypto]);
    expect(native).toHaveBeenCalledExactlyOnceWith();
    expect(fallback).not.toHaveBeenCalled();
  });

  it.each([
    ['zero bytes', Array<number>(16).fill(0), '00000000-0000-4000-8000-000000000000'],
    ['maximum bytes', Array<number>(16).fill(255), 'ffffffff-ffff-4fff-bfff-ffffffffffff'],
    [
      'distinct bytes',
      Array.from({ length: 16 }, (_, index) => index),
      '00010203-0405-4607-8809-0a0b0c0d0e0f',
    ],
  ] as const)(
    'formats secure fallback %s with UUID v4 version and variant',
    (_name, input, expected) => {
      const secure = vi.fn((bytes: Uint8Array) => {
        expect(bytes).toBeInstanceOf(Uint8Array);
        expect(bytes).toHaveLength(16);
        bytes.set(input);
        return bytes;
      });
      vi.stubGlobal('crypto', { getRandomValues: secure });
      const weak = vi.spyOn(Math, 'random').mockImplementation(() => {
        throw new Error('Weak randomness must not be used');
      });

      expect(browserUuid()).toBe(expected);
      expect(secure).toHaveBeenCalledTimes(1);
      expect(weak).not.toHaveBeenCalled();
    }
  );

  it('requests fresh secure bytes for each independent command ID', () => {
    const buffers: Uint8Array[] = [];
    vi.stubGlobal('crypto', {
      getRandomValues(bytes: Uint8Array) {
        buffers.push(bytes);
        bytes.fill(0);
        bytes[15] = buffers.length;
        return bytes;
      },
    });

    expect(browserUuid()).toBe('00000000-0000-4000-8000-000000000001');
    expect(browserUuid()).toBe('00000000-0000-4000-8000-000000000002');
    expect(buffers).toHaveLength(2);
    expect(buffers[0]).not.toBe(buffers[1]);
  });

  it.each([undefined, {}])('refuses to generate IDs without secure randomness (%s)', (crypto) => {
    vi.stubGlobal('crypto', crypto);
    const weak = vi.spyOn(Math, 'random');

    expect(() => browserUuid()).toThrow(
      'Secure randomness is unavailable; cannot generate a command ID.'
    );
    expect(weak).not.toHaveBeenCalled();
  });

  it('propagates a native provider failure without silently switching providers', () => {
    const failure = new Error('Native provider unavailable');
    const fallback = vi.fn();
    vi.stubGlobal('crypto', {
      randomUUID() {
        throw failure;
      },
      getRandomValues: fallback,
    });

    expect(() => browserUuid()).toThrow(failure);
    expect(fallback).not.toHaveBeenCalled();
  });

  it('propagates a secure fallback failure instead of returning an invented ID', () => {
    const failure = new Error('Secure provider unavailable');
    vi.stubGlobal('crypto', {
      getRandomValues() {
        throw failure;
      },
    });

    expect(() => browserUuid()).toThrow(failure);
  });
});
