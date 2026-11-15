import { headers } from 'next/headers';
import { AuthShell } from '@/components/auth/auth-shell';
import { sharedSignInUrl } from '@/lib/tenancy/host-routing';
import { TENANT_HOST_HEADER } from '@/lib/tenancy/host';
import { GenericNotFound } from './generic-not-found';

export default async function LoginNotFound() {
  const requestHeaders = await headers();
  const host = requestHeaders.get(TENANT_HOST_HEADER) ?? requestHeaders.get('host');
  // The link points at the configured shared host only; the requested host is
  // never echoed back, so the page is identical for every unknown workspace.
  return (
    <AuthShell>
      <GenericNotFound signInUrl={sharedSignInUrl(host)} />
    </AuthShell>
  );
}
