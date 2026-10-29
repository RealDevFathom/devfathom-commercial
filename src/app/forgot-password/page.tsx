import type { Metadata } from 'next';
import { AuthRecoveryShell } from '@/components/auth/auth-recovery-shell';
import { ForgotPasswordForm } from './forgot-password-form';

export const metadata: Metadata = {
  title: 'Forgot password',
};

export default function ForgotPasswordPage() {
  return (
    <AuthRecoveryShell context="Fieldbook / recovery">
      <ForgotPasswordForm />
    </AuthRecoveryShell>
  );
}
