'use client';

import { useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useSession } from 'next-auth/react';
import {
  LayoutDashboard,
  FolderKanban,
  DollarSign,
  Users,
  MessageSquare,
  UserCog,
  Settings,
  ChevronLeft,
  ChevronRight,
  Briefcase,
  Video,
  StickyNote,
  BarChart3,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { LogoIcon } from '@/components/brand/logo';

interface NavItem {
  label: string;
  href: string;
  icon: React.ComponentType<{ className?: string }>;
  adminOnly?: boolean;
}

const navigation: NavItem[] = [
  { label: 'Dashboard', href: '/dashboard', icon: LayoutDashboard },
  { label: 'Projects', href: '/projects', icon: FolderKanban },
  { label: 'Clients', href: '/clients', icon: Briefcase },
  { label: 'Notes', href: '/notes', icon: StickyNote },
  { label: 'Finance', href: '/finance', icon: DollarSign, adminOnly: true },
  { label: 'Meetings', href: '/meetings', icon: Video },
  { label: 'Chat', href: '/chat', icon: MessageSquare },
  { label: 'Team', href: '/team', icon: Users },
  { label: 'Insights', href: '/team/stats', icon: BarChart3, adminOnly: true },
  { label: 'HR', href: '/hr', icon: UserCog, adminOnly: true },
  { label: 'Settings', href: '/settings', icon: Settings },
];

export function Sidebar({ onNavigate }: { onNavigate?: () => void } = {}) {
  const [collapsed, setCollapsed] = useState(false);
  const pathname = usePathname();
  const { data: session } = useSession();
  const isAdmin = session?.user?.role === 'ADMIN';

  const filteredNav = navigation.filter((item) => !item.adminOnly || isAdmin);

  const getInitials = (name: string) => {
    return name
      .split(' ')
      .map((n) => n[0])
      .join('')
      .toUpperCase()
      .slice(0, 2);
  };

  return (
    <aside
      role="navigation"
      aria-label="Main navigation"
      className={cn(
        'fixed left-0 top-0 z-40 flex h-screen flex-col border-r border-sidebar-border bg-sidebar transition-all duration-300 ease-in-out',
        collapsed ? 'w-16' : 'w-60'
      )}
    >
      {/* Logo */}
      <div
        className={cn(
          'flex h-16 items-center border-b border-sidebar-border px-4',
          collapsed ? 'justify-center' : 'gap-3'
        )}
      >
        <LogoIcon className="h-8 w-8 shrink-0" variant="orange" />
        {!collapsed && (
          <div className="flex flex-col overflow-hidden animate-fade-in">
            <span className="font-display text-sm font-bold text-sidebar-accent-foreground tracking-tight">
              Company Hub
            </span>
            <span className="text-[10px] text-sidebar-foreground/50 uppercase tracking-widest">
              Internal Platform
            </span>
          </div>
        )}
      </div>

      {/* Navigation */}
      <nav className="flex-1 space-y-1 overflow-y-auto px-2 py-4">
        {filteredNav.map((item) => {
          // Pick the longest-matching nav href so that on /team/stats only
          // Insights highlights (not also Team, whose href /team is a prefix).
          const matchingHrefs = filteredNav
            .map((i) => i.href)
            .filter((href) => pathname === href || pathname.startsWith(href + '/'));
          const bestMatch = matchingHrefs.reduce(
            (best, href) => (href.length > best.length ? href : best),
            '',
          );
          const isActive = item.href === bestMatch;
          const Icon = item.icon;

          const link = (
            <Link
              key={item.href}
              href={item.href}
              onClick={onNavigate}
              className={cn(
                'group flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-all duration-150',
                isActive
                  ? 'bg-sidebar-accent text-sidebar-accent-foreground shadow-sm'
                  : 'text-sidebar-foreground hover:bg-sidebar-accent/50 hover:text-sidebar-accent-foreground'
              )}
            >
              <Icon
                className={cn(
                  'h-[18px] w-[18px] shrink-0 transition-colors',
                  isActive
                    ? 'text-sidebar-primary'
                    : 'text-sidebar-foreground/60 group-hover:text-sidebar-foreground'
                )}
              />
              {!collapsed && (
                <span className="truncate">{item.label}</span>
              )}
              {isActive && !collapsed && (
                <div className="ml-auto h-1.5 w-1.5 rounded-full bg-sidebar-primary" />
              )}
            </Link>
          );

          if (collapsed) {
            return (
              <Tooltip key={item.href}>
                <TooltipTrigger render={link} />
                <TooltipContent side="right" className="font-medium">
                  {item.label}
                </TooltipContent>
              </Tooltip>
            );
          }

          return link;
        })}
      </nav>

      {/* Collapse toggle */}
      <button
        onClick={() => setCollapsed(!collapsed)}
        className="mx-2 mb-2 flex items-center justify-center rounded-lg p-2 text-sidebar-foreground/50 hover:bg-sidebar-accent/50 hover:text-sidebar-foreground transition-colors"
        aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
      >
        {collapsed ? (
          <ChevronRight className="h-4 w-4" />
        ) : (
          <ChevronLeft className="h-4 w-4" />
        )}
      </button>

      {/* User section */}
      <div
        className={cn(
          'border-t border-sidebar-border p-3',
          collapsed ? 'flex justify-center' : ''
        )}
      >
        {session?.user && (
          <div
            className={cn(
              'flex items-center gap-3',
              collapsed ? 'justify-center' : ''
            )}
          >
            <Avatar className="h-8 w-8 shrink-0">
              <AvatarImage src={session.user.image ?? undefined} alt={session.user.name} />
              <AvatarFallback className="bg-sidebar-primary/20 text-sidebar-primary text-xs font-medium">
                {getInitials(session.user.name)}
              </AvatarFallback>
            </Avatar>
            {!collapsed && (
              <div className="flex flex-col overflow-hidden">
                <span className="truncate text-sm font-medium text-sidebar-accent-foreground">
                  {session.user.name}
                </span>
                <span className="truncate text-xs text-sidebar-foreground/50">
                  {session.user.title}
                </span>
              </div>
            )}
          </div>
        )}
      </div>
    </aside>
  );
}
