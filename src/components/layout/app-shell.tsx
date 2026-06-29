'use client';

import { useState } from 'react';
import dynamic from 'next/dynamic';
import { Sidebar } from './sidebar';
import { Topbar } from './topbar';
import { PageTransition } from '@/components/motion/page-transition';
import { useAssistant } from '@/lib/assistant-store';

// Lazy-load the assistant panel so @ai-sdk/react + ai stay out of the global
// chunk; only fetched once the user first opens the assistant.
const AssistantPanel = dynamic(
  () => import('@/components/assistant/assistant-panel').then((m) => m.AssistantPanel),
  { ssr: false }
);

export function AppShell({ children }: { children: React.ReactNode }) {
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const assistantOpen = useAssistant((s) => s.open);
  // Mount the panel once it has been opened, then keep it mounted so chat
  // state survives close/reopen.
  const [assistantMounted, setAssistantMounted] = useState(false);
  if (assistantOpen && !assistantMounted) setAssistantMounted(true);

  return (
    <div className="flex h-screen overflow-hidden">
      {/* Desktop sidebar */}
      <div className="hidden lg:block">
        <Sidebar />
      </div>

      {/* Mobile overlay */}
      {mobileMenuOpen && (
        <>
          <div
            className="fixed inset-0 z-40 bg-black/50 backdrop-blur-sm lg:hidden"
            onClick={() => setMobileMenuOpen(false)}
          />
          <div className="fixed inset-y-0 left-0 z-50 lg:hidden">
            <Sidebar onNavigate={() => setMobileMenuOpen(false)} />
          </div>
        </>
      )}

      <div className="flex min-w-0 flex-1 flex-col lg:pl-60 transition-all duration-300">
        <Topbar onMenuClick={() => setMobileMenuOpen(true)} />
        <main className="flex-1 overflow-y-auto">
          <PageTransition className="mx-auto max-w-[1400px] px-[clamp(1.25rem,5vw,4rem)] py-8">
            {children}
          </PageTransition>
        </main>
      </div>

      {assistantMounted && <AssistantPanel />}
    </div>
  );
}
