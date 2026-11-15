export type TenantBrand = {
  /**
   * The organization this brand describes. WHA-276: "workspace" means
   * organization, so the chrome must be able to prove which tenant it is
   * showing. Without this the shell renders a name and a palette it cannot
   * attribute, and a stale one is indistinguishable from a correct one.
   */
  organizationId: string;
  displayName: string;
  logoUrl: string | null;
  markUrl: string | null;
  faviconUrl: string | null;
  primaryColor: string | null;
  accentColor: string | null;
};

export function assertWorkspaceIdentity(
  sessionOrganizationId: string,
  displayedOrganizationId: string
): void {
  if (sessionOrganizationId !== displayedOrganizationId) {
    throw new Error('Workspace identity does not match the authenticated organization.');
  }
}

/**
 * WHA-276 — the workspace-identity invariant.
 *
 * The shell's brand is a server prop resolved once, when the `/(app)` layout
 * renders, from the organization in the session cookie at that instant. The
 * effective tenant is re-resolved from the *current* cookie on every later
 * request (`createTRPCContext` derives `organizationId` from the live actor).
 * App Router keeps a shared layout mounted across client navigation, so the two
 * can drift apart: on the shared host the Auth.js JWT is host-wide, and one
 * email may hold accounts in several organizations (`findLoginCandidates`).
 * Signing into organization B in a second tab rewrites the cookie for the tab
 * still displaying organization A — which then shows A's name, logo and palette
 * over B's data.
 *
 * Returns true only when the live session names a *different* organization than
 * the chrome does. An absent session organization is "not yet known", not a
 * mismatch: the layout's server-side guard has already run, and blocking on the
 * unknown case would blank the app while the session hydrates.
 */
export function isTenantIdentityMismatch(
  brand: Pick<TenantBrand, 'organizationId'>,
  sessionOrganizationId: string | null | undefined
): boolean {
  if (!sessionOrganizationId) return false;
  return brand.organizationId !== sessionOrganizationId;
}

function contrastColor(hex: string): string {
  const value = hex.replace('#', '');
  const [red, green, blue] = [0, 2, 4].map((offset) =>
    Number.parseInt(value.slice(offset, offset + 2), 16)
  );
  return (red * 299 + green * 587 + blue * 114) / 1000 > 145 ? '#111110' : '#FFFCF6';
}

function mixHex(hex: string, target: string, amount: number): string {
  const value = hex.replace('#', '');
  const toward = target.replace('#', '');
  const mixed = [0, 2, 4].map((offset) => {
    const from = Number.parseInt(value.slice(offset, offset + 2), 16);
    const to = Number.parseInt(toward.slice(offset, offset + 2), 16);
    return Math.round(from + (to - from) * amount)
      .toString(16)
      .padStart(2, '0');
  });
  return `#${mixed.join('').toUpperCase()}`;
}

function relativeLuminance(hex: string): number {
  const value = hex.replace('#', '');
  const [red, green, blue] = [0, 2, 4].map((offset) => {
    const channel = Number.parseInt(value.slice(offset, offset + 2), 16) / 255;
    return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * red! + 0.7152 * green! + 0.0722 * blue!;
}

function contrastRatio(a: string, b: string): number {
  const [high, low] = [relativeLuminance(a), relativeLuminance(b)].sort((x, y) => y - x);
  return (high! + 0.05) / (low! + 0.05);
}

function channelDistance(a: string, b: string): number {
  const x = a.replace('#', '');
  const y = b.replace('#', '');
  return [0, 2, 4].reduce(
    (sum, offset) =>
      sum +
      Math.abs(
        Number.parseInt(x.slice(offset, offset + 2), 16) -
          Number.parseInt(y.slice(offset, offset + 2), 16)
      ),
    0
  );
}

/**
 * DEV-51 — a tenant colour used to be copied into its own `*-hover` token, so
 * primary and accent buttons showed no change on hover in either theme.
 *
 * The hover shade moves the brand colour *away* from its label colour (darker
 * under a light label, lighter under a dark one), so label contrast on hover is
 * never lower than at rest. A colour already near black or white barely moves
 * that way, so it moves toward the label instead, but only while the label
 * keeps at least 4.5:1 (the Studio text-contrast floor) on the hover shade.
 */
export function brandHoverColor(hex: string): string {
  const label = contrastColor(hex);
  const away = mixHex(hex, label === '#FFFCF6' ? '#000000' : '#FFFFFF', 0.18);
  if (channelDistance(hex, away) >= 24) return away;
  const toward = mixHex(hex, label, 0.18);
  return contrastRatio(toward, label) >= 4.5 ? toward : away;
}

/**
 * In the dark theme the Studio `--primary` family is a light neutral that reads
 * on dark surfaces. A tenant colour set inline would beat it and render
 * primary-coloured text/links near-invisible (1.21:1), so the dark theme keeps
 * its own `--primary` tokens and only the sidebar chrome takes the tenant colour.
 */
export function tenantBrandTokens(
  brand: TenantBrand,
  theme: 'light' | 'dark' = 'light'
): Record<string, string> {
  return {
    ...(brand.primaryColor && theme !== 'dark'
      ? {
          '--primary': brand.primaryColor,
          '--primary-hover': brandHoverColor(brand.primaryColor),
          '--primary-foreground': contrastColor(brand.primaryColor),
        }
      : {}),
    ...(brand.primaryColor
      ? {
          '--sidebar': brand.primaryColor,
          '--sidebar-foreground': contrastColor(brand.primaryColor),
          '--sidebar-accent': brand.primaryColor,
          '--sidebar-accent-foreground': contrastColor(brand.primaryColor),
        }
      : {}),
    ...(brand.accentColor
      ? {
          '--sidebar-primary': brand.accentColor,
          '--accent-brand': brand.accentColor,
          '--accent-brand-hover': brandHoverColor(brand.accentColor),
          '--ring': brand.accentColor,
        }
      : {}),
  };
}
