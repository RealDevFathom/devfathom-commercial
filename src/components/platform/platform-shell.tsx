'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import {
  Activity,
  Boxes,
  Building2,
  ChevronRight,
  CircleDollarSign,
  ContactRound,
  FileClock,
  LogOut,
  Network,
  ScrollText,
  Settings2,
  ShieldCheck,
  UsersRound,
} from 'lucide-react';
import type { PlatformIdentity } from '@/lib/platform/auth';
import { cn } from '@/lib/utils';

const nav = [
  { label: 'Control room', href: '/platform', icon: Activity },
  { label: 'Organizations', href: '/platform/organizations', icon: Building2 },
  { label: 'Sales CRM', href: '/platform/crm', icon: ContactRound },
  { label: 'Commercial', href: '/platform/commercial', icon: CircleDollarSign },
  { label: 'Modules & plans', href: '/platform/catalog', icon: Boxes },
  { label: 'Deployments', href: '/platform/deployments', icon: Network },
  { label: 'Jobs', href: '/platform/jobs', icon: FileClock },
  { label: 'Operators', href: '/platform/operators', icon: UsersRound },
  { label: 'Audit ledger', href: '/platform/audit', icon: ScrollText },
  { label: 'Platform settings', href: '/platform/settings', icon: Settings2 },
];

export function PlatformShell({
  identity,
  children,
}: {
  identity: PlatformIdentity;
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const router = useRouter();

  async function signOut() {
    await fetch('/api/platform/session', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
    });
    router.replace('/platform/login');
    router.refresh();
  }

  return (
    <div className="min-h-dvh bg-surface-page text-text-strong lg:grid lg:grid-cols-[252px_1fr]">
      <aside className="border-b border-sidebar-border bg-abyss-900 text-paper-50 lg:sticky lg:top-0 lg:h-dvh lg:border-b-0 lg:border-r">
        <div className="flex h-18 items-center justify-between border-b border-white/10 px-5 lg:h-20">
          <Link href="/platform" className="flex items-center gap-3">
            <span className="grid h-8 w-8 place-items-center border border-white/20 font-mono text-[10px] text-brass-300">
              DF
            </span>
            <span>
              <span className="block font-display text-sm font-semibold">Control desk</span>
              <span className="block font-mono text-[8px] uppercase tracking-[0.2em] text-abyss-300">
                Platform operations
              </span>
            </span>
          </Link>
          <ShieldCheck className="h-4 w-4 text-brass-300 lg:hidden" aria-hidden="true" />
        </div>

        <nav
          aria-label="Platform navigation"
          className="flex gap-1 overflow-x-auto px-3 py-3 lg:block lg:space-y-0.5 lg:overflow-visible lg:py-5"
        >
          {nav.map((item, index) => {
            const active =
              item.href === '/platform'
                ? pathname === item.href
                : pathname === item.href || pathname.startsWith(`${item.href}/`);
            const Icon = item.icon;
            return (
              <Link
                key={item.href}
                href={item.href}
                aria-current={active ? 'page' : undefined}
                className={cn(
                  'group flex min-w-max items-center gap-3 px-3 py-2.5 text-xs transition lg:min-w-0',
                  active
                    ? 'bg-abyss-800 text-paper-white shadow-[inset_3px_0_0_var(--brass-500)]'
                    : 'text-abyss-200 hover:bg-white/5 hover:text-paper-white'
                )}
              >
                <span className="hidden w-5 font-mono text-[9px] text-abyss-400 lg:block">
                  {String(index + 1).padStart(2, '0')}
                </span>
                <Icon className={cn('h-4 w-4', active && 'text-brass-300')} aria-hidden="true" />
                <span>{item.label}</span>
                {active ? (
                  <ChevronRight
                    className="ml-auto hidden h-3.5 w-3.5 text-brass-300 lg:block"
                    aria-hidden="true"
                  />
                ) : null}
              </Link>
            );
          })}
        </nav>

        <div className="hidden border-t border-white/10 p-4 lg:absolute lg:inset-x-0 lg:bottom-0 lg:block">
          <p className="truncate text-xs font-medium text-paper-50">{identity.name}</p>
          <p className="mt-1 font-mono text-[9px] uppercase tracking-[0.14em] text-abyss-300">
            {identity.role.replaceAll('_', ' ')}
          </p>
          <button
            type="button"
            onClick={signOut}
            className="mt-4 flex w-full items-center gap-2 border border-white/10 px-3 py-2 text-xs text-abyss-200 transition hover:border-white/20 hover:text-paper-50"
          >
            <LogOut className="h-3.5 w-3.5" aria-hidden="true" />
            Sign out
          </button>
        </div>
      </aside>

      <div className="min-w-0 overflow-x-clip">
        <header className="sticky top-0 z-30 flex h-14 items-center justify-between border-b border-border-subtle bg-surface-card/95 px-4 backdrop-blur-sm sm:px-7 lg:h-16 lg:px-10">
          <div className="flex items-center gap-2 font-mono text-[9px] uppercase tracking-[0.18em] text-text-muted">
            <span className="h-1.5 w-1.5 bg-success" aria-hidden="true" />
            Platform nominal
          </div>
          <div className="flex items-center gap-3">
            <span className="hidden text-xs text-text-muted sm:block">{identity.email}</span>
            <span className="border border-border-default bg-surface-sunken px-2.5 py-1 font-mono text-[9px] uppercase tracking-[0.12em]">
              {identity.role.replaceAll('_', ' ')}
            </span>
            <button
              type="button"
              onClick={signOut}
              className="grid h-8 w-8 place-items-center border border-border-default text-text-muted transition hover:border-border-strong hover:text-text-strong lg:hidden"
              aria-label="Sign out"
            >
              <LogOut className="h-3.5 w-3.5" />
            </button>
          </div>
        </header>
        <main className="px-4 py-6 sm:px-7 lg:px-10 lg:py-9">{children}</main>
      </div>
    </div>
  );
}
