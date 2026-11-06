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

function channels(hex: string): number[] {
  const value = hex.replace('#', '');
  return [0, 2, 4].map((offset) => Number.parseInt(value.slice(offset, offset + 2), 16));
}

/** WCAG 2 relative luminance of a `#RRGGBB` colour. */
function luminance(hex: string): number {
  const [red, green, blue] = channels(hex).map((channel) => {
    const value = channel / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * red! + 0.7152 * green! + 0.0722 * blue!;
}

/** WCAG 2 contrast ratio between two `#RRGGBB` colours. */
function contrastRatio(a: string, b: string): number {
  const [high, low] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (high! + 0.05) / (low! + 0.05);
}

/** `hex` moved 16% of the way toward `toward`. */
function mixToward(hex: string, toward: string): string {
  const target = channels(toward);
  return `#${channels(hex)
    .map((value, index) =>
      Math.round(value * 0.84 + target[index]! * 0.16)
        .toString(16)
        .padStart(2, '0')
    )
    .join('')}`;
}

/**
 * The hover fill for a tenant primary: the brand moved 16% toward its own
 * foreground, so a hovered primary button visibly changes in both themes. Using
 * the brand itself as the hover colour left the button inert on hover. When
 * moving toward the label would drop it below 4.5:1 (mid-tone brands such as
 * coral #bd3f2a), the fill moves 16% away from the label instead, which can
 * only raise the label contrast.
 */
function hoverColor(hex: string): string {
  const foreground = contrastColor(hex);
  const toward = mixToward(hex, foreground);
  if (contrastRatio(toward, foreground) >= 4.5) return toward;
  return mixToward(hex, foreground === '#FFFCF6' ? '#000000' : '#ffffff');
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
