'use client';

import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import dynamic from 'next/dynamic';
import { usePathname } from 'next/navigation';
import { Sidebar, TopNavigation } from './sidebar';
import { Topbar } from './topbar';
import { PageTransition } from '@/components/motion/page-transition';
import { isAssistantAvailable, useAssistant } from '@/lib/assistant-store';
import { trpc } from '@/lib/trpc';
import { cn } from '@/lib/utils';
import { useEntitlements } from '@/components/entitlements-provider';
import { isModuleGranted, moduleDefinitionForKey, moduleForPath } from '@/lib/module-catalog';
import type { EntitlementView } from '@/lib/module-catalog';
import { Box, Loader2, ShieldAlert, X } from 'lucide-react';
import { useSession } from 'next-auth/react';
import Link from 'next/link';
import { useTheme } from '@/components/theme-provider';
import { isTenantIdentityMismatch, tenantBrandTokens, type TenantBrand } from '@/lib/tenant-brand';
import { AdministratorStaffProfileCallout } from '@/components/restaurant/administrator-staff-profile-callout';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { PrintWindowNotice } from '@/components/ui/print-window-notice';
import { useBrowserOnline } from '@/components/pharmacy/counter/use-browser-online';
import { dismissedNoticeKey, useDismissedNotice } from './use-dismissed-notice';
import { routeOwnsChrome, ShellChromeProvider, type ShellChrome } from './shell-chrome';

// Lazy-load the assistant panel so @ai-sdk/react + ai stay out of the global
// chunk; only fetched once the user first opens the assistant.
const AssistantPanel = dynamic(
  () => import('@/components/assistant/assistant-panel').then((m) => m.AssistantPanel),
  { ssr: false }
);

function AskFathomChat({ organizationId }: { organizationId: string }) {
  const utils = trpc.useUtils();
  const settings = trpc.organizationAdmin.askFathomSettings.useQuery(undefined, {
    staleTime: 0,
    refetchOnMount: 'always',
    refetchOnWindowFocus: 'always',
    trpc: { abortOnUnmount: true },
  });
  const available = useAssistant((state) => isAssistantAvailable(state, organizationId));
  const hasOpened = useAssistant((state) => state.hasOpened);
  const panelEpoch = useAssistant((state) => state.panelEpoch);

  useEffect(() => {
    if (settings.isFetchedAfterMount) return;
    // A stalled transport must finish in a closed, actionable state too.
    const timeout = window.setTimeout(() => {
      useAssistant.getState().markUnavailable(organizationId, Date.now());
    }, 15_000);
    return () => window.clearTimeout(timeout);
  }, [organizationId, settings.isFetchedAfterMount]);

  useEffect(() => {
    useAssistant.getState().setOrganization(organizationId);
    return () => {
      useAssistant.getState().setOrganization(null);
      void utils.organizationAdmin.askFathomSettings.cancel();
    };
  }, [organizationId, utils]);

  useEffect(() => {
    // The no-input endpoint shares a cache key across sessions. Never accept a
    // previous mount's cached permissions, or another organization's response.
    if (!settings.isFetchedAfterMount) return;
    if (settings.isError || settings.data?.organizationId !== organizationId) {
      useAssistant
        .getState()
        .markUnavailable(organizationId, Math.max(settings.errorUpdatedAt, settings.dataUpdatedAt));
    } else if (settings.data) {
      useAssistant.getState().confirmSettings(settings.data, settings.dataUpdatedAt);
    }
  }, [
    organizationId,
    settings.data,
    settings.dataUpdatedAt,
    settings.errorUpdatedAt,
    settings.isError,
    settings.isFetchedAfterMount,
  ]);

  // Unmount discards local chat history. It does not abort an active stream;
  // the server gate remains authoritative for new turns and approval continuations.
  return available && hasOpened ? <AssistantPanel key={`${organizationId}:${panelEpoch}`} /> : null;
}

