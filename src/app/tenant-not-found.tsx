import type { UnknownTenantVertical } from '@/lib/tenancy/unknown-tenant-host';

const NOUN: Record<UnknownTenantVertical, string> = {
  pharmacy: 'pharmacy',
  restaurant: 'restaurant',
  hotel: 'property',
  default: 'workspace',
};

/**
 * Body of the 404 for a workspace address that resolves to no organization.
 * It never echoes the address or suggests other workspaces.
 */
export function TenantNotFound({ vertical }: { vertical: UnknownTenantVertical }) {
  const noun = NOUN[vertical];
  return (
    <div>
      <p className="font-mono text-[10px] font-semibold uppercase tracking-[0.18em] text-accent-brand">
        Error 404
      </p>
      <h1 className="mt-3 font-display text-[clamp(2rem,4vw,2.7rem)] font-semibold tracking-[-0.05em] text-foreground">
        {noun.charAt(0).toUpperCase() + noun.slice(1)} not found
      </h1>
      <p className="mt-2 max-w-sm text-sm leading-relaxed text-muted-foreground">
        We couldn&apos;t find a {noun} at this address. Check the spelling of the link, or use the
        sign-in address your {noun} administrator sent you.
      </p>
    </div>
  );
}
