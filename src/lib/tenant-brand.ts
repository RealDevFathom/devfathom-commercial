export type TenantBrand = {
  displayName: string;
  logoUrl: string | null;
  markUrl: string | null;
  faviconUrl: string | null;
  primaryColor: string | null;
  accentColor: string | null;
};

function contrastColor(hex: string): string {
  const value = hex.replace('#', '');
  const [red, green, blue] = [0, 2, 4].map((offset) =>
    Number.parseInt(value.slice(offset, offset + 2), 16)
  );
  return (red * 299 + green * 587 + blue * 114) / 1000 > 145 ? '#111110' : '#FFFCF6';
}

export function tenantBrandTokens(brand: TenantBrand): Record<string, string> {
  return {
    ...(brand.primaryColor
      ? {
          '--primary': brand.primaryColor,
          '--primary-hover': brand.primaryColor,
          '--primary-foreground': contrastColor(brand.primaryColor),
          '--sidebar': brand.primaryColor,
          '--sidebar-foreground': contrastColor(brand.primaryColor),
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
