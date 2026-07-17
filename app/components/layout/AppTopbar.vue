<script setup lang="ts">
import {
  Bell,
  BriefcaseBusiness,
  CheckCheck,
  ChevronRight,
  FolderKanban,
  LoaderCircle,
  LogOut,
  Menu,
  Moon,
  Plus,
  Search,
  Sparkles,
  StickyNote,
  Sun,
  User,
  Users,
  X,
} from 'lucide-vue-next';
import type { Component } from 'vue';
import { getVisibleNavigation, routeLabels } from '~/components/layout/navigation';
import type { NotificationItem } from '~/types/collaboration';
import type { SearchGroups } from '~/types/delivery';

interface SearchResult {
  id: string;
  label: string;
  detail: string;
  to: string;
  icon: Component;
  group: string;
}

const emit = defineEmits<{
  'open-menu': [];
}>();

const route = useRoute();
const colorMode = useColorMode();
const { user, logout } = useAuth();
const { open: assistantOpen } = useAssistant();
const { search } = useDelivery();
const collaboration = useCollaboration();
const commandOpen = ref(false);
const commandQuery = ref('');
const commandInput = ref<HTMLInputElement | null>(null);
const searchResults = ref<SearchResult[]>([]);
const searching = ref(false);
const notifications = ref<NotificationItem[]>([]);
const notificationsOpen = ref(false);
const accountOpen = ref(false);
const themeReady = ref(false);
let searchTimer: ReturnType<typeof setTimeout> | undefined;

const visibleNav = computed(() => getVisibleNavigation(user.value?.role));
const breadcrumbs = computed(() => {
  const segments = route.path.split('/').filter(Boolean);
  let path = '';
  return segments.map((segment) => {
    path += `/${segment}`;
    return {
      path,
      label:
        routeLabels[path] ||
        segment.replaceAll('-', ' ').replace(/^./, (char) => char.toUpperCase()),
    };
  });
});
const initials = computed(
  () =>
    user.value?.name
      ?.split(' ')
      .map((part) => part[0])
      .join('')
      .toUpperCase()
      .slice(0, 2) || 'DF'
);
const unreadCount = computed(() => notifications.value.filter((item) => !item.isRead).length);
const isDarkTheme = computed(() => themeReady.value && colorMode.value === 'dark');
const themeToggleLabel = computed(() =>
  !themeReady.value
    ? 'Toggle color theme'
    : isDarkTheme.value
      ? 'Use light theme'
      : 'Use dark theme'
);
const groupedSearchResults = computed(() => {
  const groups = new Map<string, SearchResult[]>();
  for (const result of searchResults.value) {
    const existing = groups.get(result.group) || [];
    existing.push(result);
    groups.set(result.group, existing);
  }
  return [...groups.entries()];
});

function showCommand() {
  commandOpen.value = true;
  accountOpen.value = false;
  notificationsOpen.value = false;
  nextTick(() => commandInput.value?.focus());
}

function hideCommand() {
  commandOpen.value = false;
  commandQuery.value = '';
  searchResults.value = [];
}

function staticSearchResults(): SearchResult[] {
  return visibleNav.value.map((item) => ({
    id: item.to,
    label: item.label,
    detail: item.group,
    to: item.to,
    icon: item.icon,
    group: 'Navigation',
  }));
}

function mapSearchResults(data: SearchGroups): SearchResult[] {
  return [
    ...data.projects.map((item) => ({
      id: `project-${item.id}`,
      label: item.name,
      detail: item.client?.name || item.type,
      to: `/projects/${item.id}`,
      icon: FolderKanban,
      group: 'Projects',
    })),
    ...data.tasks.map((item) => ({
      id: `task-${item.id}`,
      label: item.title,
      detail: item.column?.board?.name || item.priority,
      to: item.column?.board
        ? `/projects/${item.column.board.projectId}/board/${item.column.board.id}`
        : '/projects',
      icon: CheckCheck,
      group: 'Tasks',
    })),
    ...data.clients.map((item) => ({
      id: `client-${item.id}`,
      label: item.name,
      detail: item.industry || 'Client',
      to: `/clients/${item.id}`,
      icon: BriefcaseBusiness,
      group: 'Clients',
    })),
    ...data.notes.map((item) => ({
      id: `note-${item.id}`,
      label: item.title,
      detail: item.author?.name || item.visibility,
      to: `/notes/${item.id}`,
      icon: StickyNote,
      group: 'Notes',
    })),
    ...data.team.map((item) => ({
      id: `team-${item.id}`,
      label: item.name,
      detail: item.title || item.email || 'Team member',
      to: `/team/${item.id}`,
      icon: Users,
      group: 'Team',
    })),
  ];
}

