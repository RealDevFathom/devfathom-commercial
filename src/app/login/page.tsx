import type { Metadata } from 'next';
import { Logo } from '@/components/brand/logo';
import { LoginForm } from './login-form';
import { LoginHero } from './login-hero';

export const metadata: Metadata = {
  title: 'Sign in',
};

export default function LoginPage() {
  return (
    <div className="relative flex min-h-screen bg-[#06090C] text-[#E6EBEE]">
      {/* Left panel — animated brand hero (desktop only) */}
      <LoginHero />

      {/* Right panel — login form */}
      <div className="relative flex flex-1 items-center justify-center p-6 sm:p-8">
        <div className="pointer-events-none absolute inset-0 overflow-hidden">
          <div className="absolute -top-32 right-0 h-72 w-72 rounded-full bg-primary/10 blur-[120px]" />
        </div>

        <div className="animate-slide-up relative z-10 w-full max-w-[400px]">
          <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-8 shadow-2xl shadow-black/40 backdrop-blur-xl">
            {/* Mobile logo */}
            <div className="mb-7 lg:hidden">
              <Logo variant="white" size="md" textClassName="text-white" />
            </div>

            <div className="mb-7">
              <h2 className="font-display text-xl font-semibold tracking-tight text-white">
                Welcome back
              </h2>
              <p className="mt-1.5 text-sm text-[#8A97A1]">Sign in to your DevFathom workspace</p>
            </div>

            <LoginForm />
          </div>

          <p className="mt-6 text-center text-xs text-[#5A6670]">
            Need access? Contact your workspace admin.
          </p>
        </div>
      </div>
    </div>
  );
}
