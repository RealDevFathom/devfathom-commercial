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
  // Email stays disabled until its OAuth credentials and mailbox schema are deployed.
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

function useVisibleNavigation() {
  const pathname = usePathname();
  const { data: session } = useSession();
  const isAdmin = session?.user?.role === 'ADMIN';
  const isHr = session?.user?.role === 'HR';

  const filteredNav = navigation.filter((item) => {
    if (item.hrAccess) return isAdmin || isHr;
    if (item.adminOnly) return isAdmin;
    return true;
  });

  const indexByHref = new Map(filteredNav.map((item, i) => [item.href, i + 1]));
  const matchingHrefs = filteredNav
    .map((item) => item.href)
    .filter((href) => pathname === href || pathname.startsWith(href + '/'));
  const bestMatch = matchingHrefs.reduce(
    (best, href) => (href.length > best.length ? href : best),
    ''
  );

  return { bestMatch, filteredNav, indexByHref };
}

interface SidebarProps {
  onNavigate?: () => void;
  collapsed?: boolean;
  onCollapsedChange?: (collapsed: boolean) => void;
  collapsible?: boolean;
}

export function Sidebar({
  onNavigate,
  collapsed: controlledCollapsed,
  onCollapsedChange,
  collapsible = true,
}: SidebarProps = {}) {
  const [localCollapsed, setLocalCollapsed] = useState(false);
  const collapsed = controlledCollapsed ?? localCollapsed;
  const { data: session } = useSession();
  const { icons } = usePreferences();
  const { bestMatch, filteredNav, indexByHref } = useVisibleNavigation();
  const numbered = icons !== 'architectural';

  const getInitials = (name: string) =>
    name
      .split(' ')
      .map((n) => n[0])
      .join('')
      .toUpperCase()
      .slice(0, 2);

  let renderIndex = 0;

  const toggleCollapsed = () => {
    const next = !collapsed;
    if (controlledCollapsed == null) setLocalCollapsed(next);
    onCollapsedChange?.(next);
  };

  return (
    <aside
      role="navigation"
      aria-label="Main navigation"
      data-collapsed={collapsed || undefined}
      className={cn(
        'fixed left-0 top-0 z-40 flex h-dvh flex-col border-r border-sidebar-border bg-sidebar text-sidebar-foreground transition-[width] duration-300 ease-out',
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
                    transition={{
                      delay: 0.03 * animIndex + 0.05,
                      duration: 0.4,
                      ease: easeOutExpo,
                    }}
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
      {collapsible && (
        <button
          onClick={toggleCollapsed}
          className={cn(
            'mx-2 mb-2 flex items-center rounded-md p-2 font-mono text-[10px] uppercase tracking-[0.14em] text-sidebar-foreground/50 transition-colors hover:bg-sidebar-accent/50 hover:text-sidebar-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring',
            collapsed ? 'justify-center' : 'justify-between px-3'
          )}
          aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
        >
          {!collapsed && <span>Close rail</span>}
          {collapsed ? <ChevronRight className="h-4 w-4" /> : <ChevronLeft className="h-4 w-4" />}
        </button>
      )}

      {/* User chip */}
      <div
        className={cn('border-t border-sidebar-border p-3', collapsed ? 'flex justify-center' : '')}
      >
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

export function TopNavigation() {
  const { icons } = usePreferences();
  const { bestMatch, filteredNav, indexByHref } = useVisibleNavigation();
  const numbered = icons !== 'architectural';

  return (
    <div className="hidden border-b border-border-subtle bg-background lg:block">
      <nav
        aria-label="Primary navigation"
        className="mx-auto flex h-12 w-full max-w-[1440px] items-stretch overflow-x-auto px-[clamp(1.25rem,5vw,4rem)]"
      >
        {filteredNav.map((item, index) => {
          const isActive = item.href === bestMatch;
          const beginsFirmGroup = item.group === 'Firm' && filteredNav[index - 1]?.group !== 'Firm';
          const Icon = item.icon;
          const num = indexByHref.get(item.href) ?? 0;

          return (
            <Link
              key={item.href}
              href={item.href}
              aria-current={isActive ? 'page' : undefined}
              className={cn(
                'group relative flex shrink-0 items-center gap-2 px-3 text-xs font-medium text-text-muted transition-colors hover:text-text-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring',
                isActive && 'text-text-strong',
                beginsFirmGroup && 'ml-3 border-l border-border-default pl-5'
              )}
            >
              {numbered ? (
                <span
                  className={cn(
                    'font-mono text-[10px] tabular-nums text-text-faint',
                    isActive && 'text-accent-brand'
                  )}
                >
                  {String(num).padStart(2, '0')}
                </span>
              ) : (
                <Icon
                  className={cn(
                    'h-3.5 w-3.5 text-text-faint group-hover:text-text-muted',
                    isActive && 'text-accent-brand'
                  )}
                />
              )}
              <span>{item.label}</span>
              {isActive && (
                <m.span
                  layoutId="topnav-active"
                  className="absolute inset-x-3 bottom-0 h-0.5 bg-accent-brand"
                  transition={{ type: 'spring', stiffness: 420, damping: 34 }}
                />
              )}
            </Link>
          );
        })}
      </nav>
    </div>
  );
}
