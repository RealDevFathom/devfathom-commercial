import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/entitlements', () => ({
  hasModule: (entitlements: { enabledModules: string[] }, key: string) =>
    entitlements.enabledModules.includes(key),
}));

import { PHARMACY_ROLE_TEMPLATES } from '@/lib/vertical-catalog';
import { resolvePharmacyAdvice, resolvePharmacyDashboardAccess } from './dashboard-access';

const EVERY_MODULE = [
  'pharmacy-core',
  'pharmacy-counter',
  'pharmacy-inventory',
  'pharmacy-procurement',
  'pharmacy-dispensing',
  'pharmacy-reports',
  'pharmacy-crm',
];
const entitlements = (enabledModules = EVERY_MODULE) =>
  ({ organizationId: 'org', enabledModules, modules: [] }) as never;

/** The real ABAC engine over a member holding one pharmacy role template's grants. */
function member(template: string) {
  const capabilities = PHARMACY_ROLE_TEMPLATES.find((role) => role.key === template)!.capabilities;
  const findUnique = vi.fn().mockResolvedValue({
    organizationRole: {
      permissions: capabilities.map((capability) => ({ capability, effect: 'ALLOW' })),
    },
    permissionOverrides: [],
  });
  return { db: { user: { findUnique } } as never, findUnique };
}

const viewer = (role: 'ADMIN' | 'EMPLOYEE') => ({ id: 'viewer', role, status: 'ACTIVE' });

describe('resolvePharmacyDashboardAccess (DEV-602)', () => {
  it('gives a cashier no reports and only the counter tools the role opens', async () => {
    const { db } = member('cashier');
    const access = await resolvePharmacyDashboardAccess(db, viewer('EMPLOYEE'), entitlements());
    expect(access.reports).toBe(false);
    expect(access.advice).toEqual([]);
    expect(access.tools.map((tool) => tool.href)).toEqual([
      '/pharmacy/counter',
      '/pharmacy/orders',
    ]);
  });

  it('gives a pharmacist the queue and day close, still without reports', async () => {
    const { db } = member('pharmacist');
    const access = await resolvePharmacyDashboardAccess(db, viewer('EMPLOYEE'), entitlements());
    expect(access.reports).toBe(false);
    expect(access.tools.map((tool) => tool.href)).toEqual([
      '/pharmacy/counter/close',
      '/pharmacy/pharmacist-queue',
    ]);
  });

  it('never offers a tool whose module is not licensed', async () => {
    const { db } = member('cashier');
    const access = await resolvePharmacyDashboardAccess(
      db,
      viewer('EMPLOYEE'),
      entitlements(['pharmacy-core'])
    );
    expect(access.tools).toEqual([]);
  });

  it('gives the owner the command centre and no substitute tool list', async () => {
    const { db } = member('owner');
    const access = await resolvePharmacyDashboardAccess(db, viewer('ADMIN'), entitlements());
    expect(access.reports).toBe(true);
    expect(access.tools).toEqual([]);
  });

  it('gives an auditor (reports:operational only) the command centre', async () => {
    const { db } = member('auditor');
    const access = await resolvePharmacyDashboardAccess(db, viewer('EMPLOYEE'), entitlements());
    expect(access.reports).toBe(true);
  });

  it('fails closed when the grant lookup throws', async () => {
    const db = { user: { findUnique: vi.fn().mockRejectedValue(new Error('down')) } } as never;
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const access = await resolvePharmacyDashboardAccess(db, viewer('ADMIN'), entitlements());
    error.mockRestore();
    expect(access).toEqual({ reports: false, tools: [], advice: [] });
  });
});

describe('advice entry points open only for whoever the target page admits (DEV-594)', () => {
  const keys = (links: ReadonlyArray<{ key: string }>) => links.map((link) => link.key);

  it('offers the owner reorder, expiry and growth advice on the dashboard', async () => {
    const { db, findUnique } = member('owner');
    const access = await resolvePharmacyDashboardAccess(db, viewer('ADMIN'), entitlements());
    expect(access.advice.map((link) => link.href)).toEqual([
      '/pharmacy/reports/replenishment',
      '/pharmacy/reports',
      '/pharmacy/marketing',
    ]);
    // One grant lookup per action, however many links name it.
    expect(findUnique).toHaveBeenCalledTimes(2);
  });

  it('drops growth insights when Pharmacy CRM is not licensed', async () => {
    const { db } = member('owner');
    const access = await resolvePharmacyDashboardAccess(
      db,
      viewer('ADMIN'),
      entitlements(EVERY_MODULE.filter((module) => module !== 'pharmacy-crm'))
    );
    expect(keys(access.advice)).toEqual(['reorder', 'expiry']);
  });

  it('offers an auditor reorder advice only: expiry and growth are owner reports', async () => {
    const { db } = member('auditor');
    const access = await resolvePharmacyDashboardAccess(db, viewer('EMPLOYEE'), entitlements());
    expect(keys(access.advice)).toEqual(['reorder']);
  });

  it('withholds owner advice from a non-owner holding the owner template’s grants', async () => {
    const { db } = member('owner');
    expect(
      keys(
        await resolvePharmacyAdvice(db, viewer('EMPLOYEE'), entitlements(), ['expiry', 'growth'])
      )
    ).toEqual([]);
  });

  it('withholds owner advice from an owner without financial reports', async () => {
    const { db } = member('auditor');
    expect(
      keys(await resolvePharmacyAdvice(db, viewer('ADMIN'), entitlements(), ['reorder', 'expiry']))
    ).toEqual(['reorder']);
  });

  it('offers a cashier no advice and asks nothing once a gate fails', async () => {
    const { db, findUnique } = member('cashier');
    expect(
      await resolvePharmacyAdvice(db, viewer('EMPLOYEE'), entitlements(), ['reorder'])
    ).toEqual([]);
    const access = await resolvePharmacyDashboardAccess(db, viewer('EMPLOYEE'), entitlements());
    expect(access.advice).toEqual([]);
    findUnique.mockClear();
    expect(
      await resolvePharmacyAdvice(db, viewer('EMPLOYEE'), entitlements(['pharmacy-core']), [
        'reorder',
        'expiry',
        'growth',
      ])
    ).toEqual([]);
    expect(findUnique).not.toHaveBeenCalled();
  });
});
