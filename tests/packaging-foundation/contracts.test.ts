import { describe, expect, it, vi } from 'vitest';
import { liveDemoAccessExpiry } from '@/lib/auth/session-state';
import {
  demoSeatFromOrganizationId,
  isCanonicalDemoOrganization,
  isReservedDemoOrganizationId,
} from '@/lib/tenancy/demo-identity';
import { demoSharedDeploymentOrigin } from '@/lib/platform/activation-gates';
import {
  isDemoMutationOrigin,
  isDemoProcedureBlocked,
  isDemoTenant,
} from '@/lib/tenancy/demo-isolation';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import type { DemoSeatIdentity } from '@/lib/platform/command-types';
import type { DemoSeatIdentity as LegacyIdentity } from '@/lib/demo/seed-data';

const organization = {
  id: 'org_demo_restaurant_seat_1',
  slug: 'demo-restaurant-seat-1',
  isDemo: true,
  status: 'ACTIVE',
  vertical: 'RESTAURANT',
  deploymentMode: 'SHARED',
};

describe('demo contract boundaries', () => {
  it.each([undefined, null, NaN, Infinity, '2000', 999, 1000])(
    'rejects unusable expiry %s',
    (value) => {
      expect(liveDemoAccessExpiry(value, 1000)).toBeNull();
    }
  );
  it('accepts only future finite expiry', () =>
    expect(liveDemoAccessExpiry(1001, 1000)).toBe(1001));
  it('enforces seat bounds and canonical spelling independently of the reserved prefix', () => {
    expect(demoSeatFromOrganizationId(organization.id, 1)).toBe(1);
    expect(demoSeatFromOrganizationId('org_demo_restaurant_seat_2', 1)).toBeNull();
    expect(demoSeatFromOrganizationId('org_demo_restaurant_seat_0', 5)).toBeNull();
    expect(demoSeatFromOrganizationId('ordinary', 5)).toBeNull();
    expect(isReservedDemoOrganizationId('org_demo_restaurant_seat_invalid')).toBe(true);
    expect(
      isCanonicalDemoOrganization({ ...organization, id: 'org_demo_restaurant_seat_01' }, 5)
    ).toBe(false);
    expect(isCanonicalDemoOrganization(organization, 5)).toBe(true);
  });
  it.each([
    { isDemo: false },
    { status: 'SUSPENDED' },
    { vertical: 'AGENCY' },
    { deploymentMode: 'DEDICATED' },
    { slug: 'other' },
  ])('rejects mismatched organization %o', (change) => {
    expect(isCanonicalDemoOrganization({ ...organization, ...change }, 5)).toBe(false);
  });
  it('preserves type compatibility without a seed runtime import', () => {
    const acceptLegacy = (value: LegacyIdentity): DemoSeatIdentity => value;
    const identity: DemoSeatIdentity = {
      seatNumber: 1,
      organizationId: 'organization',
      slug: 'workspace',
      displayName: 'Workspace',
      managerUserId: 'member',
      managerEmail: '',
    };
    expect(acceptLegacy(identity)).toBe(identity);
  });
});

describe('isolation', () => {
  it.each([
    'apiTokens.list',
    'email.send',
    'restaurantCameras.list',
    'restaurantMenuImport.list',
    'trelloImport.run',
    'webhooks.list',
  ])('blocks restricted prefix for queries and mutations: %s', (path) => {
    expect(isDemoProcedureBlocked(path, 'query')).toBe(true);
    expect(isDemoProcedureBlocked(path, 'mutation')).toBe(true);
  });
  it.each([
    'restaurantStaff.create',
    'restaurantDevices.revoke',
    'restaurantNotifications.configureWebhook',
    'team.changePassword',
    'twoFactor.disable',
    'organizationAdmin.setMemberGoodsInAccess',
  ])('blocks restricted mutation but preserves same-name query: %s', (path) => {
    expect(isDemoProcedureBlocked(path, 'mutation')).toBe(true);
    expect(isDemoProcedureBlocked(path, 'query')).toBe(false);
  });
  it('retains ordinary demo mutations', () =>
    expect(isDemoProcedureBlocked('restaurantOrders.create', 'mutation')).toBe(false));
  it.each([true, false, null, undefined, 'true'])(
    'reads only the supplied scoped organization, flag %s',
    async (flag) => {
      const findFirst = vi.fn().mockResolvedValue(flag === undefined ? null : { isDemo: flag });
      expect(await isDemoTenant({ organization: { findFirst } } as unknown as ScopedDb)).toBe(
        flag === true
      );
      expect(findFirst).toHaveBeenCalledExactlyOnceWith({ select: { isDemo: true } });
    }
  );
  it('propagates a scoped database failure', async () => {
    const error = new Error('scoped read failed');
    const findFirst = vi.fn().mockRejectedValue(error);
    await expect(isDemoTenant({ organization: { findFirst } } as unknown as ScopedDb)).rejects.toBe(
      error
    );
  });
  it.each([
    ['https://public.example.test', 'same-origin', true],
    ['https://public.example.test', 'none', true],
    ['https://public.example.test', 'same-site', false],
    ['https://other.example.test', 'same-origin', false],
    ['', 'same-origin', false],
    ['invalid origin', 'same-origin', false],
  ])('enforces public same-origin and fetch-site (%s, %s)', (origin, site, expected) => {
    const request = new Request('http://internal.invalid/path', {
      headers: {
        origin,
        'sec-fetch-site': site,
        'x-forwarded-host': 'public.example.test',
        'x-forwarded-proto': 'https',
      },
    });
    expect(isDemoMutationOrigin(request)).toBe(expected);
  });
});

describe('explicit origin metadata', () => {
  it('accepts only an allowed shared demo origin', () => {
    expect(
      demoSharedDeploymentOrigin(
        organization,
        'https://demo.example.test',
        'other.example.test, demo.example.test'
      )
    ).toBe('https://demo.example.test');
    expect(
      demoSharedDeploymentOrigin(
        { ...organization, isDemo: false },
        'https://demo.example.test',
        'demo.example.test'
      )
    ).toBeNull();
    expect(
      demoSharedDeploymentOrigin(organization, 'https://demo.example.test', 'other.example.test')
    ).toBeNull();
    expect(demoSharedDeploymentOrigin(organization, undefined, 'demo.example.test')).toBeNull();
  });
  it.each([
    'http://demo.example.test',
    'https://demo.example.test/path',
    'https://demo.example.test?x=1',
    'https://demo.example.test#x',
    'ftp://demo.example.test',
  ])('rejects unsafe or non-origin URL %s', (origin) => {
    expect(demoSharedDeploymentOrigin(organization, origin, 'demo.example.test')).toBeNull();
  });
  it('preserves loopback HTTP exception', () => {
    expect(
      demoSharedDeploymentOrigin(organization, 'http://localhost:3100', 'localhost:3100')
    ).toBe('http://localhost:3100');
  });
});
