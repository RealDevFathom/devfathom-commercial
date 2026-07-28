import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { getPlatformSession } from '@/lib/platform/auth';
import { PlatformLoginForm } from './platform-login-form';

export const metadata: Metadata = {
  title: 'Platform control sign in',
  robots: { index: false, follow: false },
};

export default async function PlatformLoginPage() {
  if (await getPlatformSession()) redirect('/platform');

  return (
    <main className="min-h-dvh bg-surface-page p-4 text-text-strong sm:p-7">
      <div className="mx-auto grid min-h-[calc(100dvh-3.5rem)] max-w-[1380px] overflow-hidden border border-border-default bg-surface-card shadow-lg lg:grid-cols-[1.2fr_0.8fr]">
        <section className="relative hidden overflow-hidden bg-abyss-900 p-12 text-paper-50 lg:flex lg:flex-col lg:justify-between">
          <div
            aria-hidden="true"
            className="absolute inset-0 opacity-30"
            style={{
              backgroundImage:
                'linear-gradient(rgba(255,255,255,.055) 1px,transparent 1px),linear-gradient(90deg,rgba(255,255,255,.055) 1px,transparent 1px)',
              backgroundSize: '48px 48px',
            }}
          />
          <div className="relative flex items-center gap-3">
            <span className="grid h-9 w-9 place-items-center border border-white/20 font-mono text-xs text-brass-300">
              DF
            </span>
            <div>
              <p className="font-display text-sm font-semibold">DevFathom Control</p>
              <p className="font-mono text-[9px] uppercase tracking-[0.2em] text-abyss-300">
                Internal operations
              </p>
            </div>
          </div>

          <div className="relative max-w-2xl">
            <p className="mb-5 font-mono text-[10px] uppercase tracking-[0.24em] text-brass-300">
              Control ledger / restricted
            </p>
            <h1 className="max-w-xl font-display text-5xl font-semibold leading-[0.98] tracking-[-0.045em] xl:text-7xl">
              The desk behind every workspace.
            </h1>
            <p className="mt-7 max-w-lg text-base leading-7 text-abyss-200">
              Activate organizations, shape contracts, control modules, and move enterprise
              deployments without leaving the operational record.
            </p>
          </div>

          <div className="relative grid grid-cols-3 gap-px border border-white/10 bg-white/10">
            {[
              ['01', 'Manual activation'],
              ['02', 'Tenant isolation'],
              ['03', 'Every change audited'],
            ].map(([number, label]) => (
              <div key={number} className="bg-abyss-900 px-4 py-5">
                <p className="font-mono text-[10px] text-brass-300">{number}</p>
                <p className="mt-2 text-xs text-abyss-200">{label}</p>
              </div>
            ))}
          </div>
        </section>

        <section className="flex items-center justify-center px-6 py-12 sm:px-12">
          <div className="w-full max-w-sm">
            <div className="mb-10 lg:hidden">
              <p className="font-display text-lg font-semibold">DevFathom Control</p>
              <p className="font-mono text-[9px] uppercase tracking-[0.18em] text-text-muted">
                Internal operations
              </p>
            </div>
            <p className="font-mono text-[10px] uppercase tracking-[0.22em] text-accent-brand">
              Platform access
            </p>
            <h2 className="mt-3 font-display text-3xl font-semibold tracking-[-0.035em]">
              Open the control desk
            </h2>
            <p className="mt-3 text-sm leading-6 text-text-muted">
              Use your internal operator account. Access expires after eight hours.
            </p>
            <PlatformLoginForm />
          </div>
        </section>
      </div>
    </main>
  );
}
