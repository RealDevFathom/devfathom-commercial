import type { Metadata } from 'next';
import { AuthRecoveryShell } from '@/components/auth/auth-recovery-shell';
import { ResetPasswordForm } from './reset-password-form';

export const metadata: Metadata = {
  title: 'Reset password',
};

export default async function ResetPasswordPage(props: { params: Promise<{ token: string }> }) {
  const { token } = await props.params;

  return (
    <AuthRecoveryShell context="DevFathom / recovery">
      <ResetPasswordForm token={token} />
    </AuthRecoveryShell>
  );
}
