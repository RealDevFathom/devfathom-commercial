'use client';

import { useEffect, useState, type CSSProperties } from 'react';
import dynamic from 'next/dynamic';
import { usePathname } from 'next/navigation';
import { Sidebar, TopNavigation } from './sidebar';
import { Topbar } from './topbar';
import { PageTransition } from '@/components/motion/page-transition';
import { useAssistant } from '@/lib/assistant-store';
import { cn } from '@/lib/utils';
import { useEntitlements } from '@/components/entitlements-provider';
import { moduleForPath } from '@/lib/module-catalog';
import type { EntitlementView } from '@/lib/module-catalog';
import { Box, Loader2, ShieldAlert } from 'lucide-react';
import { useSession } from 'next-auth/react';
import Link from 'next/link';
import { isTenantIdentityMismatch, tenantBrandTokens, type TenantBrand } from '@/lib/tenant-brand';
import { toast } from 'sonner';

// Lazy-load the assistant panel so @ai-sdk/react + ai stay out of the global
// chunk; only fetched once the user first opens the assistant.
const AssistantPanel = dynamic(
  () => import('@/components/assistant/assistant-panel').then((m) => m.AssistantPanel),
  { ssr: false }
);

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
          className="mt-6 inline-flex h-10 items-center bg-abyss-900 px-4 text-xs font-semibold text-paper-white"
        >
          Reload this workspace
        </button>
      </section>
    </div>
  );
}

export function isPathModuleEnabled(
  pathname: string,
  entitlements: Pick<EntitlementView, 'enabledModules' | 'vertical'>
) {
  const moduleKey = moduleForPath(pathname, entitlements.vertical);
  return !moduleKey || entitlements.enabledModules.includes(moduleKey);
}

export function AppShell({
  children,
  brand,
}: {
  children: React.ReactNode;
  brand: TenantBrand;
}) {
  // The server-side invariant lives in the `/(app)` layout, which fails closed
  // before this renders. Here the live session is the moving part, so the check
  // below (after every hook) degrades to a notice rather than throwing.
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const pathname = usePathname();
  const { data: session } = useSession();
  const entitlements = useEntitlements();
  const currentModule = moduleForPath(pathname, entitlements.vertical);
  const moduleEnabled = !currentModule || entitlements.enabledModules.includes(currentModule);
  const immersive = pathname === '/chat' || /^\/meetings\/[^/]+\/call$/.test(pathname);
  const assistantOpen = useAssistant((s) => s.open);
  // Mount the panel once it has been opened, then keep it mounted so chat
  // state survives close/reopen.
  const [assistantMounted, setAssistantMounted] = useState(false);
  if (assistantOpen && !assistantMounted) setAssistantMounted(true);
  const brandStyle = tenantBrandTokens(brand) as CSSProperties;

  useEffect(() => {
    if (!mobileMenuOpen) return;

    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setMobileMenuOpen(false);
    };

    document.addEventListener('keydown', closeOnEscape);
    return () => document.removeEventListener('keydown', closeOnEscape);
  }, [mobileMenuOpen]);

  // WHA-276: enforce the invariant that displayed workspace identity can never
  // diverge from session.user.organizationId. Every hook above has already run,
  // so this early return is safe under the Rules of Hooks.
  if (isTenantIdentityMismatch(brand, session?.user?.organizationId)) {
    return <WorkspaceIdentityMismatch />;
  }

  return (
    <div className="studio-viewport h-dvh overflow-hidden" style={brandStyle}>
      {/* Mobile overlay */}
      {mobileMenuOpen && (
        <>
          <div
            aria-hidden="true"
            className="fixed inset-0 z-40 bg-black/50 backdrop-blur-sm lg:hidden"
            onClick={() => setMobileMenuOpen(false)}
          />
          <div
            role="dialog"
            aria-modal="true"
            aria-label="Mobile navigation"
            className="fixed inset-y-0 left-0 z-50 lg:hidden"
          >
            <Sidebar
              brand={brand}
              onNavigate={() => setMobileMenuOpen(false)}
              collapsible={false}
            />
          </div>
        </>
      )}

      <div className="studio-shell flex h-full min-w-0 flex-1 flex-col overflow-hidden">
        {session?.user.isSupportSession ? (
          <div className="flex min-h-10 items-center justify-between gap-3 border-b border-amber-300 bg-amber-50 px-4 py-2 text-xs text-amber-950">
            <span className="flex items-center gap-2">
              <ShieldAlert className="h-4 w-4 shrink-0" />
              Audited support access · acting as {session.user.name}
              {session.user.supportReason ? ` · ${session.user.supportReason}` : ''}
            </span>
            <EndSupportAccessButton />
          </div>
        ) : null}
        <Topbar brand={brand} onMenuClick={() => setMobileMenuOpen(true)} />
        <TopNavigation />
        <main
          data-slot="app-canvas"
          className="studio-canvas relative min-h-0 flex-1 overflow-y-auto scroll-pt-24"
        >
          <PageTransition
            className={cn(
              'studio-stage mx-auto w-full',
              immersive
                ? 'h-full max-w-none overflow-hidden'
                : 'min-h-full max-w-[1540px] px-4 py-4 sm:px-6 sm:py-6 xl:px-8 xl:pb-8'
            )}
          >
            {moduleEnabled ? (
              children
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
                  <span className="font-semibold">{currentModule}</span>. Organization
                  administrators can review the license ledger in settings.
                </p>
                <Link
                  href="/organization"
                  className="mt-6 inline-flex h-10 items-center bg-abyss-900 px-4 text-xs font-semibold text-paper-white"
                >
                  Open organization settings
                </Link>
              </section>
            )}
          </PageTransition>
        </main>
      </div>

      {assistantMounted && <AssistantPanel />}
    </div>
  );
}
