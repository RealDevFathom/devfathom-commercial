import { describe, expect, it, vi } from 'vitest';
vi.mock('server-only', () => ({}));
vi.mock('@/lib/tenancy/scoped-db', () => ({ createTenantDb: vi.fn() }));
vi.mock('@/lib/tenancy/tenant-actor', () => ({ resolveTenantActor: vi.fn() }));
vi.mock('@/lib/entitlements', () => ({
  hasModule: vi.fn(() => true),
  resolveOrganizationEntitlements: vi.fn(),
}));
vi.mock('@/server/audit', () => ({
  ipFromHeaders: vi.fn(() => null),
  isAuditExcludedPath: vi.fn(() => false),
  recordTrpcAudit: vi.fn(),
}));

import { router, type TRPCContext } from '../trpc';
import { pharmacySalesRouter } from './pharmacy-sales';

const app = router({ pharmacySales: pharmacySalesRouter });

function fixture(role = 'EMPLOYEE', preset = 'legacySpeed', overrides = {}) {
  const db = {
    user: {
      findUnique: vi
        .fn()
        .mockResolvedValue({
          status: 'ACTIVE',
          organizationId: 'org-1',
          organizationRole: { permissions: [] },
          permissionOverrides: [],
        }),
    },
    pharmacyCounterKeymapPreference: {
      findFirst: vi.fn().mockResolvedValue({ preset, overrides }),
      upsert: vi.fn().mockResolvedValue({}),
    },
  };
  const context = {
    db,
    entitlements: { organizationId: 'org-1', enabledModules: ['pharmacy-counter'], modules: [] },
    session: {
      expires: 'later',
      user: { id: 'actor-1', role, status: 'ACTIVE', organizationId: 'org-1' },
    },
    organization: { id: 'org-1' },
    support: null,
    requestMeta: { ip: null, userAgent: null },
    audit: { detail: {} },
  } as unknown as TRPCContext;
  return { db, caller: app.createCaller(context).pharmacySales };
}

describe('counter keymap preset availability', () => {
  it('falls back to the confirmed default for a saved staff proposal, including its overrides', async () => {
    const f = fixture('EMPLOYEE', 'legacySpeed', { openTender: { key: 'F12' } });
    await expect(f.caller.counterKeymap()).resolves.toMatchObject({
      preset: { key: 'devfathom', confirmed: true },
      stored: false,
      bindings: { resumeSale: { key: 'F8' }, openTender: { key: 'F9' } },
    });
    expect(f.db.pharmacyCounterKeymapPreference.upsert).not.toHaveBeenCalled();
  });

  it('rejects a staff attempt to save an unconfirmed preset before writing', async () => {
    const f = fixture();
    await expect(
      f.caller.counterSaveKeymap({ preset: 'legacySpeed', overrides: {} })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(f.db.pharmacyCounterKeymapPreference.upsert).not.toHaveBeenCalled();
  });

  it('keeps confirmed staff overrides and their actual F8/F9 assignments', async () => {
    const f = fixture('EMPLOYEE', 'devfathom', {
      resumeSale: { key: 'F9' },
      openTender: { key: 'F8' },
    });
    await expect(f.caller.counterKeymap()).resolves.toMatchObject({
      preset: { key: 'devfathom' },
      stored: true,
      bindings: { resumeSale: { key: 'F9' }, openTender: { key: 'F8' } },
    });
    await expect(
      f.caller.counterSaveKeymap({ preset: 'devfathom', overrides: {} })
    ).resolves.toMatchObject({ stored: true });
    expect(f.db.pharmacyCounterKeymapPreference.upsert).toHaveBeenCalledOnce();
  });

  it('retains explicitly unconfirmed owner/admin preview', async () => {
    const f = fixture('ADMIN');
    await expect(f.caller.counterKeymap()).resolves.toMatchObject({
      preset: { key: 'legacySpeed', confirmed: false },
      stored: true,
    });
    await expect(
      f.caller.counterSaveKeymap({ preset: 'legacySpeed', overrides: {} })
    ).resolves.toMatchObject({ stored: true });
    expect(f.db.pharmacyCounterKeymapPreference.upsert).toHaveBeenCalledOnce();
  });
});
