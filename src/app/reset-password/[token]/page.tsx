import type { Metadata } from 'next';
import { Logo } from '@/components/brand/logo';
import { Reveal } from '@/components/motion/reveal';
import { ResetPasswordForm } from './reset-password-form';

export const metadata: Metadata = {
  title: 'Reset password',
};

export default async function ResetPasswordPage(props: { params: Promise<{ token: string }> }) {
  const { token } = await props.params;

  return (
    <div className="relative flex min-h-screen items-center justify-center bg-[#06090C] p-6 text-[#E6EBEE] sm:p-8">
      <div className="pointer-events-none absolute inset-0 overflow-hidden">
        <div className="absolute -top-32 right-0 h-72 w-72 rounded-full bg-primary/10 blur-[120px]" />
      </div>

      <Reveal delay={0.1} className="relative z-10 w-full max-w-[400px]">
        <div className="mb-7 flex justify-center">
          <Logo variant="white" size="md" textClassName="text-white" />
        </div>

        <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-8 shadow-2xl shadow-black/40 backdrop-blur-xl">
          <ResetPasswordForm token={token} />
        </div>
      </Reveal>
    </div>
  );
}
