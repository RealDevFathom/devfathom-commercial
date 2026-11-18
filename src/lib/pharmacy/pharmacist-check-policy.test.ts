import { describe, expect, it, vi } from 'vitest';

import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import { PHARMACIST_CHECK_DISCLAIMER, pharmacistCheckDisclaimerRecord } from './pharmacist-check';
import {
  isPharmacistCheckPolicyOwner,
  PharmacistCheckPolicyError,
  pharmacistCheckAtSaleEnabled,
  readPharmacistCheckPolicy,
  writePharmacistCheckPolicy,
} from './pharmacist-check-policy';

// DEV-911: one organisation setting, ON by default; only an explicit stored OFF turns it off.

function readerDb(findUnique: () => unknown) {
  return { pharmacyOwnerPolicy: { findUnique: vi.fn(findUnique) } } as unknown as ScopedDb;
}

describe('readPharmacistCheckPolicy / pharmacistCheckAtSaleEnabled', () => {
  it('is on when the pharmacy has no policy row (every existing and new pharmacy)', async () => {
    const db = readerDb(async () => null);
    await expect(readPharmacistCheckPolicy(db, 'org-1')).resolves.toEqual({
      enabled: true,
      version: 0,
      source: 'DEFAULT',
    });
    await expect(pharmacistCheckAtSaleEnabled(db, 'org-1')).resolves.toBe(true);
  });

  it('is on when the stored setting is on', async () => {
    const db = readerDb(async () => ({
      pharmacistCheckEnabled: true,
      pharmacistCheckPolicyVersion: 2,
    }));
    await expect(pharmacistCheckAtSaleEnabled(db, 'org-1')).resolves.toBe(true);
  });

  it('is off only when the owner stored it off', async () => {
    const db = readerDb(async () => ({
      pharmacistCheckEnabled: false,
      pharmacistCheckPolicyVersion: 3,
    }));
    await expect(readPharmacistCheckPolicy(db, 'org-1')).resolves.toEqual({
      enabled: false,
      version: 3,
      source: 'STORED',
    });
    await expect(pharmacistCheckAtSaleEnabled(db, 'org-1')).resolves.toBe(false);
  });

  it.each([
    ['an unreadable setting', () => Promise.reject(new Error('connection lost'))],
    [
      'a malformed value',
      async () => ({ pharmacistCheckEnabled: 'no', pharmacistCheckPolicyVersion: 1 }),
    ],
    [
      'an OFF with no version',
      async () => ({ pharmacistCheckEnabled: false, pharmacistCheckPolicyVersion: 0 }),
    ],
    ['a missing version', async () => ({ pharmacistCheckEnabled: false })],
  ])('keeps the check on for %s', async (_label, read) => {
    await expect(pharmacistCheckAtSaleEnabled(readerDb(read), 'org-1')).resolves.toBe(true);
  });

  it('keeps the check on when the database has no policy reader at all', async () => {
    await expect(pharmacistCheckAtSaleEnabled({} as ScopedDb, 'org-1')).resolves.toBe(true);
  });

  it('keeps the check on without an organization, and never reads another tenant', async () => {
    const db = readerDb(async () => ({
      pharmacistCheckEnabled: false,
      pharmacistCheckPolicyVersion: 1,
    }));
    await expect(pharmacistCheckAtSaleEnabled(db, undefined)).resolves.toBe(true);
    await pharmacistCheckAtSaleEnabled(db, 'org-1');
    expect(
      (db as unknown as { pharmacyOwnerPolicy: { findUnique: ReturnType<typeof vi.fn> } })
        .pharmacyOwnerPolicy.findUnique
    ).toHaveBeenCalledWith(expect.objectContaining({ where: { organizationId: 'org-1' } }));
  });
});

type Rule = { capability: string; effect: 'ALLOW' | 'DENY' };

function ownerDb(user: {
  role?: { key: string; isSystem: boolean; organizationId?: string; permissions?: Rule[] } | null;
  overrides?: Rule[];
  status?: string;
}) {
  return {
    $queryRaw: vi.fn(async () => []),
    user: {
      findFirst: vi.fn(async () =>
        user.status === 'GONE'
          ? null
          : {
              id: 'user-1',
              organizationId: 'org-1',
              status: user.status ?? 'ACTIVE',
              organizationRole: user.role
                ? {
                    organizationId: 'org-1',
                    permissions: [{ capability: '*', effect: 'ALLOW' }],
                    ...user.role,
                  }
                : null,
              permissionOverrides: user.overrides ?? [],
            }
      ),
    },
  } as unknown as ScopedDb;
}

