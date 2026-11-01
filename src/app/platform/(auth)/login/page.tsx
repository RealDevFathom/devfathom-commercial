import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { getPlatformSession } from '@/lib/platform/auth';
import { PlatformLoginForm } from './platform-login-form';
import { Logo, FathomMark } from '@/components/brand/logo';

export const metadata: Metadata = {
  title: 'Platform control sign in',
  robots: { index: false, follow: false },
};

export default async function PlatformLoginPage() {
  if (await getPlatformSession()) redirect('/platform');

  return (
    <main className="min-h-dvh bg-background text-foreground lg:grid lg:grid-cols-[minmax(0,1.08fr)_minmax(26rem,0.92fr)]">
      <section className="fieldbook-login-hero animate-fade-in relative hidden min-h-dvh overflow-hidden text-sidebar-accent-foreground lg:flex">
        <div className="fieldbook-login-grid pointer-events-none absolute inset-0" />
        <div className="pointer-events-none absolute right-[-6rem] bottom-[-5rem] size-[30rem] border border-white/15" />
        <div className="pointer-events-none absolute right-[-2rem] bottom-[-1rem] size-[18rem] border border-white/10" />

        <div className="relative z-10 flex w-full flex-col justify-between p-12 xl:p-16">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <FathomMark className="size-11" variant="white" />
              <span className="text-xl font-semibold tracking-[-0.03em] text-white">DevFathom</span>
            </div>
            <span className="border border-white/20 px-3 py-1 font-mono text-[10px] font-semibold uppercase tracking-[0.16em] text-white/70">
              Control / restricted
            </span>
          </div>

          <div className="max-w-xl">
            <p className="mb-6 font-mono text-[10px] font-semibold uppercase tracking-[0.2em] text-text-on-accent">
              The platform desk
            </p>
            <h1 className="font-display text-[clamp(3rem,5vw,5.5rem)] leading-[0.91] font-semibold tracking-[-0.065em] text-white">
              <span className="block">Run every</span>
              <span className="block">workspace.</span>
              <span className="block text-sidebar-primary">See every move.</span>
            </h1>
            <p className="mt-7 max-w-md text-base leading-relaxed text-white/65">
              Organizations, contracts, modules, and deployments—controlled from one audited
              operating record.
            </p>
          </div>

          <div className="flex items-center gap-6 text-sm text-white/55">
            <div className="flex items-center gap-2">
              <span className="relative flex size-2">
                <span className="absolute inline-flex size-full animate-ping rounded-full bg-emerald-400 opacity-60" />
                <span className="relative inline-flex size-2 rounded-full bg-emerald-400" />
              </span>
              <span>Platform nominal</span>
            </div>
            <span>Audited operator access</span>
          </div>
        </div>
      </section>

      <section className="relative flex min-h-dvh items-center justify-center px-5 py-10 sm:px-10">
        <div className="animate-slide-up w-full max-w-[25rem]">
          <div className="mb-8 flex items-center gap-3 lg:hidden">
            <Logo variant="auto" size="md" textClassName="text-foreground" />
            <span className="font-mono text-[10px] font-semibold uppercase tracking-[0.18em] text-text-muted">
              Control / access
            </span>
          </div>

          <div className="border-l-2 border-primary pl-5 sm:pl-6">
            <div className="mb-8">
              <p className="font-mono text-[10px] font-semibold uppercase tracking-[0.18em] text-accent-brand">
                Secure platform access
              </p>
              <h2 className="mt-3 font-display text-[clamp(2rem,4vw,2.7rem)] font-semibold tracking-[-0.05em] text-foreground">
                Open the control desk
              </h2>
              <p className="mt-2 max-w-sm text-sm leading-relaxed text-muted-foreground">
                Use your internal operator account. Sessions close after eight hours.
              </p>
            </div>

            <PlatformLoginForm />
          </div>

          <p className="mt-8 text-xs text-muted-foreground">
            Restricted to authorized DevFathom platform operators.
          </p>
        </div>
      </section>
    </main>
  );
}
