type DemoOrganization = {
  isDemo?: boolean;
  vertical?: string;
  deploymentMode?: string;
};

function parsedOrigin(value: string, protocol?: string): URL | null {
  try {
    const url = new URL(protocol && !value.includes('://') ? `${protocol}//${value}` : value);
    return url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.pathname !== '/' ||
      !['http:', 'https:'].includes(url.protocol)
      ? null
      : url;
  } catch {
    return null;
  }
}

export function demoSharedDeploymentOrigin(organization: DemoOrganization): string | null {
  if (
    !organization.isDemo ||
    organization.vertical !== 'RESTAURANT' ||
    organization.deploymentMode !== 'SHARED'
  ) {
    return null;
  }

  const configured = process.env.AUTH_URL || process.env.NEXTAUTH_URL;
  if (!configured) return null;
  const origin = parsedOrigin(configured);
  if (!origin) return null;

  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname);
  if (origin.protocol !== 'https:' && !(origin.protocol === 'http:' && loopback)) return null;

  const allowed = (process.env.SHARED_APP_HOSTS ?? '')
    .split(',')
    .map((value) => parsedOrigin(value.trim(), origin.protocol)?.origin)
    .filter(Boolean);
  return allowed.includes(origin.origin) ? origin.origin : null;
}
