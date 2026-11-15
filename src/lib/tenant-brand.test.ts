import { describe, expect, it } from 'vitest';
import {
  assertWorkspaceIdentity,
  brandHoverColor,
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
      '--primary-hover': '#FF836F',
      '--primary-foreground': '#111110',
      '--accent-brand': '#246B5A',
      '--accent-brand-hover': '#1E584A',
      '--ring': '#246B5A',
    });
  });
});

describe('tenant brand hover tokens (DEV-51)', () => {
  it.each([
    ['#FF684F', '#246B5A'],
    ['#0C2E2C', '#F7F1E5'],
    ['#FFFFFF', '#000000'],
  ])('gives %s / %s a hover shade that differs from the resting colour', (primary, accent) => {
    const tokens = tenantBrandTokens(brand(primary, accent));
    expect(tokens['--primary-hover']).toMatch(/^#[0-9A-F]{6}$/);
    expect(tokens['--accent-brand-hover']).toMatch(/^#[0-9A-F]{6}$/);
    expect(tokens['--primary-hover']!.toUpperCase()).not.toBe(primary.toUpperCase());
    expect(tokens['--accent-brand-hover']!.toUpperCase()).not.toBe(accent.toUpperCase());
  });

  it('moves away from the label colour so hover contrast never drops', () => {
    // Dark brand under a light label darkens; light brand under a dark label lightens.
    expect(brandHoverColor('#246B5A')).toBe('#1E584A');
    expect(brandHoverColor('#FF684F')).toBe('#FF836F');
    // Already at the extreme: no room to move away, so it moves toward the label.
    expect(brandHoverColor('#FFFFFF')).toBe('#D4D4D4');
    expect(brandHoverColor('#000000')).not.toBe('#000000');
  });

  it('keeps the label at or above min(4.5:1, resting contrast) on hover for every colour', () => {
    const channel = (value: number) => {
      const c = value / 255;
      return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    };
    const luminance = (hex: string) => {
      const v = hex.replace('#', '');
      const [r, g, b] = [0, 2, 4].map((o) => channel(Number.parseInt(v.slice(o, o + 2), 16)));
      return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
    };
    const contrast = (a: string, b: string) => {
      const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
      return (hi! + 0.05) / (lo! + 0.05);
    };
    const steps = [0x00, 0x33, 0x55, 0x80, 0x99, 0xaa, 0xcc, 0xff];
    for (const r of steps) {
      for (const g of steps) {
        for (const b of steps) {
          const color = `#${[r, g, b].map((n) => n.toString(16).padStart(2, '0')).join('')}`;
          const tokens = tenantBrandTokens(brand(color, null));
          const label = tokens['--primary-foreground']!;
          const hover = tokens['--primary-hover']!;
          expect(hover.toUpperCase(), color).not.toBe(color.toUpperCase());
          expect(contrast(hover, label), color).toBeGreaterThanOrEqual(
            Math.min(4.5, contrast(color, label)) - 0.001
          );
        }
      }
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
