'use client';

import { useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useSession } from 'next-auth/react';
import { m } from 'motion/react';
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
  ScrollText,
  ClipboardList,
  Mail,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { easeOutExpo } from '@/lib/motion';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { FathomMark } from '@/components/brand/logo';
import { usePreferences } from '@/components/preferences-provider';

type NavGroup = 'Workspace' | 'Firm';

interface NavItem {
  label: string;
  href: string;
  icon: React.ComponentType<{ className?: string }>;
  group: NavGroup;
  adminOnly?: boolean;
  // Visible to ADMIN and HR (people-ops surfaces). Takes precedence over adminOnly.
  hrAccess?: boolean;
}

// Grouped to match the prototype's WORKSPACE / FIRM rail. Order defines the
// numbered index (recomputed after RBAC filtering so numbers stay contiguous).
const navigation: NavItem[] = [
  { label: 'Dashboard', href: '/dashboard', icon: LayoutDashboard, group: 'Workspace' },
  { label: 'Projects', href: '/projects', icon: FolderKanban, group: 'Workspace' },
  { label: 'Clients', href: '/clients', icon: Briefcase, group: 'Workspace' },
  { label: 'Notes', href: '/notes', icon: StickyNote, group: 'Workspace' },
  { label: 'Email', href: '/email', icon: Mail, group: 'Workspace' },
  { label: 'Meetings', href: '/meetings', icon: Video, group: 'Workspace' },
  { label: 'Chat', href: '/chat', icon: MessageSquare, group: 'Workspace' },
  { label: 'Finance', href: '/finance', icon: DollarSign, adminOnly: true, group: 'Firm' },
  { label: 'Team', href: '/team', icon: Users, group: 'Firm' },
  { label: 'Reviews', href: '/reviews', icon: ClipboardList, group: 'Firm' },
  { label: 'Insights', href: '/team/stats', icon: BarChart3, adminOnly: true, group: 'Firm' },
  { label: 'HR', href: '/hr', icon: UserCog, hrAccess: true, group: 'Firm' },
  { label: 'Audit Log', href: '/audit-logs', icon: ScrollText, adminOnly: true, group: 'Firm' },
  { label: 'Settings', href: '/settings', icon: Settings, group: 'Firm' },
];

const GROUP_ORDER: NavGroup[] = ['Workspace', 'Firm'];

