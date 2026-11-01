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

/**
 * The hover fill for a tenant primary: the brand moved 16% toward its own
 * foreground, so a hovered primary button visibly changes in both themes. Using
 * the brand itself as the hover colour left the button inert on hover.
 */
function hoverColor(hex: string): string {
  const base = hex.replace('#', '');
  const toward = contrastColor(hex).replace('#', '');
  const channel = (value: string, offset: number) =>
    Number.parseInt(value.slice(offset, offset + 2), 16);
  return `#${[0, 2, 4]
    .map((offset) =>
      Math.round(channel(base, offset) * 0.84 + channel(toward, offset) * 0.16)
        .toString(16)
        .padStart(2, '0')
    )
    .join('')}`;
}

export function tenantBrandTokens(brand: TenantBrand): Record<string, string> {
  return {
    ...(brand.primaryColor
      ? {
          '--primary': brand.primaryColor,
          '--primary-hover': hoverColor(brand.primaryColor),
          '--primary-foreground': contrastColor(brand.primaryColor),
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
          '--accent-brand-hover': brand.accentColor,
          '--ring': brand.accentColor,
        }
      : {}),
  };
}
