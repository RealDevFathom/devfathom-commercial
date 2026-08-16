'use client';

import { useState, useEffect, useCallback, useSyncExternalStore } from 'react';
import dynamic from 'next/dynamic';
import Link from 'next/link';
import Image from 'next/image';
import { usePathname, useRouter } from 'next/navigation';
import { useSession } from 'next-auth/react';
import { signOutEverything } from '@/lib/auth/sign-out';
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
  Sparkles,
  Plus,
} from 'lucide-react';
import { useTheme } from '@/components/theme-provider';
import { cn } from '@/lib/utils';
import { useAssistant } from '@/lib/assistant-store';
import { useBreadcrumbStore } from '@/lib/breadcrumb-store';
import { trpc } from '@/lib/trpc';
import { formatDistanceToNow } from 'date-fns';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { FathomMark } from '@/components/brand/logo';
import type { TenantBrand } from '@/lib/tenant-brand';
// Badge unused after notification refactor
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
// Lazy-load the cmdk-backed command palette so cmdk only loads on first ⌘K.
// All Command* primitives live in the same module (which pulls in cmdk), so
// every one must be dynamic to keep cmdk out of the topbar chunk.
const CommandDialog = dynamic(
  () => import('@/components/ui/command').then((m) => m.CommandDialog),
  { ssr: false }
);
const CommandEmpty = dynamic(() => import('@/components/ui/command').then((m) => m.CommandEmpty));
const CommandGroup = dynamic(() => import('@/components/ui/command').then((m) => m.CommandGroup));
const CommandInput = dynamic(() => import('@/components/ui/command').then((m) => m.CommandInput));
const CommandItem = dynamic(() => import('@/components/ui/command').then((m) => m.CommandItem));
const CommandList = dynamic(() => import('@/components/ui/command').then((m) => m.CommandList));

// Warm the shared cmdk chunk before the first click. The palette stays lazily
// rendered, but opening it no longer has to wait on a cold network request.
const preloadCommandPalette = () => import('@/components/ui/command');

const routeLabels: Record<string, string> = {
  '/dashboard': 'Dashboard',
  '/projects': 'Projects',
  '/projects/import': 'Import',
  '/clients': 'Clients',
  '/notes': 'Notes',
  '/email': 'Email',
  '/finance': 'Finance',
  '/meetings': 'Meetings',
  '/chat': 'Chat',
  '/team': 'Team',
  '/team/stats': 'Insights',
  '/hr': 'HR & Leave',
  '/reviews': 'Reviews',
  '/audit-logs': 'Audit Log',
  '/api-docs': 'API Access',
  '/settings': 'Settings',
};

const linkableDetailRoute = /^\/(projects|clients|notes|team|meetings)\/[^/]+$/;

function isLinkableBreadcrumb(href: string) {
  return href in routeLabels || linkableDetailRoute.test(href);
}

const subscribeToHydration = () => () => {};

