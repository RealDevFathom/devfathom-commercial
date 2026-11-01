import type { Metadata } from 'next';
import { AuthRecoveryShell } from '@/components/auth/auth-recovery-shell';
import { AcceptInviteForm } from './accept-invite-form';

export const metadata: Metadata = {
  title: 'Accept invitation',
};

export default async function InvitePage(props: { params: Promise<{ token: string }> }) {
  const { token } = await props.params;

  return (
    <AuthRecoveryShell context="DevFathom / invitation">
      <AcceptInviteForm token={token} />
      <p className="mt-6 text-center text-xs text-muted-foreground">
        Already activated your account?{' '}
        <a
          href="/login"
          className="font-medium text-foreground underline-offset-4 hover:text-accent-brand hover:underline"
        >
          Sign in
        </a>
      </p>
    </AuthRecoveryShell>
  );
}
