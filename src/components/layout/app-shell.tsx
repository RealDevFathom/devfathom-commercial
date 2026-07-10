'use client';

import { useEffect, useRef, useState } from 'react';
import dynamic from 'next/dynamic';
import { usePathname } from 'next/navigation';
import { gsap } from 'gsap';
import { Sidebar, TopNavigation } from './sidebar';
import { Topbar } from './topbar';
import { PageTransition } from '@/components/motion/page-transition';
import { useAssistant } from '@/lib/assistant-store';
import { cn } from '@/lib/utils';
import { usePreferences } from '@/components/preferences-provider';

// Lazy-load the assistant panel so @ai-sdk/react + ai stay out of the global
// chunk; only fetched once the user first opens the assistant.
const AssistantPanel = dynamic(
  () => import('@/components/assistant/assistant-panel').then((m) => m.AssistantPanel),
  { ssr: false }
);

export function AppShell({ children }: { children: React.ReactNode }) {
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const shellRef = useRef<HTMLDivElement>(null);
  const pathname = usePathname();
  const { layout } = usePreferences();
  const usesRail = layout !== 'top';
  const immersive = pathname === '/chat' || /^\/meetings\/[^/]+\/call$/.test(pathname);
  const assistantOpen = useAssistant((s) => s.open);
  // Mount the panel once it has been opened, then keep it mounted so chat
  // state survives close/reopen.
  const [assistantMounted, setAssistantMounted] = useState(false);
  if (assistantOpen && !assistantMounted) setAssistantMounted(true);

  // The spine is the Fieldbook's single choreographed moment: it redraws on
  // route changes to keep orientation visible without animating the page chrome.
  useEffect(() => {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const context = gsap.context(() => {
      gsap.fromTo(
        '[data-fieldbook-spine-marker]',
        { scaleY: 0, transformOrigin: 'top center' },
        { scaleY: 1, duration: 0.46, ease: 'power3.out', overwrite: 'auto' }
      );
    }, shellRef);
    return () => context.revert();
  }, [pathname]);

  return (
    <div ref={shellRef} data-fieldbook-shell className="fieldbook-shell flex h-dvh overflow-hidden bg-background">
      {/* Desktop sidebar */}
      {usesRail && (
        <div className="hidden lg:block">
          <Sidebar collapsed={sidebarCollapsed} onCollapsedChange={setSidebarCollapsed} />
        </div>
      )}

      {/* Mobile overlay */}
      {mobileMenuOpen && (
        <>
          <div
            className="fixed inset-0 z-40 bg-black/50 backdrop-blur-sm lg:hidden"
            onClick={() => setMobileMenuOpen(false)}
          />
          <div className="fixed inset-y-0 left-0 z-50 lg:hidden">
            <Sidebar onNavigate={() => setMobileMenuOpen(false)} collapsible={false} />
          </div>
        </>
      )}

      <div
        className={cn(
          'flex min-w-0 flex-1 flex-col transition-[padding] duration-300 ease-out',
          usesRail && (sidebarCollapsed ? 'lg:pl-16' : 'lg:pl-72')
        )}
      >
        <Topbar onMenuClick={() => setMobileMenuOpen(true)} />
        {!usesRail && <TopNavigation />}
        <main
          data-slot="app-canvas"
          className="fieldbook-canvas relative min-h-0 flex-1 overflow-y-auto scroll-pt-24"
        >
          <div aria-hidden data-fieldbook-spine className="fieldbook-spine hidden xl:block">
            <span data-fieldbook-spine-marker className="fieldbook-spine-marker" />
          </div>
          <PageTransition
            className={cn(
              'fieldbook-stage mx-auto w-full',
              immersive
                ? 'h-full max-w-none overflow-hidden'
                : 'h-full max-w-[1520px] px-[clamp(1.25rem,5vw,4.75rem)] py-7 lg:py-10'
            )}
          >
            {children}
          </PageTransition>
        </main>
      </div>

      {assistantMounted && <AssistantPanel />}
    </div>
  );
}
