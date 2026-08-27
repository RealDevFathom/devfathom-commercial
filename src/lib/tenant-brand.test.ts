import { describe, expect, it } from 'vitest';
import { tenantBrandTokens, type TenantBrand } from './tenant-brand';

const brand = (primaryColor: string | null, accentColor: string | null): TenantBrand => ({
  displayName: 'Chai Chowk Cafe',
  logoUrl: null,
  markUrl: null,
  faviconUrl: null,
  primaryColor,
  accentColor,
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
