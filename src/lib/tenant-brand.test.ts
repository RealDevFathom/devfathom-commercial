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

/** WCAG 2 contrast ratio, computed independently of the implementation. */
function contrast(a: string, b: string): number {
  const luminance = (hex: string) => {
    const [red, green, blue] = [1, 3, 5].map((index) => {
      const value = Number.parseInt(hex.slice(index, index + 2), 16) / 255;
      return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * red! + 0.7152 * green! + 0.0722 * blue!;
  };
  const [high, low] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (high! + 0.05) / (low! + 0.05);
}

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
      '--primary-hover': '#d95a45',
      '--primary-foreground': '#111110',
      '--accent-brand': '#246B5A',
      '--accent-brand-hover': '#246B5A',
      '--ring': '#246B5A',
    });
  });

  it('gives a branded primary a hover fill that differs from its rest fill', () => {
    // The default saved brand is the light-theme ink; on a dark card its hover
    // must still move, toward the brand's own foreground.
    const ink = tenantBrandTokens(brand('#111110', null));
    expect(ink['--primary-hover']).toBe('#373735');
    expect(ink['--primary-hover']).not.toBe(ink['--primary']);

    for (const colour of ['#FF684F', '#246B5A', '#FFFFFF', '#000000']) {
      const tokens = tenantBrandTokens(brand(colour, null));
      expect(tokens['--primary-hover']).toMatch(/^#[0-9a-f]{6}$/);
      expect(tokens['--primary-hover']!.toLowerCase()).not.toBe(colour.toLowerCase());
    }
  });

  it('keeps the hovered primary label at 4.5:1 for mid-tone brands', () => {
    // Coral moved toward its light label would fall to 4.00:1, so its hover
    // moves away from the label instead.
    expect(tenantBrandTokens(brand('#bd3f2a', null))['--primary-hover']).toBe('#9f3523');

    for (const colour of [
      '#bd3f2a',
      '#2563eb',
      '#0f766e',
      '#246B5A',
      '#7c3aed',
      '#111110',
      '#FF684F',
    ]) {
      const tokens = tenantBrandTokens(brand(colour, null));
      expect(
        contrast(tokens['--primary-hover']!, tokens['--primary-foreground']!),
        colour
      ).toBeGreaterThanOrEqual(4.5);
    }
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