describe('isPharmacistCheckPolicyOwner', () => {
  it('allows the tenant owner', async () => {
    await expect(
      isPharmacistCheckPolicyOwner(
        ownerDb({ role: { key: 'owner', isSystem: true } }),
        'org-1',
        'user-1'
      )
    ).resolves.toBe(true);
  });

  it.each([
    ['a manager', { key: 'manager', isSystem: true }],
    ['a pharmacist', { key: 'pharmacist', isSystem: true }],
    ['a cashier', { key: 'cashier', isSystem: true }],
    ['a custom role named owner', { key: 'owner', isSystem: false }],
    ['another tenant’s owner role', { key: 'owner', isSystem: true, organizationId: 'org-2' }],
  ])('refuses %s', async (_label, role) => {
    await expect(isPharmacistCheckPolicyOwner(ownerDb({ role }), 'org-1', 'user-1')).resolves.toBe(
      false
    );
  });

  it('refuses an ADMIN without the owner role', async () => {
    await expect(
      isPharmacistCheckPolicyOwner(ownerDb({ role: null }), 'org-1', 'user-1')
    ).resolves.toBe(false);
  });

  it('refuses an owner who is not active', async () => {
    await expect(
      isPharmacistCheckPolicyOwner(ownerDb({ status: 'GONE' }), 'org-1', 'user-1')
    ).resolves.toBe(false);
  });

  it.each(['*', 'pharmacy:*', 'pharmacy:manage', 'pharmacy:dispense'])(
    'refuses an owner with a live DENY on %s',
    async (capability) => {
      await expect(
        isPharmacistCheckPolicyOwner(
          ownerDb({
            role: { key: 'owner', isSystem: true },
            overrides: [{ capability, effect: 'DENY' }],
          }),
          'org-1',
          'user-1'
        )
      ).resolves.toBe(false);
    }
  );
});

function writerDb(current: unknown[], written: unknown[]) {
  const queryRaw = vi.fn().mockResolvedValueOnce(current).mockResolvedValueOnce(written);
  return { db: { $queryRaw: queryRaw } as unknown as ScopedDb, queryRaw };
}

function sqlText(call: unknown[]): { text: string; values: unknown[] } {
  const sql = call[0] as { strings?: string[]; sql?: string; values: unknown[] };
  return { text: sql.sql ?? (sql.strings ?? []).join('?'), values: sql.values };
}

const scope = { organizationId: 'org-1', actorId: 'owner-1' };
const accepted = { accepted: true, version: PHARMACIST_CHECK_DISCLAIMER.version };

describe('writePharmacistCheckPolicy', () => {
  it('turns the check off with the accepted disclaimer text stored for the audit', async () => {
    const { db, queryRaw } = writerDb([], [{ enabled: false, version: 1 }]);
    const result = await writePharmacistCheckPolicy(db, scope, {
      enabled: false,
      expectedVersion: 0,
      disclaimer: accepted,
    });
    expect(result).toMatchObject({
      changed: true,
      previous: { enabled: true, source: 'DEFAULT' },
      policy: { enabled: false, version: 1, source: 'STORED' },
      acceptedDisclaimer: pharmacistCheckDisclaimerRecord(),
    });
    expect(result.acceptedDisclaimer).toContain(PHARMACIST_CHECK_DISCLAIMER.text);
    const insert = sqlText(queryRaw.mock.calls[1]!);
    expect(insert.text).toContain('INSERT INTO "pharmacy_owner_policies"');
    expect(insert.values).toEqual(['org-1', false, pharmacistCheckDisclaimerRecord(), 'owner-1']);
  });

  it('refuses to turn the check off without the disclaimer ticked', async () => {
    for (const disclaimer of [undefined, { ...accepted, accepted: false }]) {
      const { db, queryRaw } = writerDb([], []);
      await expect(
        writePharmacistCheckPolicy(db, scope, { enabled: false, expectedVersion: 0, disclaimer })
      ).rejects.toEqual(new PharmacistCheckPolicyError('DISCLAIMER_REQUIRED'));
      expect(queryRaw).toHaveBeenCalledTimes(1);
    }
  });

  it('refuses a disclaimer the owner was not shown', async () => {
    const { db } = writerDb([], []);
    await expect(
      writePharmacistCheckPolicy(db, scope, {
        enabled: false,
        expectedVersion: 0,
        disclaimer: { accepted: true, version: 'pharmacist-check-off@0' },
      })
    ).rejects.toMatchObject({ reason: 'STALE_DISCLAIMER' });
  });

  it('turns the check back on without a disclaimer', async () => {
    const { db, queryRaw } = writerDb(
      [{ enabled: false, version: 1 }],
      [{ enabled: true, version: 2 }]
    );
    await expect(
      writePharmacistCheckPolicy(db, scope, { enabled: true, expectedVersion: 1 })
    ).resolves.toMatchObject({ changed: true, policy: { enabled: true, version: 2 } });
    const update = sqlText(queryRaw.mock.calls[1]!);
    expect(update.text).toContain('UPDATE "pharmacy_owner_policies"');
    expect(update.values).toEqual([true, null, 'owner-1', 'org-1', 1]);
  });

  it('changes nothing when the requested state is already in force', async () => {
    const { db, queryRaw } = writerDb([], []);
    await expect(
      writePharmacistCheckPolicy(db, scope, { enabled: true, expectedVersion: 7 })
    ).resolves.toMatchObject({ changed: false });
    expect(queryRaw).toHaveBeenCalledTimes(1);
  });

  it('refuses a stale version', async () => {
    const { db } = writerDb([{ enabled: true, version: 4 }], []);
    await expect(
      writePharmacistCheckPolicy(db, scope, {
        enabled: false,
        expectedVersion: 3,
        disclaimer: accepted,
      })
    ).rejects.toMatchObject({ reason: 'VERSION_CONFLICT' });
  });
});
