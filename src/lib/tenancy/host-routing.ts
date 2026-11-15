export type HostKind =
  | { kind: 'platform'; host: string }
  | { kind: 'shared'; host: string }
  | { kind: 'tenant'; host: string; slug?: string }
  | { kind: 'unknown'; host: string };

/**
 * Subdomain labels that can never be an organization slug (D3).
 *
 * `admin` is the control plane. The rest are the shared application and its
 * infrastructure names: before this, `www.devfathom.com` classified as
 * `{ kind: 'tenant', slug: 'www' }`, which is exactly the misrouting the shared
 * host has to avoid. `organization.create` rejects these too, so a customer can
 * never claim a slug that would shadow one of them.
 */
export const RESERVED_HOST_LABELS = Object.freeze([
  'www',
  'admin',
  'app',
  'api',
  'staging',
  'meet',
  'meet-staging',
  'turn',
  'turn-staging',
  'wallet',
]);

export function isReservedHostLabel(value: string): boolean {
  return RESERVED_HOST_LABELS.includes(value.trim().toLowerCase());
}

/** Reserved labels that route to the shared application rather than a tenant. */
const SHARED_HOST_LABELS = new Set(RESERVED_HOST_LABELS.filter((label) => label !== 'admin'));

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);

export function normalizeHost(value: string | null | undefined): string {
  const first = value?.split(',')[0]?.trim().toLowerCase() ?? '';
  if (!first) return '';

  if (first.startsWith('[')) {
    const end = first.indexOf(']');
    return end >= 0 ? first.slice(1, end) : '';
  }

  return first.replace(/:\d+$/, '').replace(/\.$/, '');
}

function configuredBaseDomain(): string {
  return normalizeHost(process.env.PLATFORM_BASE_DOMAIN);
}

/**
 * Hosts serving the shared, slug-free application, as deployment configuration.
 * Optional: the label rule below already covers `www.<base>` and `staging.<base>`.
 * This exists so an operator can name a shared host that does not follow it
 * (a vanity domain, or a generated cloud hostname) without editing code.
 */
export function configuredSharedHosts(): Set<string> {
  const hosts = new Set<string>();
  for (const value of (process.env.SHARED_APP_HOSTS ?? '').split(',')) {
    const host = normalizeHost(value);
    if (host) hosts.add(host);
  }
  return hosts;
}

export function configuredDefaultHosts(): Set<string> {
  const hosts = new Set<string>();
  const values = [
    process.env.NEXT_PUBLIC_APP_URL,
    process.env.AUTH_URL,
    process.env.VERCEL_URL,
    process.env.PLATFORM_BASE_DOMAIN,
  ];

  for (const value of values) {
    if (!value) continue;
    try {
      const withProtocol = value.includes('://') ? value : `https://${value}`;
      const host = normalizeHost(new URL(withProtocol).host);
      if (host) hosts.add(host);
    } catch {
      const host = normalizeHost(value);
      if (host) hosts.add(host);
    }
  }

  return hosts;
}

/** The label immediately below `baseDomain`, or null when `host` is not under it. */
function labelUnder(host: string, baseDomain: string): string | null {
  if (!baseDomain || !host.endsWith(`.${baseDomain}`)) return null;
  return host.slice(0, -(baseDomain.length + 1));
}

export function classifyHost(hostValue: string | null | undefined): HostKind {
  const host = normalizeHost(hostValue);
  if (!host) return { kind: 'unknown', host: '' };

  const baseDomain = configuredBaseDomain();
  if (baseDomain && host === `admin.${baseDomain}`) return { kind: 'platform', host };
  if (host === 'admin.localhost') return { kind: 'platform', host };

  // D3: the shared classification is checked BEFORE the base-domain suffix rule.
  // Getting the order wrong is what turned www into a tenant slug, and — via
  // configuredDefaultHosts() — would have silently authenticated every shared
  // host login against DEFAULT_ORGANIZATION_ID instead of erroring.
  if (configuredSharedHosts().has(host)) return { kind: 'shared', host };

  const label = labelUnder(host, baseDomain);
  if (label && !label.includes('.') && SHARED_HOST_LABELS.has(label)) {
    return { kind: 'shared', host };
  }

  // The apex of the configured base domain belongs to the product, never to a
  // customer. `staging.devfathom.com` is the apex of its own deployment's base
  // domain, so this is what makes the staging shared host work.
  // Local development is excluded: `localhost` keeps the default-organization
  // fallback that dev depends on (D4).
  if (baseDomain && host === baseDomain && !LOCAL_HOSTS.has(host)) {
    return { kind: 'shared', host };
  }

  if (host === 'localhost' || host.endsWith('.localhost') || host === '127.0.0.1') {
    const slug = host.endsWith('.localhost') ? host.slice(0, -'.localhost'.length) : undefined;
    if (slug && SHARED_HOST_LABELS.has(slug)) return { kind: 'shared', host };
    return { kind: 'tenant', host, slug };
  }

  if (label !== null) {
    return { kind: 'tenant', host, slug: label };
  }

  if (configuredDefaultHosts().has(host)) return { kind: 'tenant', host };
  return { kind: 'tenant', host };
}

/** True when the request arrived on a shared, slug-free application host. */
export function isSharedHost(hostValue: string | null | undefined): boolean {
  return classifyHost(hostValue).kind === 'shared';
}

/**
 * The organization's own host.
 *
 * D11/D12: enterprise SSO stays on tenant and dedicated hosts, because OIDC
 * redirect URIs and SAML ACS/audience values are derived from the request host
 * and registered at the customer IdP. An SSO-enforced workspace shown on the
 * shared picker therefore links OUT to its own host to begin SSO — the shared
 * host never starts an SSO flow itself.
 *
 * Returns null when no base domain is configured, so the caller can omit the
 * link rather than render a broken one.
 */
export function tenantHostUrl(slug: string, path = '/login'): string | null {
  const baseDomain = configuredBaseDomain();
  if (!baseDomain || !slug) return null;
  const protocol =
    LOCAL_HOSTS.has(baseDomain) || baseDomain.endsWith('.localhost') ? 'http' : 'https';
  return `${protocol}://${slug}.${baseDomain}${path}`;
}

/** Recovery must leave a mistyped tenant host, never link back into its login loop. */
export function sharedSignInUrl(hostValue: string | null | undefined): string | null {
  const host = normalizeHost(hostValue);
  if (host === 'localhost' || host.endsWith('.localhost')) {
    const authority = hostValue?.split(',')[0]?.trim() ?? '';
    const port = authority.match(/:(\d+)$/)?.[1];
    return `http://app.localhost${port ? `:${port}` : ''}/login`;
  }
  // The reserved app label is always a shared host under the configured base.
  return tenantHostUrl('app');
}
