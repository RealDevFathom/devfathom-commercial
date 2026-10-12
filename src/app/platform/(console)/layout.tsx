import { redirect } from 'next/navigation';
import { requirePlatformSession } from '@/lib/platform/auth';
import { PlatformSecurityError } from '@/lib/platform/security';
import { PlatformShell } from '@/components/platform/platform-shell';

async function resolveIdentity() {
  try {
    return await requirePlatformSession();
  } catch (error) {
    if (error instanceof PlatformSecurityError && error.status === 401) {
      redirect('/platform/login');
    }
    throw error;
  }
}

export default async function PlatformConsoleLayout({ children }: { children: React.ReactNode }) {
  const identity = await resolveIdentity();
  return <PlatformShell identity={identity}>{children}</PlatformShell>;
}
