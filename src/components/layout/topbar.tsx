'use client';

import { useState, useEffect, useCallback, useSyncExternalStore } from 'react';
import dynamic from 'next/dynamic';
import Link from 'next/link';
import Image from 'next/image';
import { useRouter } from 'next/navigation';
import { useSession } from 'next-auth/react';
import { signOutEverything } from '@/lib/auth/sign-out';
import {
  Search,
  Bell,
  Moon,
  Sun,
  LogOut,
  User,
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
  Repeat2,
} from 'lucide-react';
import { useTheme } from '@/components/theme-provider';
import { useEntitlements } from '@/components/entitlements-provider';
import { isModuleGranted, moduleForProcedure } from '@/lib/module-catalog';
import { cn } from '@/lib/utils';
import { isAssistantAvailable, useAssistant } from '@/lib/assistant-store';
import { trpc } from '@/lib/trpc';
import { formatDistanceToNow } from 'date-fns';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { FathomMark } from '@/components/brand/logo';
import type { TenantBrand } from '@/lib/tenant-brand';
import { TopbarBreadcrumbs } from './topbar-breadcrumbs';
import { useVisibleNavigation } from './sidebar';
import { useAccountRole } from '@/components/use-account-role';
import type { OrganizationVertical } from '@/lib/vertical-catalog';
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
  const router = useRouter();
  const { data: session } = useSession();
  const { vertical } = useEntitlements();
  const accountRole = useAccountRole();
  const { theme, setTheme } = useTheme();
  const openAssistant = useAssistant((s) => s.setOpen);
  const assistantAvailable = useAssistant((state) =>
    isAssistantAvailable(state, session?.user.organizationId)
  );
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
          <span className="sr-only">Open dashboard</span>
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
            {headerRoleLine(vertical, accountRole.role, session?.user?.title)}
          </span>
        </div>

        {/* Breadcrumbs */}
        <nav
          aria-label="Breadcrumb"
          className="ml-2 hidden min-w-0 items-center gap-1 overflow-hidden border-l border-border-subtle pl-4 text-xs xl:flex"
        >
          <TopbarBreadcrumbs />
        </nav>

        <div className="ml-auto flex shrink-0 items-center gap-1.5">
          {/* Search */}
          <button
            onClick={() => handleCommandOpenChange(true)}
            onPointerEnter={() => void preloadCommandPalette()}
            onFocus={() => void preloadCommandPalette()}
            className="studio-search"
          >
            <Search className="h-4 w-4 shrink-0" />
            <span className="sr-only min-w-0 flex-1 truncate whitespace-nowrap text-left lg:not-sr-only">
              Search workspace
            </span>
            <kbd className="pointer-events-none hidden shrink-0 select-none font-mono text-[10px] text-text-body xl:inline-flex">
              ⌘K
            </kbd>
          </button>

          {/* AI assistant */}
          {assistantAvailable && (
            <>
              <button
                type="button"
                onClick={() => openAssistant(true)}
                title="Open Ask Fathom chat"
                className="studio-assistant-button disabled:cursor-not-allowed disabled:opacity-50 disabled:transform-none motion-reduce:transform-none motion-reduce:transition-none"
                aria-label="Open Ask Fathom assistant"
              >
                <Sparkles className="h-[18px] w-[18px] text-accent-brand" />
                <span className="hidden text-xs font-semibold lg:inline">Ask Fathom</span>
              </button>
            </>
          )}

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
              <DropdownMenuTrigger className="studio-avatar-button">
                <span className="sr-only">Open account menu for {session.user.name}</span>
                <Avatar aria-hidden="true" className="h-8 w-8">
                  <AvatarImage src={session.user.image ?? undefined} alt={session.user.name} />
                  <AvatarFallback className="bg-muted text-foreground text-xs font-medium">
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
                <DropdownMenuItem onClick={() => void signOutEverything('/login')}>
                  <Repeat2 className="mr-2 h-4 w-4" />
                  Switch organization
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
            placeholder={commandPlaceholder(vertical)}
            value={searchInput}
            onValueChange={setSearchInput}
          />
          <CommandList>
            {debouncedSearch.length === 0 ? (
              <PaletteNavigation onSelect={goTo} />
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
                    <>
                      {/* cmdk hides the empty state when a matching screen renders. */}
                      <PaletteNavigation onSelect={goTo} query={debouncedSearch} />
                      <CommandEmpty>No results for &ldquo;{debouncedSearch}&rdquo;.</CommandEmpty>
                    </>
                  );
                return (
                  <>
                    <PaletteNavigation onSelect={goTo} query={debouncedSearch} />
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

/** Command palette prompt in the tenant's own vocabulary. */
export function commandPlaceholder(vertical: OrganizationVertical | null | undefined): string {
  if (vertical === 'PHARMACY') return 'Search pharmacy screens, team…';
  return 'Search projects, tasks, clients, notes, team…';
}

/**
 * The header's second line. Pharmacy shows the member's actual role (the
 * same label as Settings → Account); other verticals keep the job title.
 */
export function headerRoleLine(
  vertical: OrganizationVertical | null | undefined,
  role: string,
  title: string | null | undefined
): string {
  if (vertical === 'PHARMACY') return role || 'Team member';
  return title ?? 'Team member';
}

/**
 * Palette shortcuts come from the same filtered navigation as the rail and
 * top bar, so another vertical's screens or a disabled module never appear.
 */
export function PaletteNavigation({
  onSelect,
  query = '',
}: {
  onSelect: (href: string) => void;
  /** When set, only screens whose label contains it are listed. */
  query?: string;
}) {
  const { filteredNav } = useVisibleNavigation();
  const needle = query.trim().toLowerCase();
  const items = needle
    ? filteredNav.filter((item) => item.label.toLowerCase().includes(needle))
    : filteredNav;
  if (items.length === 0) return null;
  return (
    <CommandGroup heading={needle ? 'Screens' : 'Navigation'}>
      {items.map((item) => (
        <CommandItem key={item.href} value={item.href} onSelect={() => onSelect(item.href)}>
          {item.label}
        </CommandItem>
      ))}
    </CommandGroup>
  );
}

type BellNotification = {
  id: string;
  title: string;
  message: string | null;
  createdAt: Date | string;
  isRead: boolean;
};

export function NotificationBell() {
  const { vertical } = useEntitlements();

  return vertical === 'RESTAURANT' ? <RestaurantNotificationBell /> : <AgencyNotificationBell />;
}

/**
 * WHA-1207 — `team.getNotifications` lives under the `hr` module (see
 * PROCEDURE_MODULES), so a package that does not license `hr` — every pharmacy
 * package — answers FORBIDDEN. Derive the key from the same catalog the server
 * gates on rather than repeating the string, so the two cannot drift.
 */
const TEAM_NOTIFICATIONS_MODULE = moduleForProcedure('team.getNotifications');

function AgencyNotificationBell() {
  const utils = trpc.useUtils();
  const { enabledModules } = useEntitlements();
  // The 403 is definitive (UX rule 17): don't turn it into a poll. Gate the
  // query on the licence the server checks, so an unlicensed workspace never
  // issues the call at all — not even the one request `retryQuery` would allow.
  const licensed =
    !TEAM_NOTIFICATIONS_MODULE || isModuleGranted(TEAM_NOTIFICATIONS_MODULE, enabledModules);
  const { data: notifications, error } = trpc.team.getNotifications.useQuery(undefined, {
    enabled: licensed,
  });
  // Belt and braces: if the resolved entitlements ever disagree with the
  // server's verdict, honour the server's denial rather than showing a bare
  // empty bell over an error.
  const denied = !licensed || error?.data?.code === 'FORBIDDEN';
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

  return (
    <NotificationBellView
      notifications={denied ? [] : (notifications ?? [])}
      emptyMessage={denied ? 'Notifications are not part of this workspace’s plan' : undefined}
      emptyDetail={denied ? 'Ask your platform administrator to enable the HR module.' : undefined}
      onMarkRead={(id) => markRead.mutate({ id })}
      onMarkAllRead={() => markAllRead.mutate()}
    />
  );
}

const restaurantNotificationInput = { limit: 50, unreadOnly: false } as const;

function RestaurantNotificationBell() {
  const utils = trpc.useUtils();
  const { data, error } = trpc.restaurantNotifications.list.useQuery(restaurantNotificationInput);
  // WHA-1181: the poll is denied outright until the signed-in user is linked to
  // a restaurant staff profile. `retryQuery` already stops the retry storm, so
  // all that is left is to say so once instead of showing a bare empty bell.
  const denied = error?.data?.code === 'FORBIDDEN';
  const markRead = trpc.restaurantNotifications.markRead.useMutation({
    onSuccess: () => utils.restaurantNotifications.list.invalidate(restaurantNotificationInput),
  });
  const markAllRead = trpc.restaurantNotifications.markAllRead.useMutation({
    onSuccess: () => utils.restaurantNotifications.list.invalidate(restaurantNotificationInput),
  });
  const notifications =
    data?.items.map((notification) => ({
      id: notification.id,
      title: notification.title,
      message: notification.body,
      createdAt: notification.createdAt,
      isRead: notification.isRead,
    })) ?? [];

  return (
    <NotificationBellView
      notifications={denied ? [] : notifications}
      emptyMessage={denied ? 'Notifications need a restaurant staff profile' : undefined}
      emptyDetail={denied ? 'Ask an administrator to link your account to staff.' : undefined}
      onMarkRead={(id) => markRead.mutate({ id })}
      onMarkAllRead={() => markAllRead.mutate({})}
    />
  );
}

function NotificationBellView({
  notifications,
  emptyMessage = 'No notifications',
  emptyDetail,
  onMarkRead,
  onMarkAllRead,
}: {
  notifications: BellNotification[];
  emptyMessage?: string;
  /** The next step to offer when the empty state is a denial, not an empty inbox. */
  emptyDetail?: string;
  onMarkRead: (id: string) => void;
  onMarkAllRead: () => void;
}) {
  const [open, setOpen] = useState(false);
  const unreadCount = notifications.filter((notification) => !notification.isRead).length;

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
                  onClick={onMarkAllRead}
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
                  <p className="mt-2 text-xs text-muted-foreground">{emptyMessage}</p>
                  {emptyDetail && (
                    <p className="mx-auto mt-1 max-w-[15rem] text-[11px] text-muted-foreground/70">
                      {emptyDetail}
                    </p>
                  )}
                </div>
              ) : (
                notifications.slice(0, 10).map((n) => (
                  <button
                    key={n.id}
                    onClick={() => {
                      if (!n.isRead) onMarkRead(n.id);
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
