'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { m } from 'motion/react';
import { LogOut, Menu, Moon, Sun, X } from 'lucide-react';
import type { PlatformIdentity } from '@/lib/platform/auth';
import { platformNavigationFor, type PlatformNavGroup } from '@/lib/platform/read-policy';
import { cn } from '@/lib/utils';
import { FathomMark } from '@/components/brand/logo';
import { PageTransition } from '@/components/motion/page-transition';
import { useTheme } from '@/components/theme-provider';

const groupOrder: PlatformNavGroup[] = ['Operations', 'Revenue', 'Governance'];

function isActivePath(pathname: string, href: string) {
  return href === '/platform'
    ? pathname === href
    : pathname === href || pathname.startsWith(`${href}/`);
}

function initials(name: string) {
  return name
    .split(' ')
    .map((part) => part[0])
    .join('')
    .toUpperCase()
    .slice(0, 2);
}

function PlatformDrawer({
  identity,
  nav,
  pathname,
  onClose,
  onNavigate,
  onSignOut,
}: {
  identity: PlatformIdentity;
  nav: ReturnType<typeof platformNavigationFor>;
  pathname: string;
  onClose: (event: React.MouseEvent<HTMLElement>) => void;
  onNavigate: () => void;
  onSignOut: () => void;
}) {
  return (
    <aside
      aria-label="Platform navigation"
      className="flex h-dvh w-[min(20rem,88vw)] flex-col border-r border-sidebar-border bg-sidebar text-sidebar-foreground"
    >
      <div className="flex h-20 items-center gap-3 border-b border-sidebar-border px-5">
        <FathomMark className="h-9 w-9" variant="brand" />
        <div className="min-w-0">
          <p className="truncate text-[15px] font-semibold tracking-[-0.025em] text-sidebar-accent-foreground">
            DevFathom
          </p>
          <p className="font-mono text-[9px] uppercase tracking-[0.2em] text-sidebar-foreground/55">
            Platform control
          </p>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="ml-auto grid size-11 place-items-center rounded-full border border-sidebar-border transition hover:bg-sidebar-accent"
          aria-label="Close menu"
        >
          <X className="size-4" />
        </button>
      </div>

      <nav aria-label="Platform navigation" className="flex-1 space-y-6 overflow-y-auto px-3 py-5">
        {groupOrder.map((group) => (
          <div key={group} className="space-y-1">
            <p className="px-2 pb-2 font-mono text-[9px] font-semibold uppercase tracking-[0.2em] text-sidebar-foreground/45">
              Runbook / {group}
            </p>
            {nav
              .filter((item) => item.group === group)
              .map((item) => {
                const active = isActivePath(pathname, item.href);
                const index = nav.findIndex((entry) => entry.href === item.href) + 1;
                return (
                  <Link
                    key={item.href}
                    href={item.href}
                    onClick={onNavigate}
                    aria-current={active ? 'page' : undefined}
                    className={cn(
                      'group relative flex min-h-11 items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium transition-colors',
                      active
                        ? 'bg-sidebar-accent text-sidebar-accent-foreground shadow-[inset_3px_0_0_var(--sidebar-primary)]'
                        : 'text-sidebar-foreground/85 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground'
                    )}
                  >
                    <span
                      aria-hidden="true"
                      className={cn(
                        'w-5 shrink-0 text-center font-mono text-[10px] tabular-nums',
                        active
                          ? 'text-sidebar-primary'
                          : 'text-sidebar-foreground/45 group-hover:text-sidebar-foreground/70'
                      )}
                    >
                      {String(index).padStart(2, '0')}
                    </span>
                    <span className="truncate">{item.label}</span>
                  </Link>
                );
              })}
          </div>
        ))}
      </nav>

      <div className="border-t border-sidebar-border p-4">
        <div className="flex items-center gap-3">
          <span className="grid size-9 shrink-0 place-items-center rounded-full bg-sidebar-primary/12 text-xs font-semibold text-sidebar-primary">
            {initials(identity.name)}
          </span>
          <div className="min-w-0">
            <p className="truncate text-sm font-medium text-sidebar-accent-foreground">
              {identity.name}
            </p>
            <p className="truncate font-mono text-[10px] uppercase tracking-[0.08em] text-sidebar-foreground/50">
              {identity.role.replaceAll('_', ' ')}
            </p>
          </div>
        </div>
        <button
          type="button"
          onClick={onSignOut}
          className="mt-4 flex min-h-11 w-full items-center gap-2 rounded-xl px-3 text-xs text-sidebar-foreground/70 transition hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
        >
          <LogOut className="size-4" aria-hidden="true" />
          Sign out
        </button>
      </div>
    </aside>
  );
}