watch(commandQuery, (query) => {
  if (searchTimer) clearTimeout(searchTimer);
  const trimmed = query.trim();
  if (!trimmed) {
    searching.value = false;
    searchResults.value = staticSearchResults();
    return;
  }
  searching.value = true;
  searchTimer = setTimeout(async () => {
    try {
      searchResults.value = mapSearchResults(await search(trimmed));
    } catch {
      searchResults.value = [];
    } finally {
      searching.value = false;
    }
  }, 200);
});

watch(commandOpen, (open) => {
  if (open && !commandQuery.value) searchResults.value = staticSearchResults();
});

watch(
  () => colorMode.value,
  (mode) => {
    if (import.meta.client) document.documentElement.dataset.theme = mode;
  },
  { immediate: true }
);

watch(
  () => route.fullPath,
  () => {
    notificationsOpen.value = false;
    accountOpen.value = false;
  }
);

function handleShortcut(event: KeyboardEvent) {
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
    event.preventDefault();
    commandOpen.value ? hideCommand() : showCommand();
  }
  if (event.key === 'Escape') {
    hideCommand();
    notificationsOpen.value = false;
    accountOpen.value = false;
  }
}

async function goTo(to: string) {
  hideCommand();
  await navigateTo(to);
}

async function loadNotifications() {
  try {
    notifications.value = await collaboration.notifications();
  } catch {
    notifications.value = [];
  }
}

async function readNotification(item: NotificationItem) {
  if (!item.isRead) {
    await collaboration.markRead(item.id);
    item.isRead = true;
  }
}

async function readAllNotifications() {
  await collaboration.markAllRead();
  notifications.value.forEach((item) => (item.isRead = true));
}

