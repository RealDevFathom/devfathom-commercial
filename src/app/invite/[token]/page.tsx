import type { Metadata } from 'next';
import { Logo } from '@/components/brand/logo';
import { Reveal } from '@/components/motion/reveal';
import { AcceptInviteForm } from './accept-invite-form';

export const metadata: Metadata = {
  title: 'Accept invitation',
};

export default async function InvitePage(props: { params: Promise<{ token: string }> }) {
  const { token } = await props.params;

  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-6 text-foreground sm:p-8">
      <Reveal delay={0.1} className="w-full max-w-[460px]">
        <div className="mb-7 flex justify-center">
          <Logo variant="brand" size="md" />
        </div>

        <div className="rounded-2xl border border-border bg-card p-8 shadow-sm">
          <AcceptInviteForm token={token} />
        </div>

        <p className="mt-6 text-center text-xs text-muted-foreground">
          Already activated your account?{' '}
          <a
            href="/login"
            className="font-medium text-foreground underline-offset-4 hover:text-accent-brand hover:underline"
          >
            Sign in
          </a>
        </p>
      </Reveal>
    </div>
  );
}