export function PlatformShell({
  identity,
  children,
}: {
  identity: PlatformIdentity;
  children: React.ReactNode;
}) {
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const menuTriggerRef = useRef<HTMLButtonElement>(null);
  const restoreMenuFocus = useRef(false);
  const pathname = usePathname();
  const router = useRouter();
  const { theme, setTheme } = useTheme();
  const nav = platformNavigationFor(identity.role);
  const currentPage = nav.find((item) => isActivePath(pathname, item.href)) ?? nav[0];

  const closeMobileMenu = useCallback((options: { restoreFocus: boolean }) => {
    restoreMenuFocus.current = options.restoreFocus;
    setMobileMenuOpen(false);
  }, []);

  // Closing the drawer unmounts whatever the keyboard was on, which drops focus
  // to the body and strands a keyboard user at the top of the document. Hand it
  // back to the trigger that opened the drawer once the close has committed.
  useEffect(() => {
    if (mobileMenuOpen || !restoreMenuFocus.current) return;
    restoreMenuFocus.current = false;
    menuTriggerRef.current?.focus();
  }, [mobileMenuOpen]);

  useEffect(() => {
    if (!mobileMenuOpen) return;
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      closeMobileMenu({ restoreFocus: true });
    }
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [mobileMenuOpen, closeMobileMenu]);

  // Enter/Space on a button dispatches a click with `detail === 0`; a pointer
  // click reports 1 or more. Only the keyboard path pulls focus back, so a tap
  // still leaves focus where the pointer put it.
  function handleCloseClick(event: React.MouseEvent<HTMLElement>) {
    closeMobileMenu({ restoreFocus: event.detail === 0 });
  }

  async function signOut() {
    await fetch('/api/platform/session', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
    });
    router.replace('/platform/login');
    router.refresh();
  }

  return (
    <div className="platform-workspace studio-viewport h-dvh overflow-hidden text-text-strong">
      <a
        href="#platform-main"
        className="sr-only fixed top-3 left-3 z-50 rounded-[3px] bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground focus:not-sr-only"
      >
        Skip to platform content
      </a>

      {mobileMenuOpen ? (
        <>
          <button
            type="button"
            className="fixed inset-0 z-40 bg-black/45 backdrop-blur-sm lg:hidden"
            onClick={handleCloseClick}
            aria-label="Close platform navigation"
          />
          <div className="fixed inset-y-0 left-0 z-50 lg:hidden">
            <PlatformDrawer
              identity={identity}
              nav={nav}
              pathname={pathname}
              onClose={handleCloseClick}
              // A navigation link is leaving this view, so the trigger it would
              // restore to is about to be re-rendered for the next route.
              onNavigate={() => closeMobileMenu({ restoreFocus: false })}
              onSignOut={() => void signOut()}
            />
          </div>
        </>
      ) : null}

      <div className="studio-shell flex h-full min-w-0 flex-col overflow-hidden">
        <header className="studio-topbar sticky top-0 z-30 flex min-h-[76px] items-center gap-3 border-b border-border-subtle bg-card/94 px-4 backdrop-blur-xl sm:px-6 xl:px-8">
          <button
            type="button"
            ref={menuTriggerRef}
            onClick={() => setMobileMenuOpen(true)}
            className="studio-icon-button lg:hidden"
            aria-label="Open platform navigation"
          >
            <Menu className="size-5" />
          </button>

          <Link
            href="/platform"
            aria-label="DevFathom platform home"
            className="flex shrink-0 items-center gap-3 rounded-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <FathomMark className="size-10" variant="brand" />
            <div className="hidden leading-tight sm:block">
              <span className="block text-sm font-semibold tracking-[-0.03em] text-foreground">
                DevFathom
              </span>
              <span className="block text-xs text-muted-foreground">Platform control</span>
            </div>
          </Link>

          <div className="hidden h-8 w-px bg-border-subtle md:block" />

          <div className="hidden min-w-0 md:block">
            <span className="flex items-center gap-2 text-xs font-medium text-foreground">
              <span className="size-1.5 rounded-full bg-success" aria-hidden="true" />
              Platform nominal
            </span>
            <span className="mt-0.5 block max-w-44 truncate text-[11px] text-muted-foreground">
              {currentPage?.label ?? 'Access restricted'}
            </span>
          </div>

          <div className="ml-auto flex shrink-0 items-center gap-1.5">
            <button
              type="button"
              className="studio-icon-button"
              onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
              aria-label={theme === 'dark' ? 'Use light theme' : 'Use dark theme'}
            >
              {theme === 'dark' ? <Sun className="size-4" /> : <Moon className="size-4" />}
            </button>

            <div className="hidden min-w-0 text-right lg:block">
              <p className="max-w-52 truncate text-xs font-medium text-foreground">
                {identity.name}
              </p>
              <p className="mt-0.5 max-w-52 truncate text-[11px] text-muted-foreground">
                {identity.email}
              </p>
            </div>

            <span
              className="grid size-10 place-items-center rounded-full bg-primary text-xs font-semibold text-primary-foreground"
              title={identity.role.replaceAll('_', ' ')}
            >
              {initials(identity.name)}
            </span>

            <button
              type="button"
              onClick={() => void signOut()}
              className="studio-icon-button hidden sm:flex"
              aria-label="Sign out"
            >
              <LogOut className="size-4" />
            </button>
          </div>
        </header>

        <div className="studio-navigation hidden border-b border-border-subtle bg-card lg:block">
          <nav
            aria-label="Platform navigation"
            className="mx-auto flex h-14 w-full max-w-[1680px] items-center gap-1 overflow-x-auto px-8"
          >
            {nav.map((item, index) => {
              const active = isActivePath(pathname, item.href);
              const beginsGroup = index > 0 && item.group !== nav[index - 1].group;
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  aria-current={active ? 'page' : undefined}
                  className={cn(
                    'group relative isolate flex h-9 shrink-0 items-center gap-2 rounded-full px-3.5 text-xs font-medium text-text-body transition-colors hover:bg-muted hover:text-text-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                    active && 'text-primary-foreground hover:text-primary-foreground',
                    beginsGroup && 'ml-3'
                  )}
                >
                  <span
                    aria-hidden="true"
                    className={cn(
                      'font-mono text-[10px] tabular-nums text-text-body',
                      active && 'text-accent-brand'
                    )}
                  >
                    {String(index + 1).padStart(2, '0')}
                  </span>
                  <span>{item.label}</span>
                  {active ? (
                    <m.span
                      layoutId="platform-topnav-active"
                      className="absolute inset-0 -z-10 rounded-full bg-foreground"
                      transition={{ type: 'spring', stiffness: 420, damping: 34 }}
                    />
                  ) : null}
                </Link>
              );
            })}
          </nav>
        </div>

        <main
          id="platform-main"
          data-slot="app-canvas"
          className="studio-canvas relative min-h-0 flex-1 overflow-y-auto scroll-pt-24"
        >
          <PageTransition className="studio-stage mx-auto min-h-full w-full max-w-[1680px] px-4 py-5 sm:px-6 sm:py-7 xl:px-8 xl:pb-8">
            {children}
          </PageTransition>
        </main>
      </div>
    </div>
  );
}
