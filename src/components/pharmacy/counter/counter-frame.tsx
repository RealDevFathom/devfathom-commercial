'use client';

import type { ReactNode } from 'react';
import { Menu } from 'lucide-react';
import { useSession } from 'next-auth/react';

import {
  AccountMenu,
  AskFathomButton,
  NotificationBell,
  ThemeToggleButton,
  WorkspaceBrandLink,
  WorkspaceSearch,
  useWorkspaceRoleLabel,
} from '@/components/layout/topbar';
import { TopbarBreadcrumbs } from '@/components/layout/topbar-breadcrumbs';
import { useShellChrome } from '@/components/layout/shell-chrome';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';

/**
 * DEV-977 — the counter's own top bar (Counter v2).
 *
 * The shell leaves out the workspace bar and module row on this route, so this bar
 * carries the workspace identity, search, Ask Fathom, theme, notifications and the
 * account menu that bar offered, and opens the shell's navigation drawer for every
 * destination its module row offered. Below 768px the counter's name and its
 * connection and branch take the place of the workspace name.
 */
export function CounterTopBar({ statusLine }: { statusLine?: ReactNode }) {
  const chrome = useShellChrome();
  return (
    <div
      data-counter-top-bar=""
      className="flex min-h-16 items-center gap-1.5 border-b border-border-subtle bg-surface-card px-4 py-2.5 sm:gap-2.5 lg:min-h-[76px] lg:gap-4 lg:px-6 lg:py-0"
    >
      {chrome ? (
        <>
          <button
            type="button"
            onClick={chrome.openNavigation}
            className="studio-icon-button border-transparent md:hidden"
            aria-label="Open menu"
          >
            <Menu aria-hidden="true" className="size-5" />
          </button>
          <div className="hidden sm:block">
            <WorkspaceBrandLink
              brand={chrome.brand}
              subtitle="Pharmacy workspace"
              textClassName="hidden leading-tight md:block"
            />
          </div>
        </>
      ) : null}
      {/* The page heading lives in the action row; this is its phone-width echo. */}
      <div aria-hidden="true" className="min-w-0 flex-1 leading-tight md:hidden">
        <p className="text-[17px] font-semibold text-text-strong">Counter</p>
        {statusLine ? (
          <p className="truncate text-xs text-text-muted" data-counter-status-line="">
            {statusLine}
          </p>
        ) : null}
      </div>
      {chrome ? <CounterWorkspaceTools /> : null}
    </div>
  );
}

/** The workspace bar's member, breadcrumb and tools, for the counter's own bar. */
function CounterWorkspaceTools() {
  const { data: session } = useSession();
  const roleLabel = useWorkspaceRoleLabel();
  return (
    <>
      <div className="hidden min-w-0 border-s border-border-subtle ps-4 leading-snug lg:block">
        <span className="block text-[13px] font-semibold text-text-strong">
          {session?.user?.name ?? 'Workspace'}
        </span>
        <span className="block max-w-44 truncate text-xs text-text-muted">{roleLabel}</span>
      </div>
      <nav
        aria-label="Breadcrumb"
        className="hidden min-w-0 items-center gap-1 overflow-hidden border-s border-border-subtle ps-4 text-xs xl:flex"
      >
        <TopbarBreadcrumbs />
      </nav>
      <div className="ms-auto flex shrink-0 items-center gap-1.5">
        <WorkspaceSearch compact />
        <AskFathomButton />
        <ThemeToggleButton />
        <NotificationBell />
        <AccountMenu />
      </div>
    </>
  );
}

/**
 * The counter's action row: the shell menu, the page heading and the counter's own
 * state and actions. Below 768px the heading is announced but not drawn; the top bar
 * shows it instead.
 */
export function CounterActionBar({
  heading = true,
  children,
}: {
  /** False when the content below brings its own page heading. */
  heading?: boolean;
  children?: ReactNode;
}) {
  const chrome = useShellChrome();
  return (
    <div
      data-counter-action-bar=""
      className="relative flex min-h-14 items-center gap-2 border-b border-border-subtle bg-surface-card px-4 py-1.5 lg:px-6"
    >
      {chrome ? (
        <Button
          type="button"
          variant="ghost"
          className="hidden h-11 gap-2 px-3 md:inline-flex"
          onClick={chrome.openNavigation}
        >
          <Menu aria-hidden="true" />
          Menu
        </Button>
      ) : null}
      {heading ? (
        <h1 className="sr-only mx-1.5 text-xl font-semibold tracking-[-0.01em] whitespace-nowrap text-text-strong md:not-sr-only">
          Counter
        </h1>
      ) : null}
      {children}
    </div>
  );
}

/**
 * The counter screen: its own bars on top, then the counter body filling the rest of
 * the shell canvas. `actionBar` replaces the plain row (menu and heading only).
 */
export function CounterFrame({
  statusLine,
  actionBar,
  heading = true,
  children,
}: {
  statusLine?: ReactNode;
  actionBar?: ReactNode;
  heading?: boolean;
  children: ReactNode;
}) {
  return (
    <div
      data-counter-frame=""
      className="pharmacy-workspace pos-calm flex h-full min-h-0 flex-col overflow-hidden bg-surface-page"
    >
      <header className="shrink-0">
        <CounterTopBar statusLine={statusLine} />
        {actionBar ?? <CounterActionBar heading={heading} />}
      </header>
      {children}
    </div>
  );
}

/** Content for a counter state that is not the sale screen (setup, errors, sign-in). */
export function CounterFrameContent({ children }: { children: ReactNode }) {
  return <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4 sm:px-6 sm:py-6">{children}</div>;
}

/** Skeleton action row while the counter loads (Counter v2, state B6). */
export function CounterActionBarSkeleton() {
  return (
    <CounterActionBar>
      <Skeleton aria-hidden="true" className="hidden h-11 w-40 rounded-full lg:block" />
      <Skeleton aria-hidden="true" className="h-8 w-28 rounded-full" />
      <Skeleton aria-hidden="true" className="h-8 w-24 rounded-full" />
    </CounterActionBar>
  );
}
