'use client';

import { useState, useEffect, useCallback } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { signOut, useSession } from 'next-auth/react';
import {
  Search,
  Bell,
  Moon,
  Sun,
  LogOut,
  User,
  ChevronRight,
  CheckCheck,
  Menu,
  FolderKanban,
  CheckSquare,
  Briefcase,
  StickyNote,
  Users as UsersIcon,
  Loader2,
} from 'lucide-react';
import { useTheme } from 'next-themes';
import { cn } from '@/lib/utils';
import { trpc } from '@/lib/trpc';
import { formatDistanceToNow } from 'date-fns';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
// Badge unused after notification refactor
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command';

const routeLabels: Record<string, string> = {
  '/dashboard': 'Dashboard',
  '/projects': 'Projects',
  '/clients': 'Clients',
  '/notes': 'Notes',
  '/finance': 'Finance',
  '/meetings': 'Meetings',
  '/chat': 'Chat',
  '/team': 'Team',
  '/hr': 'HR & Leave',
  '/settings': 'Settings',
};

export function Topbar({ onMenuClick }: { onMenuClick?: () => void } = {}) {
  const [commandOpen, setCommandOpen] = useState(false);
  const [searchInput, setSearchInput] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const pathname = usePathname();
  const router = useRouter();
  const { data: session } = useSession();
  const { theme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  // Debounce search input
  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(searchInput.trim()), 200);
    return () => clearTimeout(t);
  }, [searchInput]);

  // Reset search when palette closes
  useEffect(() => {
    if (!commandOpen) {
      setSearchInput('');
      setDebouncedSearch('');
    }
  }, [commandOpen]);

  const searchQuery = trpc.search.global.useQuery(
    { query: debouncedSearch },
    { enabled: debouncedSearch.length > 0, staleTime: 30_000 },
  );

  const goTo = (href: string) => {
    setCommandOpen(false);
    router.push(href);
  };

  // Cmd+K keyboard shortcut
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.key === 'k' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        setCommandOpen((open) => !open);
      }
    };
    document.addEventListener('keydown', down);
    return () => document.removeEventListener('keydown', down);
  }, []);

  const getBreadcrumbs = useCallback(() => {
    const segments = pathname.split('/').filter(Boolean);
    const crumbs: { label: string; href: string }[] = [];

    let path = '';
    for (const segment of segments) {
      path += `/${segment}`;
      const label = routeLabels[path] || segment.charAt(0).toUpperCase() + segment.slice(1);
      crumbs.push({ label, href: path });
    }

    return crumbs;
  }, [pathname]);

  const breadcrumbs = getBreadcrumbs();

  const getInitials = (name: string) =>
    name
      .split(' ')
      .map((n) => n[0])
      .join('')
      .toUpperCase()
      .slice(0, 2);

  return (
    <>
      <header className="sticky top-0 z-30 flex h-16 items-center gap-4 border-b border-border/60 bg-background/90 backdrop-blur-xl px-4 sm:px-6">
        {/* Mobile menu button */}
        {onMenuClick && (
          <button
            onClick={onMenuClick}
            className="flex lg:hidden h-9 w-9 items-center justify-center rounded-lg text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
            aria-label="Open menu"
          >
            <Menu className="h-5 w-5" />
          </button>
        )}

        {/* Breadcrumbs */}
        <nav className="flex items-center gap-1 text-sm">
          {breadcrumbs.map((crumb, i) => (
            <div key={crumb.href} className="flex items-center gap-1">
              {i > 0 && (
                <ChevronRight className="h-3.5 w-3.5 text-muted-foreground/50" />
              )}
              <span
                className={cn(
                  'font-medium',
                  i === breadcrumbs.length - 1
                    ? 'text-foreground'
                    : 'text-muted-foreground'
                )}
              >
                {crumb.label}
              </span>
            </div>
          ))}
        </nav>

        <div className="ml-auto flex items-center gap-2">
          {/* Search */}
          <button
            onClick={() => setCommandOpen(true)}
            className="hidden sm:flex h-9 w-64 items-center gap-2 rounded-lg border border-border bg-muted/50 px-3 text-sm text-muted-foreground transition-colors hover:bg-muted"
          >
            <Search className="h-4 w-4" />
            <span className="flex-1 text-left">Search...</span>
            <kbd className="pointer-events-none inline-flex h-5 select-none items-center gap-1 rounded border border-border bg-background px-1.5 font-mono text-[10px] font-medium text-muted-foreground">
              <span className="text-xs">⌘</span>K
            </kbd>
          </button>

          {/* Dark mode toggle */}
          {mounted && (
            <button
              onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
              className="flex h-9 w-9 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              aria-label="Toggle theme"
            >
              {theme === 'dark' ? (
                <Sun className="h-[18px] w-[18px]" />
              ) : (
                <Moon className="h-[18px] w-[18px]" />
              )}
            </button>
          )}

          {/* Notifications */}
          <NotificationBell />

          {/* User dropdown */}
          {session?.user && (
            <DropdownMenu>
              <DropdownMenuTrigger className="flex items-center gap-2 rounded-lg p-1.5 transition-colors hover:bg-muted">
                <Avatar className="h-7 w-7">
                  <AvatarImage src={session.user.image ?? undefined} alt={session.user.name} />
                  <AvatarFallback className="bg-primary/10 text-primary text-xs font-medium">
                    {getInitials(session.user.name)}
                  </AvatarFallback>
                </Avatar>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-56">
                <div className="px-2 py-2">
                  <p className="text-sm font-medium">{session.user.name}</p>
                  <p className="text-xs text-muted-foreground">{session.user.email}</p>
                </div>
                <DropdownMenuSeparator />
                <DropdownMenuItem>
                  <User className="mr-2 h-4 w-4" />
                  Profile
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  onClick={() => signOut({ callbackUrl: '/login' })}
                  className="text-destructive focus:text-destructive"
                >
                  <LogOut className="mr-2 h-4 w-4" />
                  Sign out
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>
      </header>

      {/* Command palette (Cmd+K) */}
      <CommandDialog
        open={commandOpen}
        onOpenChange={setCommandOpen}
        commandProps={{ shouldFilter: false }}
      >
        <CommandInput
          placeholder="Search projects, tasks, clients, notes, team…"
          value={searchInput}
          onValueChange={setSearchInput}
        />
        <CommandList>
          {debouncedSearch.length === 0 ? (
            <CommandGroup heading="Navigation">
              {Object.entries(routeLabels).map(([href, label]) => (
                <CommandItem key={href} onSelect={() => goTo(href)}>
                  {label}
                </CommandItem>
              ))}
            </CommandGroup>
          ) : searchQuery.isLoading ? (
            <div className="flex items-center justify-center py-10 text-xs text-muted-foreground">
              <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" /> Searching…
            </div>
          ) : (() => {
              const r = searchQuery.data;
              const empty =
                !r ||
                (r.projects.length === 0 &&
                  r.tasks.length === 0 &&
                  r.clients.length === 0 &&
                  r.notes.length === 0 &&
                  r.team.length === 0);
              if (empty) return <CommandEmpty>No results for &ldquo;{debouncedSearch}&rdquo;.</CommandEmpty>;
              return (
                <>
                  {r!.projects.length > 0 && (
                    <CommandGroup heading="Projects">
                      {r!.projects.map((p) => (
                        <CommandItem
                          key={`p-${p.id}`}
                          value={`project ${p.name} ${p.client?.name ?? ''}`}
                          onSelect={() => goTo(`/projects/${p.id}`)}
                        >
                          <FolderKanban className="mr-2 h-3.5 w-3.5 text-muted-foreground" />
                          <span className="flex-1 truncate">{p.name}</span>
                          <span className="ml-2 shrink-0 text-[10px] text-muted-foreground">
                            {p.client?.name ?? (p.type === 'INTERNAL' ? 'Internal' : '')}
                          </span>
                        </CommandItem>
                      ))}
                    </CommandGroup>
                  )}
                  {r!.tasks.length > 0 && (
                    <CommandGroup heading="Tasks">
                      {r!.tasks.map((t) => {
                        const projectId = t.column?.board?.project?.id;
                        const projectName = t.column?.board?.project?.name ?? '';
                        return (
                          <CommandItem
                            key={`t-${t.id}`}
                            value={`task ${t.title} ${projectName}`}
                            onSelect={() => projectId && goTo(`/projects/${projectId}`)}
                          >
                            <CheckSquare className="mr-2 h-3.5 w-3.5 text-muted-foreground" />
                            <span className="flex-1 truncate">{t.title}</span>
                            <span className="ml-2 shrink-0 text-[10px] text-muted-foreground">
                              {projectName}
                            </span>
                          </CommandItem>
                        );
                      })}
                    </CommandGroup>
                  )}
                  {r!.clients.length > 0 && (
                    <CommandGroup heading="Clients">
                      {r!.clients.map((c) => (
                        <CommandItem
                          key={`c-${c.id}`}
                          value={`client ${c.name} ${c.industry ?? ''}`}
                          onSelect={() => goTo(`/clients/${c.id}`)}
                        >
                          <Briefcase className="mr-2 h-3.5 w-3.5 text-muted-foreground" />
                          <span className="flex-1 truncate">{c.name}</span>
                          {c.industry && (
                            <span className="ml-2 shrink-0 text-[10px] text-muted-foreground">
                              {c.industry}
                            </span>
                          )}
                        </CommandItem>
                      ))}
                    </CommandGroup>
                  )}
                  {r!.notes.length > 0 && (
                    <CommandGroup heading="Notes">
                      {r!.notes.map((n) => (
                        <CommandItem
                          key={`n-${n.id}`}
                          value={`note ${n.title}`}
                          onSelect={() => goTo(`/notes/${n.id}`)}
                        >
                          <StickyNote className="mr-2 h-3.5 w-3.5 text-muted-foreground" />
                          <span className="flex-1 truncate">{n.title || 'Untitled'}</span>
                          <span className="ml-2 shrink-0 text-[10px] text-muted-foreground capitalize">
                            {n.visibility.toLowerCase()}
                          </span>
                        </CommandItem>
                      ))}
                    </CommandGroup>
                  )}
                  {r!.team.length > 0 && (
                    <CommandGroup heading="Team">
                      {r!.team.map((u) => (
                        <CommandItem
                          key={`u-${u.id}`}
                          value={`user ${u.name} ${u.title ?? ''}`}
                          onSelect={() => goTo(`/team/${u.id}`)}
                        >
                          <UsersIcon className="mr-2 h-3.5 w-3.5 text-muted-foreground" />
                          <span className="flex-1 truncate">{u.name}</span>
                          {u.title && (
                            <span className="ml-2 shrink-0 text-[10px] text-muted-foreground">
                              {u.title}
                            </span>
                          )}
                        </CommandItem>
                      ))}
                    </CommandGroup>
                  )}
                </>
              );
            })()}
        </CommandList>
      </CommandDialog>
    </>
  );
}

function NotificationBell() {
  const [open, setOpen] = useState(false);
  const utils = trpc.useUtils();
  const { data: notifications } = trpc.team.getNotifications.useQuery();
  const markRead = trpc.team.markNotificationRead.useMutation({
    onSuccess: () => utils.team.getNotifications.invalidate(),
  });
  const markAllRead = trpc.team.markAllNotificationsRead.useMutation({
    onSuccess: () => utils.team.getNotifications.invalidate(),
  });

  const unreadCount = notifications?.filter((n) => !n.isRead).length ?? 0;

  return (
    <div className="relative">
      <button
        onClick={() => setOpen(!open)}
        className="relative flex h-9 w-9 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
      >
        <Bell className="h-[18px] w-[18px]" />
        {unreadCount > 0 && (
          <span className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-[#FF4C29] px-1 text-[10px] font-bold text-white">
            {unreadCount}
          </span>
        )}
      </button>

      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="absolute right-0 top-full z-50 mt-2 w-80 rounded-xl border border-border bg-card shadow-2xl shadow-black/10">
            <div className="flex items-center justify-between border-b border-border/60 px-4 py-3">
              <h3 className="text-sm font-semibold text-foreground">Notifications</h3>
              {unreadCount > 0 && (
                <button
                  onClick={() => markAllRead.mutate()}
                  className="flex items-center gap-1 text-[11px] font-medium text-[#FF4C29] hover:underline"
                >
                  <CheckCheck className="h-3 w-3" />
                  Mark all read
                </button>
              )}
            </div>
            <div className="max-h-80 overflow-y-auto">
              {!notifications?.length ? (
                <div className="py-10 text-center">
                  <Bell className="mx-auto h-8 w-8 text-muted-foreground/20" />
                  <p className="mt-2 text-xs text-muted-foreground">No notifications</p>
                </div>
              ) : (
                notifications.slice(0, 10).map((n) => (
                  <button
                    key={n.id}
                    onClick={() => { if (!n.isRead) markRead.mutate({ id: n.id }); }}
                    className={cn(
                      'flex w-full items-start gap-3 px-4 py-3 text-left transition-colors hover:bg-secondary/50 border-b border-border/40 last:border-0',
                      !n.isRead && 'bg-[#FF4C29]/[0.03]'
                    )}
                  >
                    {!n.isRead && <div className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-[#FF4C29]" />}
                    <div className={cn('flex-1 min-w-0', n.isRead && 'ml-5')}>
                      <p className={cn('text-xs', n.isRead ? 'text-muted-foreground' : 'text-foreground font-medium')}>{n.title}</p>
                      <p className="text-[11px] text-muted-foreground mt-0.5 truncate">{n.message}</p>
                      <p className="text-[10px] text-muted-foreground/50 mt-1">
                        {formatDistanceToNow(new Date(n.createdAt), { addSuffix: true })}
                      </p>
                    </div>
                  </button>
                ))
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
