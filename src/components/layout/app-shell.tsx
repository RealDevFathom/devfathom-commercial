'use client';

import { useState } from 'react';
import dynamic from 'next/dynamic';
import { usePathname } from 'next/navigation';
import { Sidebar, TopNavigation } from './sidebar';
import { Topbar } from './topbar';
import { PageTransition } from '@/components/motion/page-transition';
import { useAssistant } from '@/lib/assistant-store';
import { cn } from '@/lib/utils';

// Lazy-load the assistant panel so @ai-sdk/react + ai stay out of the global
// chunk; only fetched once the user first opens the assistant.
const AssistantPanel = dynamic(
  () => import('@/components/assistant/assistant-panel').then((m) => m.AssistantPanel),
  { ssr: false }
);

export function AppShell({ children }: { children: React.ReactNode }) {
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const pathname = usePathname();
  const immersive = pathname === '/chat' || /^\/meetings\/[^/]+\/call$/.test(pathname);
  const assistantOpen = useAssistant((s) => s.open);
  // Mount the panel once it has been opened, then keep it mounted so chat
  // state survives close/reopen.
  const [assistantMounted, setAssistantMounted] = useState(false);
  if (assistantOpen && !assistantMounted) setAssistantMounted(true);

  return (
    <div className="studio-viewport h-dvh overflow-hidden">
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

      <div className="studio-shell flex h-full min-w-0 flex-1 flex-col overflow-hidden">
        <Topbar onMenuClick={() => setMobileMenuOpen(true)} />
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
            {children}
          </PageTransition>
        </main>
      </div>

      {assistantMounted && <AssistantPanel />}
    </div>
  );
}
