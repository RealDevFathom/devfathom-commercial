import { Suspense } from 'react';
import type { Metadata } from 'next';
import { Logo } from '@/components/brand/logo';
import { LogoIcon } from '@/components/brand/logo';
import { LoginForm } from './login-form';

export const metadata: Metadata = {
  title: 'Sign In',
};

export default function LoginPage() {
  return (
    <div className="flex min-h-screen bg-[#111110]">
      {/* Left panel — branding (desktop only) */}
      <div className="hidden lg:flex lg:w-[45%] relative overflow-hidden">
        {/* Warm glow */}
        <div className="absolute inset-0">
          <div className="absolute top-1/3 -left-10 h-80 w-80 rounded-full bg-[#FF4C29]/12 blur-[100px]" />
          <div className="absolute bottom-1/4 right-10 h-60 w-60 rounded-full bg-[#FF4C29]/6 blur-[80px]" />
        </div>

        {/* Grid pattern */}
        <div
          className="absolute inset-0 opacity-40"
          style={{
            backgroundImage: `linear-gradient(rgba(255,255,255,0.03) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.03) 1px, transparent 1px)`,
            backgroundSize: '60px 60px',
          }}
        />

        {/* Giant logo watermark */}
        <div className="absolute inset-0 flex items-center justify-center">
          <LogoIcon
            className="h-[420px] w-[420px] opacity-[0.04]"
            variant="white"
          />
        </div>

        {/* Content */}
        <div className="relative z-10 flex flex-col justify-between p-12">
          <Logo variant="orange" size="lg" />

          <div className="max-w-sm">
            <h1 className="font-display text-[2.75rem] font-bold text-white leading-[1.1] tracking-tight">
              Technology That
              <br />
              Moves{' '}
              <span className="text-[#FF4C29]">With Intelligence</span>
            </h1>
            <p className="mt-6 text-base text-[#A8A49D] leading-relaxed">
              Your unified platform for project management, financial tracking,
              client relations, and team collaboration.
            </p>
          </div>

          <div className="flex items-center gap-6 text-sm text-[#78756F]">
            <div className="flex items-center gap-2">
              <div className="h-2 w-2 rounded-full bg-emerald-500" />
              <span>All systems operational</span>
            </div>
            <span>v1.0.0</span>
          </div>
        </div>
      </div>

      {/* Right panel — login form */}
      <div className="flex flex-1 items-center justify-center p-8">
        {/* Subtle gradient on right side */}
        <div className="absolute inset-0 lg:left-[45%]">
          <div className="absolute top-0 right-0 h-full w-full bg-gradient-to-bl from-[#FF4C29]/[0.03] via-transparent to-transparent" />
        </div>

        <div className="relative z-10 w-full max-w-[380px]">
          {/* Form card with warm surface */}
          <div className="rounded-2xl border border-[#2E2C2A] bg-[#1A1918] p-8 shadow-2xl shadow-black/20">
            {/* Mobile logo */}
            <div className="mb-6 lg:hidden">
              <Logo variant="orange" size="md" />
            </div>

            <div className="mb-8">
              <h2 className="font-display text-xl font-semibold text-[#EEECE8] tracking-tight">
                Welcome back
              </h2>
              <p className="mt-1.5 text-sm text-[#A8A49D]">
                Sign in to your Company Hub account
              </p>
            </div>

            <Suspense
              fallback={
                <div className="animate-pulse space-y-5">
                  <div className="space-y-2">
                    <div className="h-4 w-12 rounded bg-[#252422]" />
                    <div className="h-11 rounded-xl bg-[#252422]" />
                  </div>
                  <div className="space-y-2">
                    <div className="h-4 w-16 rounded bg-[#252422]" />
                    <div className="h-11 rounded-xl bg-[#252422]" />
                  </div>
                  <div className="h-11 rounded-xl bg-[#252422]" />
                </div>
              }
            >
              <LoginForm />
            </Suspense>
          </div>

          <p className="mt-6 text-center text-xs text-[#78756F]">
            Contact an admin if you need account access
          </p>
        </div>
      </div>
    </div>
  );
}