function EndSupportAccessButton() {
  const [pending, setPending] = useState(false);
  return (
    <button
      type="button"
      disabled={pending}
      className="inline-flex min-w-max items-center gap-2 font-semibold underline underline-offset-2 disabled:opacity-60"
      onClick={async () => {
        setPending(true);
        try {
          const response = await fetch('/api/support-session', {
            method: 'DELETE',
            headers: { 'Content-Type': 'application/json' },
            body: '{}',
          });
          const body = (await response.json()) as { error?: string; platformUrl?: string };
          if (!response.ok || !body.platformUrl) {
            toast.error(body.error ?? 'Support access could not be ended.');
            return;
          }
          window.location.assign(body.platformUrl);
        } catch {
          toast.error('Support access could not be ended.');
        } finally {
          setPending(false);
        }
      }}
    >
      {pending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
      End access
    </button>
  );
}

/**
 * WHA-276 — shown instead of the application when the signed-in organization is
 * no longer the organization this shell was rendered for.
 *
 * Deliberately renders none of the tenant chrome: no brand name, no logo, no
 * brand palette, and no `children`. Displaying organization A's identity while
 * every request underneath resolves organization B is the exact failure this
 * lane exists to make impossible, so the safe state is to show nothing tenant-
 * specific at all. Reloading re-runs the `/(app)` layout against the current
 * cookie, which resolves the correct organization and self-heals.
 */
function WorkspaceIdentityMismatch() {
  return (
    <div className="studio-viewport flex h-dvh items-center justify-center overflow-y-auto p-4">
      <section
        data-slot="workspace-identity-mismatch"
        className="mx-auto max-w-2xl border border-border-default bg-surface-card p-8"
      >
        <ShieldAlert className="h-8 w-8 text-accent-brand" />
        <p className="mt-6 font-mono text-[10px] uppercase tracking-[0.18em] text-text-muted">
          Workspace control
        </p>
        <h1 className="mt-2 font-display text-3xl font-semibold text-text-strong">
          You are signed in to a different workspace
        </h1>
        <p className="mt-3 max-w-xl text-sm leading-6 text-text-muted">
          This tab was opened for another organization, and your session has since moved. To keep
          workspace identity honest, DevFathom will not show one organization&rsquo;s name or
          branding over another organization&rsquo;s data. Reload to continue in the workspace you
          are currently signed in to.
        </p>
        <button
          type="button"
          onClick={() => window.location.reload()}
          className="mt-6 inline-flex h-10 items-center rounded-control bg-primary px-4 text-xs font-semibold text-primary-foreground"
        >
          Reload this workspace
        </button>
      </section>
    </div>
  );
}

/**
 * DEV-502: the module-disabled notice names the module as the catalog does
 * ("Pharmacy Reports"), never its internal key (`pharmacy-reports`).
 */
export function moduleDisplayName(moduleKey: string | null): string {
  return (moduleKey && moduleDefinitionForKey(moduleKey)?.name) || 'this module';
}

const MOBILE_MENU_FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function isPathModuleEnabled(
  pathname: string,
  entitlements: Pick<EntitlementView, 'enabledModules' | 'vertical'>
) {
  const moduleKey = moduleForPath(pathname, entitlements.vertical);
  return (
    !moduleKey || isModuleGranted(moduleKey, entitlements.enabledModules, entitlements.vertical)
  );
}

/**
 * DEV-44: the placeholder-licence warning is an onboarding reminder, not a page
 * error, so the member can dismiss it instead of seeing it above every page. It
 * stays on the onboarding and regulatory pages, where the licence is replaced,
 * whether or not it was dismissed.
 */
function PharmacyPlaceholderNotice({ pathname }: { pathname: string }) {
  const { data: session } = useSession();
  const [dismissed, dismiss] = useDismissedNotice(
    dismissedNoticeKey(
      'pharmacy-placeholder-licence',
      session?.user?.organizationId,
      session?.user?.id
    )
  );
  const licencePage = pathname === '/pharmacy' || /^\/pharmacy\/regulatory(\/|$)/.test(pathname);
  if (dismissed && !licencePage) return null;
  return (
    <div
      role="alert"
      className="flex min-h-10 items-center justify-center gap-2 border-b border-warning/40 bg-warning/10 px-4 py-1 text-center text-xs font-semibold text-foreground"
    >
      <span>Licence details are PLACEHOLDER – not a real licence</span>
      {licencePage || !session?.user?.id ? null : (
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label="Dismiss licence placeholder notice"
          onClick={dismiss}
          // The Studio touch target is at least 44px; the icon size alone is 32px.
          className="min-h-11 min-w-11 shrink-0"
        >
          <X aria-hidden="true" />
        </Button>
      )}
    </div>
  );
}

export function AppShell({
  children,
  brand,
  pharmacyPlaceholder = false,
  pharmacyOnboarding = false,
}: {
  children: React.ReactNode;
  brand: TenantBrand;
  pharmacyPlaceholder?: boolean;
  /** DEV-930: the organization is still onboarding (status ONBOARDING). */
  pharmacyOnboarding?: boolean;
}) {
  // The server-side invariant lives in the `/(app)` layout, which fails closed
  // before this renders. Here the live session is the moving part, so the check
  // below (after every hook) degrades to a notice rather than throwing.
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const pathname = usePathname();
  const { data: session, status: sessionStatus } = useSession();
  const entitlements = useEntitlements();
  const browserOnline = useBrowserOnline();
  const currentModule = moduleForPath(pathname, entitlements.vertical);
  const moduleEnabled =
    !currentModule ||
    isModuleGranted(currentModule, entitlements.enabledModules, entitlements.vertical);
  const counterPos = pathname === '/pharmacy/counter';
  // DEV-977: this route draws its own top bar and action row, so the shell leaves out
  // the workspace bar and module row and lends the page its navigation drawer instead.
  // A route whose module is not enabled shows the shell's notice, so it keeps the bar.
  const ownChrome = moduleEnabled && routeOwnsChrome(pathname);
  const immersive =
    counterPos || pathname === '/chat' || /^\/meetings\/[^/]+\/call$/.test(pathname);
  const { resolvedTheme } = useTheme();
  const brandStyle = tenantBrandTokens(brand, resolvedTheme) as CSSProperties;

  const mobileMenuRef = useRef<HTMLDivElement>(null);
  const mobileMenuOpenerRef = useRef<HTMLElement | null>(null);

  // The trigger comes from the click itself: a tap in Safari does not focus a
  // button, so `document.activeElement` may be the body or an unrelated field.
  const openMobileMenu = (event: React.MouseEvent<HTMLButtonElement>) => {
    mobileMenuOpenerRef.current = event.currentTarget;
    setMobileMenuOpen(true);
  };
  const chrome = useMemo<ShellChrome>(
    () => ({
      brand,
      openNavigation: (event) => {
        mobileMenuOpenerRef.current = event.currentTarget;
        setMobileMenuOpen(true);
      },
    }),
    [brand]
  );

  // DEV-507: the mobile drawer is a modal dialog. Focus moves into it on open,
  // Tab and Shift+Tab stay inside it (the rest of the shell is also `inert`),
  // and focus returns to the control that opened it once it closes.
  useEffect(() => {
    if (!mobileMenuOpen) return;
    const drawer = mobileMenuRef.current;
    const opener = mobileMenuOpenerRef.current;
    const focusable = () =>
      Array.from(drawer?.querySelectorAll<HTMLElement>(MOBILE_MENU_FOCUSABLE) ?? []).filter(
        (element) => element.tabIndex >= 0
      );

    (drawer?.querySelector<HTMLElement>('nav a[href]') ?? focusable()[0] ?? drawer)?.focus();

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setMobileMenuOpen(false);
        return;
      }
      if (event.key !== 'Tab' || !drawer) return;
      const items = focusable();
      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement;
      if (!first || !last) {
        event.preventDefault();
        drawer.focus();
      } else if (event.shiftKey && (active === first || !drawer.contains(active))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (active === last || !drawer.contains(active))) {
        event.preventDefault();
        first.focus();
      }
    };

    // The drawer only exists below `lg`; widening the viewport dismisses it so
    // focus is never trapped inside a hidden dialog. A route that draws its own bar
    // opens the drawer at every width, so it stays open there.
    const desktop = ownChrome ? undefined : window.matchMedia?.('(min-width: 1024px)');
    const closeOnDesktop = (event: MediaQueryListEvent) => {
      if (event.matches) setMobileMenuOpen(false);
    };

    document.addEventListener('keydown', onKeyDown);
    desktop?.addEventListener?.('change', closeOnDesktop);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      desktop?.removeEventListener?.('change', closeOnDesktop);
      if (opener?.isConnected) opener.focus();
    };
  }, [mobileMenuOpen, ownChrome]);

  // WHA-276: enforce the invariant that displayed workspace identity can never
  // diverge from session.user.organizationId. Every hook above has already run,
  // so this early return is safe under the Rules of Hooks.
  if (isTenantIdentityMismatch(brand, session?.user?.organizationId)) {
    return <WorkspaceIdentityMismatch />;
  }

  return (
    <div className="studio-viewport h-dvh overflow-hidden" style={brandStyle}>
      <a
        href="#main-content"
        inert={mobileMenuOpen}
        className="sr-only top-3 left-3 z-[60] rounded-[var(--radius-xs)] bg-primary text-sm font-semibold text-primary-foreground focus:not-sr-only focus:fixed focus:px-4 focus:py-2"
      >
        Skip to content
      </a>
      {/* Mobile overlay */}
      {mobileMenuOpen && (
        <>
          <div
            aria-hidden="true"
            className={cn(
              'fixed inset-0 z-40 bg-black/50 backdrop-blur-sm',
              !ownChrome && 'lg:hidden'
            )}
            onClick={() => setMobileMenuOpen(false)}
          />
          <div
            ref={mobileMenuRef}
            role="dialog"
            aria-modal="true"
            aria-label="Mobile navigation"
            tabIndex={-1}
            className={cn('fixed inset-y-0 start-0 z-50 outline-none', !ownChrome && 'lg:hidden')}
          >
            <Sidebar
              brand={brand}
              onNavigate={() => setMobileMenuOpen(false)}
              onClose={() => setMobileMenuOpen(false)}
              collapsible={false}
              pharmacyOnboarding={pharmacyOnboarding}
            />
          </div>
        </>
      )}

      <div
        inert={mobileMenuOpen}
        className="studio-shell flex h-full min-w-0 flex-1 flex-col overflow-hidden"
      >
        {pharmacyPlaceholder ? <PharmacyPlaceholderNotice pathname={pathname} /> : null}
        {session?.user.isSupportSession ? (
          <div className="flex min-h-10 items-center justify-between gap-3 border-b border-warning/40 bg-warning/10 px-4 py-2 text-xs text-foreground">
            <span className="flex items-center gap-2">
              <ShieldAlert className="h-4 w-4 shrink-0" />
              {browserOnline ? (
                <>
                  Audited support access · acting as {session.user.name}
                  {session.user.supportReason ? ` · ${session.user.supportReason}` : ''}
                </>
              ) : (
                // DEV-957 phase 2 (shared till): offline, the stored page cannot check who
                // is signed in, so it names nobody.
                'Audited support access · Offline: who is signed in is checked again when the connection returns.'
              )}
            </span>
            <EndSupportAccessButton />
          </div>
        ) : null}
        {/* DEV-973: a print window behind this page is never lost; self-hiding. */}
        <PrintWindowNotice />
        {ownChrome ? null : <Topbar brand={brand} onMenuClick={openMobileMenu} />}
        {/* WHA-1181 — a one-time setup step for a restaurant administrator whose
            organization activated before staff profiles were provisioned. Self-
            hiding, so it costs a healthy workspace nothing. */}
        <AdministratorStaffProfileCallout />
        {ownChrome ? null : <TopNavigation pharmacyOnboarding={pharmacyOnboarding} />}
        <main
          id="main-content"
          tabIndex={-1}
          data-slot="app-canvas"
          className={cn(
            'studio-canvas relative min-h-0 flex-1 scroll-pt-24',
            counterPos ? 'overflow-hidden' : 'overflow-y-auto'
          )}
        >
          <PageTransition
            travel={!counterPos}
            className={cn(
              'studio-stage mx-auto w-full',
              immersive
                ? 'h-full max-w-none overflow-hidden'
                : 'min-h-full max-w-[1540px] px-4 py-4 sm:px-6 sm:py-6 xl:px-8 xl:pb-8'
            )}
          >
            {moduleEnabled ? (
              <ShellChromeProvider value={chrome}>{children}</ShellChromeProvider>
            ) : (
              <section className="mx-auto max-w-2xl border border-border-default bg-surface-card p-8">
                <Box className="h-8 w-8 text-accent-brand" />
                <p className="mt-6 font-mono text-[10px] uppercase tracking-[0.18em] text-text-muted">
                  Module control
                </p>
                <h1 className="mt-2 font-display text-3xl font-semibold text-text-strong">
                  This module is not enabled
                </h1>
                <p className="mt-3 max-w-xl text-sm leading-6 text-text-muted">
                  Your organization’s current package, contract, or module override does not include{' '}
                  <span className="font-semibold">{moduleDisplayName(currentModule)}</span>.
                  Organization administrators can review the license ledger in settings.
                </p>
                <Link
                  href="/organization"
                  className="mt-6 inline-flex h-10 items-center rounded-control bg-primary px-4 text-xs font-semibold text-primary-foreground"
                >
                  Open organization settings
                </Link>
              </section>
            )}
          </PageTransition>
        </main>
      </div>

      {sessionStatus === 'authenticated' && session?.user.organizationId && (
        <div inert={mobileMenuOpen} className="contents">
          <AskFathomChat
            key={session.user.organizationId}
            organizationId={session.user.organizationId}
          />
        </div>
      )}
    </div>
  );
}
