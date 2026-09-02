/**
 * WHA-1181 — `withOrganizationDefaults` installs the tenant's id as
 * `app.current_organization_id` so the many tenant tables whose `organizationId`
 * column DEFAULTs to that GUC resolve it. The platform control plane blanks that
 * GUC, which is exactly where provisioning writes, so getting this wrong lands
 * rows owned by the empty string.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
vi.mock('@/lib/db', () => ({ db: {} }));

import { withOrganizationDefaults } from './scoped-db';
import type { ScopedDb } from './scoped-db';

function fakeTx(previous: string | null = '') {
  const calls: { sql: string; args: unknown[] }[] = [];
  const tx = {
    $queryRawUnsafe: vi.fn(async (sql: string, ...args: unknown[]) => {
      calls.push({ sql, args });
      return sql.includes('SELECT current_setting') ? [{ value: previous }] : [];
    }),
  } as unknown as ScopedDb;
  return { tx, calls };
}

/** The organization ids passed to `set_config`, in order. */
function configuredIds(calls: { sql: string; args: unknown[] }[]) {
  return calls.filter((call) => call.sql.includes('set_config')).map((call) => call.args[0]);
}

describe('withOrganizationDefaults', () => {
  it('installs the organization id for the callback and restores the previous value', async () => {
    const { tx, calls } = fakeTx('');
    const seen: string[] = [];

    const result = await withOrganizationDefaults(tx, 'org_new', async (inner) => {
      expect(inner).toBe(tx);
      seen.push('ran');
      return 'value';
    });

    expect(result).toBe('value');
    expect(seen).toEqual(['ran']);
    expect(configuredIds(calls)).toEqual(['org_new', '']);
  });

  it('restores a tenant transaction’s own id rather than blanking it', async () => {
    // The tenant-side self-service repair calls this inside `withTenantDb`,
    // where the GUC is already the caller's organization. Restoring '' there
    // would strip tenant scoping from the rest of the request.
    const { tx, calls } = fakeTx('org_existing');

    await withOrganizationDefaults(tx, 'org_existing', async () => 'ok');

    expect(configuredIds(calls)).toEqual(['org_existing', 'org_existing']);
  });

  it('restores the previous value even when the callback throws', async () => {
    const { tx, calls } = fakeTx('');

    await expect(
      withOrganizationDefaults(tx, 'org_new', async () => {
        throw new Error('provisioning failed');
      })
    ).rejects.toThrow('provisioning failed');

    expect(configuredIds(calls)).toEqual(['org_new', '']);
  });

  it('rejects an identifier that is not a plausible organization id', async () => {
    const { tx, calls } = fakeTx('');
    const run = vi.fn();

    // The id is interpolated as a bound parameter, but the guard is the same one
    // `withTenantDb` uses and it fails before any statement runs.
    await expect(withOrganizationDefaults(tx, "'; DROP TABLE", run)).rejects.toThrow(
      'Invalid organization identifier.'
    );
    expect(run).not.toHaveBeenCalled();
    expect(calls).toEqual([]);
  });
});
