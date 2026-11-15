// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/storage', () => ({
  putUpload: vi.fn(),
  getUpload: vi.fn(),
  deleteUpload: vi.fn(),
}));

import { hasAllCapabilityAccess } from '@/lib/abac/owner-access';
import { isLiveOrganizationOwner } from '@/lib/pharmacy/owner-data-export';
import {
  actorCanProcure,
  actorCanReadPurchasing,
  actorCanSelectPurchaseWitness,
  actorIsPharmacyOwner,
  procurementBranchIds,
  procurementGrantedForUser,
} from '@/lib/pharmacy/procurement-access';
import { isSoloPharmacyOwner } from '@/lib/pharmacy/solo-owner';
import { parseAccountChanges, recordAccountChanges } from '@/lib/pharmacy/whatsapp/account-quality';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';

type Rule = { capability: string; effect: 'ALLOW' | 'DENY' };

// A DENY that no caller pre-checks: it only bites if the helper itself honors it.
const UNRELATED_DENY: Rule = { capability: 'reports:export', effect: 'DENY' };

const IDENTITIES = [
  {
    label: 'system Owner',
    role: 'EMPLOYEE',
    organizationRole: { key: 'owner', isSystem: true, permissions: [] as Rule[] },
    overrides: [] as Rule[],
  },
  {
    label: 'ADMIN with a role `*` grant',
    role: 'ADMIN',
    organizationRole: {
      key: 'custom-admin',
      isSystem: false,
      permissions: [{ capability: '*', effect: 'ALLOW' }] as Rule[],
    },
    overrides: [] as Rule[],
  },
  {
    label: 'ADMIN with an override `*` grant',
    role: 'ADMIN',
    organizationRole: null,
    overrides: [{ capability: '*', effect: 'ALLOW' }] as Rule[],
  },
] as const;

function userRow(identity: (typeof IDENTITIES)[number], extra: Rule[] = []) {
  return {
    id: 'user',
    status: 'ACTIVE',
    role: identity.role,
    organizationRole: identity.organizationRole,
    permissionOverrides: [...identity.overrides, ...extra],
  };
}

function fakeDb(row: ReturnType<typeof userRow>) {
  const notifications: Array<Record<string, unknown>> = [];
  const db = {
    user: {
      findUnique: vi.fn().mockResolvedValue(row),
      findFirst: vi.fn().mockResolvedValue(row),
      findMany: vi.fn(async (args: { select?: { organizationRole?: unknown } }) =>
        // Owner lookups load the role; the solo-owner member count only loads ids.
        args.select?.organizationRole ? [row] : [{ id: row.id }]
      ),
    },
    pharmacyBranch: {
      findMany: vi.fn().mockResolvedValue([{ id: 'branch_a' }, { id: 'branch_b' }]),
    },
    pharmacyBranchAssignment: { findMany: vi.fn().mockResolvedValue([]) },
    pharmacyWhatsAppAccountEvent: {
      createMany: vi.fn().mockResolvedValue({ count: 1 }),
      findFirst: vi.fn().mockResolvedValue({ id: 'evt-1' }),
    },
    notification: {
      createMany: vi.fn(async ({ data }: { data: Array<Record<string, unknown>> }) => {
        notifications.push(...data);
        return { count: data.length };
      }),
    },
  };
  return { db: db as unknown as ScopedDb, notifications };
}

const now = new Date('2026-11-15T12:00:00Z');
const blockChange = () =>
  parseAccountChanges(
    {
      object: 'whatsapp_business_account',
      entry: [
        {
          id: 'waba-a',
          time: Math.floor(now.getTime() / 1000) - 60,
          changes: [{ field: 'account_update', value: { event: 'DISABLED_UPDATE' } }],
        },
      ],
    },
    'waba-a',
    now
  );

const OWNER_ONLY_PATHS = [
  'hasAllCapabilityAccess',
  'actorIsPharmacyOwner',
  'procurementBranchIsOrgWide',
  'isSoloPharmacyOwner',
  'isLiveOrganizationOwner',
] as const;

/** Every path that rests on hasAllCapabilityAccess, directly or through a wrapper. */
async function ownerPaths(db: ScopedDb, row: ReturnType<typeof userRow>) {
  return {
    hasAllCapabilityAccess: hasAllCapabilityAccess(row),
    procurementGrantedForUser: procurementGrantedForUser(row),
    actorCanProcure: await actorCanProcure(db, 'user'),
    actorCanReadPurchasing: await actorCanReadPurchasing(db, 'user'),
    actorCanSelectPurchaseWitness: await actorCanSelectPurchaseWitness(db, 'user'),
    actorIsPharmacyOwner: await actorIsPharmacyOwner(db, 'org', 'user'),
    procurementBranchIsOrgWide:
      (await procurementBranchIds(db, 'org', 'user')).join(',') === 'branch_a,branch_b',
    isSoloPharmacyOwner: await isSoloPharmacyOwner(db, {
      organizationId: 'org',
      actorId: 'user',
      actorOrganizationId: 'org',
    }),
    isLiveOrganizationOwner: await isLiveOrganizationOwner(db, 'org', 'user'),
  };
}

describe('hasAllCapabilityAccess: an explicit DENY wins', () => {
  it.each(IDENTITIES)('the $label keeps owner authority without a DENY', async (identity) => {
    const row = userRow(identity);
    const { db } = fakeDb(row);
    const paths = await ownerPaths(db, row);
    for (const [path, granted] of Object.entries(paths))
      expect([path, granted]).toEqual([path, true]);
  });

  it.each(IDENTITIES)(
    'the $label with an unrelated DENY override loses every owner-only path',
    async (identity) => {
      const row = userRow(identity, [UNRELATED_DENY]);
      const { db } = fakeDb(row);
      const paths = await ownerPaths(db, row);
      for (const path of OWNER_ONLY_PATHS) expect([path, paths[path]]).toEqual([path, false]);
      if (identity.label === 'system Owner') {
        // No explicit grant: these were reachable only through the owner bypass.
        for (const [path, granted] of Object.entries(paths))
          expect([path, granted]).toEqual([path, false]);
      }
    }
  );

  it.each(IDENTITIES)('the $label with a `*` DENY override loses every path', async (identity) => {
    const row = userRow(identity, [{ capability: '*', effect: 'DENY' }]);
    const { db } = fakeDb(row);
    const paths = await ownerPaths(db, row);
    for (const [path, granted] of Object.entries(paths))
      expect([path, granted]).toEqual([path, false]);
  });

  it('a DENY rule on the role itself also disqualifies a wildcard ADMIN', () => {
    expect(
      hasAllCapabilityAccess({
        status: 'ACTIVE',
        role: 'ADMIN',
        organizationRole: {
          key: 'custom-admin',
          permissions: [{ capability: '*', effect: 'ALLOW' }, UNRELATED_DENY],
        },
        permissionOverrides: [],
      })
    ).toBe(false);
  });

  it('an inactive owner never qualifies', () => {
    expect(hasAllCapabilityAccess({ ...userRow(IDENTITIES[0]), status: 'SUSPENDED' })).toBe(false);
  });

  it('WhatsApp account alerts skip an owner with an explicit DENY override', async () => {
    const allowed = fakeDb(userRow(IDENTITIES[0]));
    await recordAccountChanges(allowed.db, 'org', blockChange(), { now });
    expect(allowed.notifications.map((n) => n.userId)).toEqual(['user']);

    const denied = fakeDb(userRow(IDENTITIES[0], [UNRELATED_DENY]));
    await recordAccountChanges(denied.db, 'org', blockChange(), { now });
    expect(denied.notifications).toEqual([]);
  });
});
