export type HostKind =
  | { kind: 'platform'; host: string }
  | { kind: 'tenant'; host: string; slug?: string }
  | { kind: 'unknown'; host: string };

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

export function classifyHost(hostValue: string | null | undefined): HostKind {
  const host = normalizeHost(hostValue);
  if (!host) return { kind: 'unknown', host: '' };

  const baseDomain = configuredBaseDomain();
  if (baseDomain && host === `admin.${baseDomain}`) return { kind: 'platform', host };

  if (host === 'localhost' || host.endsWith('.localhost') || host === '127.0.0.1') {
    const slug = host.endsWith('.localhost') ? host.slice(0, -'.localhost'.length) : undefined;
    if (slug === 'admin') return { kind: 'platform', host };
    return { kind: 'tenant', host, slug };
  }

  if (baseDomain && host.endsWith(`.${baseDomain}`)) {
    return { kind: 'tenant', host, slug: host.slice(0, -(baseDomain.length + 1)) };
  }

  if (configuredDefaultHosts().has(host)) return { kind: 'tenant', host };
  return { kind: 'tenant', host };
}