export function Topbar({
  onMenuClick,
  brand,
}: {
  onMenuClick?: () => void;
  brand?: TenantBrand;
} = {}) {
  const [commandOpen, setCommandOpen] = useState(false);
  // Mount the lazily-rendered palette once it has first been opened, then keep
  // it mounted so subsequent opens are immediate.
  const [commandLoaded, setCommandLoaded] = useState(false);
  const [searchInput, setSearchInput] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const pathname = usePathname();
  const router = useRouter();
  const { data: session } = useSession();
  const { theme, setTheme } = useTheme();
  const openAssistant = useAssistant((s) => s.setOpen);
  // Detail pages register their loaded entity name here (id segment -> name),
  // so e.g. /team/<id> shows "Saad Ajmal" instead of the raw id.
  const breadcrumbLabels = useBreadcrumbStore((s) => s.labels);
  const mounted = useSyncExternalStore(
    subscribeToHydration,
    () => true,
    () => false
  );

  // Warm the palette once the browser has finished the initial render. Pointer
  // and keyboard intent below also starts this preload for very early opens.
  useEffect(() => {
    const timer = window.setTimeout(() => {
      void preloadCommandPalette();
    }, 250);
    return () => window.clearTimeout(timer);
  }, []);

  // Keep requests controlled without making the interface feel sluggish.
  useEffect(() => {
    const t = window.setTimeout(() => setDebouncedSearch(searchInput.trim()), 100);
    return () => clearTimeout(t);
  }, [searchInput]);

  const handleCommandOpenChange = useCallback((open: boolean) => {
    if (open) {
      void preloadCommandPalette();
      setCommandLoaded(true);
      setCommandOpen(true);
    } else {
      setCommandOpen(false);
      setSearchInput('');
      setDebouncedSearch('');
    }
  }, []);

  const searchQuery = trpc.search.global.useQuery(
    { query: debouncedSearch },
    { enabled: debouncedSearch.length > 0, staleTime: 30_000 }
  );

  const goTo = (href: string) => {
    handleCommandOpenChange(false);
    router.push(href);
  };

  // Cmd+K keyboard shortcut
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.key === 'k' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        handleCommandOpenChange(!commandOpen);
      }
    };
    document.addEventListener('keydown', down);
    return () => document.removeEventListener('keydown', down);
  }, [commandOpen, handleCommandOpenChange]);

  const getBreadcrumbs = useCallback(() => {
    const segments = pathname.split('/').filter(Boolean);
    const crumbs: { label: string; href: string; linkable: boolean }[] = [];

    let path = '';
    for (const segment of segments) {
      path += `/${segment}`;
      const label =
        routeLabels[path] ||
        breadcrumbLabels[segment] ||
        segment.charAt(0).toUpperCase() + segment.slice(1);
      crumbs.push({ label, href: path, linkable: isLinkableBreadcrumb(path) });
    }

    return crumbs;
  }, [pathname, breadcrumbLabels]);

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
      <header className="studio-topbar sticky top-0 z-30 flex min-h-[76px] items-center gap-3 border-b border-border-subtle bg-card/94 px-4 backdrop-blur-xl sm:px-6 xl:px-8">
        {/* Mobile menu button */}
        {onMenuClick && (
          <button
            onClick={onMenuClick}
            className="studio-icon-button lg:hidden"
            aria-label="Open menu"
          >
            <Menu className="h-5 w-5" />
          </button>
        )}

        <Link
          href="/dashboard"
          className="flex shrink-0 items-center gap-3 rounded-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {brand?.markUrl || brand?.logoUrl ? (
            <Image
              src={brand.markUrl ?? brand.logoUrl ?? ''}
              alt=""
              width={40}
              height={40}
              unoptimized
              className="h-10 w-10 rounded-xl object-contain"
            />
          ) : (
            <FathomMark className="h-10 w-10" variant="brand" />
          )}
          <div className="hidden leading-tight sm:block">
            <span className="block text-sm font-semibold tracking-[-0.03em] text-foreground">
              {brand?.displayName ?? 'DevFathom'}
            </span>
            <span className="block text-xs text-muted-foreground">Company workspace</span>
          </div>
        </Link>

        <div className="hidden h-8 w-px bg-border-subtle md:block" />

        <Link
          href="/projects"
          className="studio-icon-button hidden md:flex"
          aria-label="Open projects"
        >
          <Plus className="h-4 w-4" />
        </Link>

        <div className="hidden min-w-0 md:block">
          <span className="block text-xs font-medium text-foreground">
            {session?.user?.name ?? 'Workspace'}
          </span>
          <span className="block max-w-36 truncate text-[11px] text-muted-foreground">
            {session?.user?.title ?? 'Team member'}
          </span>
        </div>

        {/* Breadcrumbs */}
        <nav
          aria-label="Breadcrumb"
          className="ml-2 hidden min-w-0 items-center gap-1 overflow-hidden border-l border-border-subtle pl-4 text-xs xl:flex"
        >
          {breadcrumbs.map((crumb, i) => (
            <div key={crumb.href} className="flex min-w-0 items-center gap-1">
              {i > 0 && <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground/50" />}
              {i === breadcrumbs.length - 1 || !crumb.linkable ? (
                <span
                  className={cn(
                    'truncate',
                    i === breadcrumbs.length - 1
                      ? 'font-medium text-foreground'
                      : 'text-muted-foreground'
                  )}
                  aria-current={i === breadcrumbs.length - 1 ? 'page' : undefined}
                >
                  {crumb.label}
                </span>
              ) : (
                <Link
                  href={crumb.href}
                  className="truncate text-muted-foreground transition-colors hover:text-foreground"
                >
                  {crumb.label}
                </Link>
              )}
            </div>
          ))}
        </nav>

        <div className="ml-auto flex shrink-0 items-center gap-1.5">
          {/* Search */}
          <button
            onClick={() => handleCommandOpenChange(true)}
            onPointerEnter={() => void preloadCommandPalette()}
            onFocus={() => void preloadCommandPalette()}
            className="studio-search"
            aria-label="Search company hub"
          >
            <Search className="h-4 w-4 shrink-0" />
            <span className="hidden min-w-0 flex-1 truncate whitespace-nowrap text-left lg:block">
              Search workspace
            </span>
            <kbd className="pointer-events-none hidden shrink-0 select-none font-mono text-[10px] text-muted-foreground/70 xl:inline-flex">
              ⌘K
            </kbd>
          </button>

          {/* AI assistant */}
          <button
            onClick={() => openAssistant(true)}
            className="studio-assistant-button"
            aria-label="Open AI assistant"
          >
            <Sparkles className="h-[18px] w-[18px] text-accent-brand" />
            <span className="hidden text-xs font-semibold lg:inline">Ask Fathom</span>
          </button>

          {/* Dark mode toggle */}
          {mounted && (
            <button
              onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
              className="studio-icon-button hidden sm:flex"
              aria-label={theme === 'dark' ? 'Use light theme' : 'Use dark theme'}
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
              <DropdownMenuTrigger aria-label="Open account menu" className="studio-avatar-button">
                <Avatar className="h-8 w-8">
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
                <DropdownMenuItem onClick={() => router.push('/settings')}>
                  <User className="mr-2 h-4 w-4" />
                  Profile
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  onClick={() => void signOutEverything()}
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
      {commandLoaded && (
        <CommandDialog
          open={commandOpen}
          onOpenChange={handleCommandOpenChange}
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
            ) : (
              (() => {
                const r = searchQuery.data;
                const empty =
                  !r ||
                  (r.projects.length === 0 &&
                    r.tasks.length === 0 &&
                    r.clients.length === 0 &&
                    r.notes.length === 0 &&
                    r.team.length === 0);
                if (empty)
                  return (
                    <CommandEmpty>No results for &ldquo;{debouncedSearch}&rdquo;.</CommandEmpty>
                  );
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
              })()
            )}
          </CommandList>
        </CommandDialog>
      )}
    </>
  );
}

