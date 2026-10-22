import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/abac', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/abac')>();
  return { ...actual, can: vi.fn(actual.can) };
});

import type { PlatformRole } from '@/generated/prisma/client';
import { can } from '@/lib/abac';
import {
  assertCanBackfillPharmacyCatalog,
  canBackfillPharmacyCatalog,
  PLATFORM_RULE_SOURCES,
  type PlatformPermissionRule,
  type PlatformRuleSources,
} from './platform-authz';

const ALLOW: PlatformPermissionRule = { capability: 'pharmacy:catalog-backfill', effect: 'ALLOW' };
const DENY: PlatformPermissionRule = { capability: 'pharmacy:catalog-backfill', effect: 'DENY' };

function sources(
  role: PlatformPermissionRule[],
  actor: PlatformPermissionRule[]
): PlatformRuleSources {
  return { roleRules: () => role, actorRules: () => actor };
}

afterEach(() => {
  vi.mocked(can).mockClear();
  vi.restoreAllMocks();
});

describe('platform catalogue backfill authorization (CAT-SEC-02)', () => {
  it('is decided by the central can() for the modeled platform actor', async () => {
    await expect(canBackfillPharmacyCatalog({ id: 'p-1', role: 'SUPER_ADMIN' })).resolves.toBe(
      true
    );
    expect(can).toHaveBeenCalledWith(
      { id: 'p-1', role: 'SUPER_ADMIN', status: 'ACTIVE' },
      'pharmacy:catalog-backfill',
      { type: 'PharmacyCatalogBackfill' },
      expect.objectContaining({ source: 'SYSTEM', db: expect.anything() })
    );
  });

  it.each(['OPERATIONS', 'SALES', 'FINANCE', 'SUPPORT', 'AUDITOR'] as PlatformRole[])(
    'denies %s, whose role does not hold the exact grant',
    async (role) => {
      await expect(canBackfillPharmacyCatalog({ id: 'p-1', role })).resolves.toBe(false);
      await expect(assertCanBackfillPharmacyCatalog({ id: 'p-1', role })).rejects.toMatchObject({
        status: 403,
      });
    }
  );

  it('denies a SuperAdmin session that still has to enrol MFA, and a deactivated SuperAdmin', async () => {
    await expect(
      canBackfillPharmacyCatalog({ id: 'p-1', role: 'SUPER_ADMIN', enrollmentOnly: true })
    ).resolves.toBe(false);
    await expect(
      canBackfillPharmacyCatalog({ id: 'p-1', role: 'SUPER_ADMIN', active: false })
    ).resolves.toBe(false);
  });

  it('denies an explicit actor DENY over the role ALLOW (mixed grant)', async () => {
    await expect(
      canBackfillPharmacyCatalog({ id: 'p-1', role: 'SUPER_ADMIN' }, sources([ALLOW], [DENY]))
    ).resolves.toBe(false);
  });

  it('denies an explicit role DENY over an actor ALLOW (mixed grant)', async () => {
    await expect(
      canBackfillPharmacyCatalog({ id: 'p-1', role: 'OPERATIONS' }, sources([DENY], [ALLOW]))
    ).resolves.toBe(false);
  });

  it('lets a wildcard DENY revoke the exact grant', async () => {
    await expect(
      canBackfillPharmacyCatalog(
        { id: 'p-1', role: 'SUPER_ADMIN' },
        sources([ALLOW], [{ capability: 'pharmacy:*', effect: 'DENY' }])
      )
    ).resolves.toBe(false);
  });

  it('is never reached by a platform or tenant wildcard ALLOW alone', async () => {
    await expect(
      canBackfillPharmacyCatalog(
        { id: 'p-1', role: 'OPERATIONS' },
        sources(
          [{ capability: '*', effect: 'ALLOW' }],
          [{ capability: 'pharmacy:*', effect: 'ALLOW' }]
        )
      )
    ).resolves.toBe(false);
  });

  it('fails closed when a rule source fails', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await expect(
      canBackfillPharmacyCatalog(
        { id: 'p-1', role: 'SUPER_ADMIN' },
        {
          roleRules: PLATFORM_RULE_SOURCES.roleRules,
          actorRules: async () => {
            throw new Error('rule store unavailable');
          },
        }
      )
    ).resolves.toBe(false);
  });
});
