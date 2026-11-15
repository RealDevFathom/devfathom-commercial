import { describe, expect, it } from 'vitest';
import {
  assertWorkspaceIdentity,
  isTenantIdentityMismatch,
  tenantBrandTokens,
  type TenantBrand,
} from './tenant-brand';

const brand = (primaryColor: string | null, accentColor: string | null): TenantBrand => ({
  organizationId: 'org_chai_chowk',
  displayName: 'Chai Chowk Cafe',
  logoUrl: null,
  markUrl: null,
  faviconUrl: null,
  primaryColor,
  accentColor,
});

describe('workspace identity', () => {
  it('fails closed when displayed and authenticated organizations diverge', () => {
    expect(() => assertWorkspaceIdentity('org_session', 'org_displayed')).toThrow(
      'Workspace identity does not match the authenticated organization.'
    );
  });

  it('accepts identity derived from the authenticated organization', () => {
    expect(() => assertWorkspaceIdentity('org_1', 'org_1')).not.toThrow();
  });
});

describe('tenantBrandTokens', () => {
  it('leaves Studio theme tokens in control when organization branding is unset', () => {
    expect(tenantBrandTokens(brand(null, null))).toEqual({});
  });

  it('overrides primary and accent token families together', () => {
    expect(tenantBrandTokens(brand('#FF684F', '#246B5A'))).toMatchObject({
      '--primary': '#FF684F',
      '--primary-hover': '#FF684F',
      '--primary-foreground': '#111110',
      '--accent-brand': '#246B5A',
      '--accent-brand-hover': '#246B5A',
      '--ring': '#246B5A',
    });
  });
});

describe('tenantBrandTokens in the dark theme', () => {
  it('leaves the dark --primary family to the theme so primary text stays readable', () => {
    const tokens = tenantBrandTokens(brand('#FF684F', '#246B5A'), 'dark');
    expect(tokens).not.toHaveProperty('--primary');
    expect(tokens).not.toHaveProperty('--primary-hover');
    expect(tokens).not.toHaveProperty('--primary-foreground');
    expect(tokens).toMatchObject({ '--sidebar': '#FF684F', '--accent-brand': '#246B5A' });
  });
});

describe('isTenantIdentityMismatch', () => {
  it('accepts chrome that names the same organization as the session', () => {
    expect(isTenantIdentityMismatch({ organizationId: 'org_a' }, 'org_a')).toBe(false);
  });

  it('rejects chrome left over from another organization', () => {
    expect(isTenantIdentityMismatch({ organizationId: 'org_a' }, 'org_b')).toBe(true);
  });

  it('holds render rather than blocking while the session organization is unknown', () => {
    // The `/(app)` layout has already proven the actor server-side; an absent
    // client value means "not hydrated yet", not "wrong tenant".
    expect(isTenantIdentityMismatch({ organizationId: 'org_a' }, undefined)).toBe(false);
    expect(isTenantIdentityMismatch({ organizationId: 'org_a' }, null)).toBe(false);
    expect(isTenantIdentityMismatch({ organizationId: 'org_a' }, '')).toBe(false);
  });

  it('fails closed when the chrome cannot say which organization it describes', () => {
    // An unattributable brand alongside a known session organization is a
    // programming error, and the safe reading of it is "not this tenant".
    expect(isTenantIdentityMismatch({ organizationId: '' }, 'org_b')).toBe(true);
  });

  it('is case- and whitespace-exact, never a fuzzy match on tenant identity', () => {
    expect(isTenantIdentityMismatch({ organizationId: 'org_a' }, 'ORG_A')).toBe(true);
    expect(isTenantIdentityMismatch({ organizationId: 'org_a' }, ' org_a')).toBe(true);
  });
});
