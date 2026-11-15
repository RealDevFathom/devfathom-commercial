import { headers } from 'next/headers';
import { AuthShell } from '@/components/auth/auth-shell';
import { sharedSignInUrl } from '@/lib/tenancy/host-routing';
import { TENANT_HOST_HEADER } from '@/lib/tenancy/host';
import { WorkspaceNotFound } from './workspace-not-found';

export default async function LoginNotFound() {
  const requestHeaders = await headers();
  const host = requestHeaders.get(TENANT_HOST_HEADER) ?? requestHeaders.get('host');
  return (
    <AuthShell>
      <WorkspaceNotFound signInUrl={sharedSignInUrl(host)} />
    </AuthShell>
  );
}
