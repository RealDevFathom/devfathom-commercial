import { describe, expect, it } from 'vitest';

import { assertDisposableRlsDatabase } from './disposable-rls-database';

describe('disposable RLS database guard', () => {
  it('allows an explicitly opted-in disposable cloud database and rejects unsafe targets', () => {
    expect(() =>
      assertDisposableRlsDatabase('postgresql://owner:x@db.example:5432/devfathom_ci_test', {
        ALLOW_REMOTE_RLS_TEST: 'true',
      })
    ).not.toThrow();

    for (const [url, env] of [
      ['postgresql://owner:x@db.example:5432/devfathom_ci_test', {}],
      ['postgresql://owner:x@db.example:5432/devfathom', { ALLOW_REMOTE_RLS_TEST: 'true' }],
      [
        'postgresql://owner:x@staging.example:5432/devfathom_ci_test',
        { ALLOW_REMOTE_RLS_TEST: 'true' },
      ],
    ] as const) {
      expect(() => assertDisposableRlsDatabase(url, env)).toThrow('Refusing remote RLS probes');
    }
  });
});
