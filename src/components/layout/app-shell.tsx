'use client';

import { useState } from 'react';
import { Sidebar } from './sidebar';
import { Topbar } from './topbar';
import { PageTransition } from '@/components/motion/page-transition';
import { AssistantPanel } from '@/components/assistant/assistant-panel';

export function AppShell({ children }: { children: React.ReactNode }) {
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

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

      <div className="flex flex-1 flex-col lg:pl-60 transition-all duration-300">
        <Topbar onMenuClick={() => setMobileMenuOpen(true)} />
        <main className="flex-1 overflow-y-auto">
          <PageTransition className="mx-auto max-w-[1400px] p-4 sm:p-6">{children}</PageTransition>
        </main>
      </div>

      <AssistantPanel />
    </div>
  );
}
