// @vitest-environment node
import { expect, it } from 'vitest';
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