function relativeTime(value: string) {
  const seconds = Math.max(1, Math.round((Date.now() - new Date(value).getTime()) / 1000));
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

onMounted(() => {
  themeReady.value = true;
  window.addEventListener('keydown', handleShortcut);
  loadNotifications();
});

onBeforeUnmount(() => {
  window.removeEventListener('keydown', handleShortcut);
  if (searchTimer) clearTimeout(searchTimer);
});
</script>

<template>
  <header
    class="studio-topbar sticky top-0 z-30 flex min-h-[76px] shrink-0 items-center gap-3 border-b border-border-subtle bg-card/94 px-4 backdrop-blur-xl sm:px-6 xl:px-8"
  >
    <button class="studio-icon-button lg:hidden" aria-label="Open menu" @click="emit('open-menu')">
      <Menu :size="20" />
    </button>

    <NuxtLink
      to="/dashboard"
      class="flex shrink-0 items-center gap-3 rounded-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <AppLogo :size="40" />
      <span class="hidden leading-tight sm:block">
        <strong class="block text-sm font-semibold tracking-[-0.03em] text-foreground"
          >DevFathom</strong
        >
        <span class="block text-xs text-muted-foreground">Company workspace</span>
      </span>
    </NuxtLink>

    <span class="hidden h-8 w-px bg-border-subtle md:block" aria-hidden="true" />

    <NuxtLink to="/projects" class="studio-icon-button hidden md:flex" aria-label="Open projects">
      <Plus :size="16" />
    </NuxtLink>

    <div class="hidden min-w-0 md:block">
      <span class="block text-xs font-medium text-foreground">{{ user?.name || 'Workspace' }}</span>
      <span class="block max-w-36 truncate text-[11px] text-muted-foreground">
        {{ user?.title || 'Team member' }}
      </span>
    </div>

    <nav
      aria-label="Breadcrumb"
      class="ml-2 hidden min-w-0 items-center gap-1 overflow-hidden border-l border-border-subtle pl-4 text-xs xl:flex"
    >
      <template v-for="(crumb, index) in breadcrumbs" :key="crumb.path">
        <ChevronRight v-if="index" :size="14" class="shrink-0 text-text-faint" />
        <NuxtLink
          v-if="index < breadcrumbs.length - 1 && routeLabels[crumb.path]"
          :to="crumb.path"
          class="truncate text-text-muted transition-colors hover:text-foreground"
        >
          {{ crumb.label }}
        </NuxtLink>
        <span v-else class="truncate font-medium text-foreground" aria-current="page">
          {{ crumb.label }}
        </span>
      </template>
    </nav>

    <div class="ml-auto flex shrink-0 items-center gap-1.5">
      <button class="studio-search" aria-label="Search company hub" @click="showCommand">
        <Search :size="16" class="shrink-0" />
        <span class="hidden min-w-0 flex-1 truncate whitespace-nowrap text-left lg:block">
          Search workspace
        </span>
        <kbd
          class="pointer-events-none hidden shrink-0 select-none font-mono text-[10px] text-muted-foreground/70 xl:inline-flex"
        >
          ⌘K
        </kbd>
      </button>

      <button
        class="studio-assistant-button"
        aria-label="Open AI assistant"
        @click="assistantOpen = true"
      >
        <Sparkles :size="18" class="text-accent-brand" />
        <span class="hidden text-xs font-semibold lg:inline">Ask Fathom</span>
      </button>

      <button
        class="studio-icon-button hidden sm:flex"
        :aria-label="themeToggleLabel"
        @click="colorMode.preference = colorMode.value === 'dark' ? 'light' : 'dark'"
      >
        <Sun v-if="isDarkTheme" :size="18" />
        <Moon v-else :size="18" />
      </button>

      <div class="relative">
        <button
          class="studio-icon-button relative"
          :aria-label="unreadCount ? `Notifications, ${unreadCount} unread` : 'Notifications'"
          @click="
            notificationsOpen = !notificationsOpen;
            accountOpen = false;
          "
        >
          <Bell :size="18" />
          <span
            v-if="unreadCount"
            class="absolute -right-0.5 -top-0.5 grid min-h-4 min-w-4 place-items-center rounded-full bg-foreground px-1 font-mono text-[9px] text-background ring-2 ring-card"
          >
            {{ unreadCount }}
          </span>
        </button>
        <section
          v-if="notificationsOpen"
          class="studio-popover absolute right-0 top-12 z-50 w-[min(380px,calc(100vw-2rem))] overflow-hidden"
        >
          <header class="flex items-center justify-between border-b border-border-subtle px-4 py-3">
            <div>
              <strong class="block text-sm text-foreground">Notifications</strong>
              <small class="text-[11px] text-text-muted">{{ unreadCount }} unread</small>
            </div>
            <button
              v-if="unreadCount"
              class="flex items-center gap-1.5 text-[11px] font-semibold text-text-muted hover:text-foreground"
              @click="readAllNotifications"
            >
              <CheckCheck :size="14" /> Mark all read
            </button>
          </header>
          <div class="max-h-[420px] overflow-y-auto p-2">
            <button
              v-for="item in notifications.slice(0, 12)"
              :key="item.id"
              class="flex w-full gap-3 rounded-xl px-3 py-3 text-left hover:bg-muted"
              @click="readNotification(item)"
            >
              <span
                class="mt-1.5 h-2 w-2 shrink-0 rounded-full"
                :class="item.isRead ? 'bg-border-default' : 'bg-accent-brand'"
              />
              <span class="min-w-0 flex-1">
                <strong class="block truncate text-xs text-foreground">{{ item.title }}</strong>
                <span class="mt-0.5 block text-[11px] leading-relaxed text-text-muted">{{
                  item.message
                }}</span>
                <small
                  class="mt-1 block font-mono text-[9px] uppercase tracking-wider text-text-faint"
                >
                  {{ relativeTime(item.createdAt) }}
                </small>
              </span>
            </button>
            <p v-if="!notifications.length" class="px-4 py-10 text-center text-xs text-text-muted">
              You’re all caught up.
            </p>
          </div>
        </section>
      </div>

      <div class="relative">
        <button
          class="studio-avatar-button"
          aria-label="Open account menu"
          @click="
            accountOpen = !accountOpen;
            notificationsOpen = false;
          "
        >
          <span
            class="grid h-8 w-8 place-items-center rounded-full bg-primary/10 font-mono text-xs font-medium text-primary"
          >
            {{ initials }}
          </span>
        </button>
        <section v-if="accountOpen" class="studio-popover absolute right-0 top-12 z-50 w-56 p-2">
          <div class="px-3 py-2">
            <strong class="block text-sm text-foreground">{{ user?.name }}</strong>
            <small class="block truncate text-xs text-text-muted">{{ user?.email }}</small>
          </div>
          <div class="my-1 h-px bg-border-subtle" />
          <NuxtLink
            to="/settings"
            class="flex items-center gap-2 rounded-xl px-3 py-2 text-sm text-text-body hover:bg-muted"
          >
            <User :size="16" /> Profile
          </NuxtLink>
          <button
            class="flex w-full items-center gap-2 rounded-xl px-3 py-2 text-sm text-red-600 hover:bg-red-50 dark:hover:bg-red-950/30"
            @click="logout"
          >
            <LogOut :size="16" /> Sign out
          </button>
        </section>
      </div>
    </div>
  </header>

  <Teleport to="body">
    <div v-if="commandOpen" class="studio-command-backdrop" @click.self="hideCommand">
      <section
        class="studio-command-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="Search company hub"
      >
        <header class="flex h-16 items-center gap-3 border-b border-border-subtle px-5">
          <Search :size="19" class="text-text-muted" />
          <input
            ref="commandInput"
            v-model="commandQuery"
            class="min-w-0 flex-1 bg-transparent text-[15px] text-foreground outline-none placeholder:text-text-faint"
            placeholder="Search projects, tasks, clients, notes, team…"
          />
          <button
            class="grid h-8 w-8 place-items-center rounded-full text-text-muted hover:bg-muted"
            aria-label="Close search"
            @click="hideCommand"
          >
            <X :size="17" />
          </button>
        </header>
        <div class="max-h-[min(62vh,520px)] overflow-y-auto p-2">
          <div
            v-if="searching"
            class="flex items-center justify-center gap-2 py-12 text-xs text-text-muted"
          >
            <LoaderCircle :size="16" class="animate-spin" /> Searching…
          </div>
          <template v-else-if="groupedSearchResults.length">
            <section v-for="[group, results] in groupedSearchResults" :key="group" class="py-1">
              <p
                class="px-3 py-2 font-mono text-[9px] font-semibold uppercase tracking-[0.18em] text-text-faint"
              >
                {{ group }}
              </p>
              <button
                v-for="result in results"
                :key="result.id"
                class="studio-command-result"
                @click="goTo(result.to)"
              >
                <span
                  class="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-muted text-accent-brand"
                >
                  <component :is="result.icon" :size="16" />
                </span>
                <span class="min-w-0 flex-1">
                  <strong class="block truncate text-sm">{{ result.label }}</strong>
                  <small class="block truncate text-[11px] text-text-muted">{{
                    result.detail
                  }}</small>
                </span>
              </button>
            </section>
          </template>
          <p v-else class="py-12 text-center text-xs text-text-muted">No results found.</p>
        </div>
        <footer
          class="flex items-center gap-4 border-t border-border-subtle px-5 py-3 font-mono text-[9px] uppercase tracking-wider text-text-faint"
        >
          <span><kbd>↵</kbd> open</span><span><kbd>esc</kbd> close</span>
        </footer>
      </section>
    </div>
  </Teleport>
</template>
