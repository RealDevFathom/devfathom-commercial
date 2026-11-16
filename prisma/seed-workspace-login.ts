import { tenantHostUrl } from '../src/lib/tenancy/host-routing.js';

/** Seed logs use the same tenant host rule as sign-in, retaining the local dev port. */
export function seedWorkspaceLoginUrl(slug: string): string {
  const url = new URL(tenantHostUrl(slug) ?? `http://${slug}.localhost/login`);
  if (url.hostname.endsWith('.localhost')) {
    const appUrl = process.env.NEXT_PUBLIC_APP_URL || process.env.AUTH_URL;
    url.port = appUrl ? new URL(appUrl).port : '3000';
  }
  return url.href;
}