export function Sidebar({ onNavigate }: { onNavigate?: () => void } = {}) {
  const [collapsed, setCollapsed] = useState(false);
  const pathname = usePathname();
  const { data: session } = useSession();
  const { icons } = usePreferences();
  const numbered = icons !== 'architectural';
  const isAdmin = session?.user?.role === 'ADMIN';
  const isHr = session?.user?.role === 'HR';

  const filteredNav = navigation.filter((item) => {
    if (item.hrAccess) return isAdmin || isHr; // people-ops surfaces (HR console)
    if (item.adminOnly) return isAdmin;
    return true;
  });

  // Contiguous numeric index across the (filtered) rail — 01, 02, …
  const indexByHref = new Map(filteredNav.map((item, i) => [item.href, i + 1]));

  // Longest-matching href wins so /team/stats highlights Insights, not Team.
  const matchingHrefs = filteredNav
    .map((i) => i.href)
    .filter((href) => pathname === href || pathname.startsWith(href + '/'));
  const bestMatch = matchingHrefs.reduce((best, href) => (href.length > best.length ? href : best), '');

  const getInitials = (name: string) =>
    name
      .split(' ')
      .map((n) => n[0])
      .join('')
      .toUpperCase()
      .slice(0, 2);

  let renderIndex = 0;

  return (
    <aside
      role="navigation"
      aria-label="Main navigation"
      className={cn(
        'fixed left-0 top-0 z-40 flex h-screen flex-col border-r border-sidebar-border bg-sidebar transition-all duration-300 ease-in-out',
        collapsed ? 'w-16' : 'w-60'
      )}
    >
      {/* Wordmark */}
      <div
        className={cn(
          'flex h-16 items-center border-b border-sidebar-border px-4',
          collapsed ? 'justify-center' : 'gap-3'
        )}
      >
        <FathomMark className="h-8 w-8 shrink-0" variant="white" />
        {!collapsed && (
          <div className="flex flex-col overflow-hidden animate-fade-in">
            <span className="font-display text-sm font-semibold tracking-tight text-sidebar-accent-foreground">
              DevFathom
            </span>
            <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-sidebar-foreground/50">
              Company hub
            </span>
          </div>
        )}
      </div>

      {/* Navigation */}
      <nav className="flex-1 space-y-5 overflow-y-auto px-2 py-4">
        {GROUP_ORDER.map((group) => {
          const items = filteredNav.filter((i) => i.group === group);
          if (items.length === 0) return null;
          return (
            <div key={group} className="space-y-1">
              {!collapsed && (
                <p className="px-3 pb-1.5 font-mono text-[10px] font-semibold uppercase tracking-[0.16em] text-sidebar-foreground/40">
                  {group}
                </p>
              )}
              {items.map((item) => {
                const isActive = item.href === bestMatch;
                const Icon = item.icon;
                const num = indexByHref.get(item.href) ?? 0;
                const animIndex = renderIndex++;

                const link = (
                  <Link
                    href={item.href}
                    onClick={onNavigate}
                    aria-current={isActive ? 'page' : undefined}
                    className={cn(
                      'group relative flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors duration-150',
                      collapsed && 'justify-center px-0',
                      isActive
                        ? 'text-sidebar-accent-foreground'
                        : 'text-sidebar-foreground hover:bg-sidebar-accent/40 hover:text-sidebar-accent-foreground'
                    )}
                  >
                    {isActive && (
                      <m.span
                        layoutId="sidebar-active"
                        className="absolute inset-0 rounded-md bg-sidebar-accent shadow-sm"
                        style={{ boxShadow: 'inset 2px 0 0 0 var(--sidebar-primary)' }}
                        transition={{ type: 'spring', stiffness: 420, damping: 34 }}
                      />
                    )}
                    {/* Index (numeric) or architectural icon */}
                    {numbered ? (
                      <span
                        className={cn(
                          'relative z-10 w-5 shrink-0 text-center font-mono text-[11px] tabular-nums transition-colors',
                          isActive
                            ? 'text-sidebar-primary'
                            : 'text-sidebar-foreground/45 group-hover:text-sidebar-foreground/70'
                        )}
                      >
                        {String(num).padStart(2, '0')}
                      </span>
                    ) : (
                      <Icon
                        className={cn(
                          'relative z-10 h-[18px] w-[18px] shrink-0 transition-colors',
                          isActive
                            ? 'text-sidebar-primary'
                            : 'text-sidebar-foreground/60 group-hover:text-sidebar-foreground'
                        )}
                      />
                    )}
                    {!collapsed && <span className="relative z-10 truncate">{item.label}</span>}
                  </Link>
                );

                const entry = collapsed ? (
                  <Tooltip>
                    <TooltipTrigger render={link} />
                    <TooltipContent side="right" className="font-medium">
                      {item.label}
                    </TooltipContent>
                  </Tooltip>
                ) : (
                  link
                );

                return (
                  <m.div
                    key={item.href}
                    initial={{ opacity: 0, x: -10 }}
                    animate={{ opacity: 1, x: 0 }}
                    transition={{ delay: 0.03 * animIndex + 0.05, duration: 0.4, ease: easeOutExpo }}
                  >
                    {entry}
                  </m.div>
                );
              })}
            </div>
          );
        })}
      </nav>

      {/* Collapse toggle */}
      <button
        onClick={() => setCollapsed(!collapsed)}
        className="mx-2 mb-2 flex items-center justify-center rounded-md p-2 text-sidebar-foreground/50 transition-colors hover:bg-sidebar-accent/50 hover:text-sidebar-foreground"
        aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
      >
        {collapsed ? <ChevronRight className="h-4 w-4" /> : <ChevronLeft className="h-4 w-4" />}
      </button>

      {/* User chip */}
      <div className={cn('border-t border-sidebar-border p-3', collapsed ? 'flex justify-center' : '')}>
        {session?.user && (
          <div className={cn('flex items-center gap-3', collapsed ? 'justify-center' : '')}>
            <Avatar className="h-8 w-8 shrink-0 rounded-md">
              <AvatarImage src={session.user.image ?? undefined} alt={session.user.name} />
              <AvatarFallback className="rounded-md bg-sidebar-primary/20 text-xs font-medium text-sidebar-primary">
                {getInitials(session.user.name)}
              </AvatarFallback>
            </Avatar>
            {!collapsed && (
              <div className="flex flex-col overflow-hidden">
                <span className="truncate text-sm font-medium text-sidebar-accent-foreground">
                  {session.user.name}
                </span>
                <span className="truncate font-mono text-[11px] text-sidebar-foreground/50">
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
