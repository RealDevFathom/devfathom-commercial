// @vitest-environment node
import { expect, it, vi } from 'vitest';
import * as limits from '@/lib/rate-limit';
import { admitAnonymousRequest } from './anonymous-rate-limit';

it('limits repeated uploads from a link even as addresses change', async () => {
  const results = [];
  for (let i = 0; i < 5; i++)
    results.push(
      await admitAnonymousRequest({
        kind: 'supplier-upload',
        token: 'fixture-repeat',
        ip: '192.0.2.' + i,
      })
    );
  expect(results.map((result) => result.ok)).toEqual([true, true, true, true, false]);
});
it('limits uploads from one address across different links', async () => {
  const results = [];
  for (let i = 0; i < 9; i++)
    results.push(
      await admitAnonymousRequest({
        kind: 'supplier-upload',
        token: 'fixture-distinct-' + i,
        ip: '198.51.100.1',
      })
    );
  expect(results.map((result) => result.ok)).toEqual([
    true,
    true,
    true,
    true,
    true,
    true,
    true,
    true,
    false,
  ]);
});

it.each(['supplier-link', 'supplier-upload', 'token', 'host'] as const)(
  'charges the expected gates for %s with an unknown address',
  async (kind) => {
    const spy = vi.spyOn(limits, 'rateLimit');
    try {
      await admitAnonymousRequest({ kind, token: 'synthetic', ip: 'unknown' });
      const keys = spy.mock.calls.map(([key]) => key);
      const supplier = kind === 'supplier-link' || kind === 'supplier-upload';
      expect(keys).toContain('anon:trpc:global');
      expect(keys.includes('anon:trpc:ip:unknown')).toBe(!supplier);
      expect(keys.some((key) => key.startsWith('anon:trpc:token:'))).toBe(kind !== 'host');
      expect(keys.some((key) => key.startsWith('supplier-upload:token:'))).toBe(
        kind === 'supplier-upload'
      );
      expect(keys).not.toContain('supplier-upload:ip:unknown');
    } finally {
      spy.mockRestore();
    }
  }
);