function NotificationBell() {
  const [open, setOpen] = useState(false);
  const utils = trpc.useUtils();
  const { data: notifications } = trpc.team.getNotifications.useQuery();
  const markRead = trpc.team.markNotificationRead.useMutation({
    // Optimistically flip the single notification to read instead of
    // invalidating (and refetching) the whole notifications list.
    onMutate: async ({ id }) => {
      await utils.team.getNotifications.cancel();
      const prev = utils.team.getNotifications.getData();
      utils.team.getNotifications.setData(undefined, (old) =>
        old?.map((n) => (n.id === id ? { ...n, isRead: true } : n))
      );
      return { prev };
    },
    onError: (_err, _vars, ctx) => {
      if (ctx?.prev) utils.team.getNotifications.setData(undefined, ctx.prev);
    },
  });
  const markAllRead = trpc.team.markAllNotificationsRead.useMutation({
    onSuccess: () => utils.team.getNotifications.invalidate(),
  });

  const unreadCount = notifications?.filter((n) => !n.isRead).length ?? 0;

  return (
    <div className="relative">
      <button
        onClick={() => setOpen(!open)}
        className="relative flex h-9 w-9 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        aria-label={unreadCount > 0 ? `Notifications, ${unreadCount} unread` : 'Notifications'}
        aria-expanded={open}
      >
        <Bell className="h-[18px] w-[18px]" />
        {unreadCount > 0 && (
          <span className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[10px] font-bold text-primary-foreground">
            {unreadCount}
          </span>
        )}
      </button>

      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="absolute right-0 top-full z-50 mt-2 w-[min(20rem,calc(100vw-2rem))] rounded-lg border border-border-default bg-card shadow-lg">
            <div className="flex items-center justify-between border-b border-border/60 px-4 py-3">
              <h3 className="text-sm font-semibold text-foreground">Notifications</h3>
              {unreadCount > 0 && (
                <button
                  onClick={() => markAllRead.mutate()}
                  className="flex items-center gap-1 text-[11px] font-medium text-primary hover:underline"
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
                    onClick={() => {
                      if (!n.isRead) markRead.mutate({ id: n.id });
                    }}
                    className={cn(
                      'flex w-full items-start gap-3 px-4 py-3 text-left transition-colors hover:bg-secondary/50 border-b border-border/40 last:border-0',
                      !n.isRead && 'bg-primary/[0.05]'
                    )}
                  >
                    {!n.isRead && (
                      <div className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-primary" />
                    )}
                    <div className={cn('flex-1 min-w-0', n.isRead && 'ml-5')}>
                      <p
                        className={cn(
                          'text-xs',
                          n.isRead ? 'text-muted-foreground' : 'text-foreground font-medium'
                        )}
                      >
                        {n.title}
                      </p>
                      <p className="text-[11px] text-muted-foreground mt-0.5 truncate">
                        {n.message}
                      </p>
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
