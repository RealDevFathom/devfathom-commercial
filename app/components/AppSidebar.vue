<script setup lang="ts">
import {
  BarChart3,
  Briefcase,
  ChevronLeft,
  ChevronRight,
  ClipboardList,
  DollarSign,
  FolderKanban,
  LayoutDashboard,
  MessageSquare,
  ScrollText,
  Settings,
  StickyNote,
  UserCog,
  Users,
  Video,
} from 'lucide-vue-next';
import type { Component } from 'vue';

defineProps<{
  open?: boolean;
  collapsed?: boolean;
}>();

const emit = defineEmits<{
  close: [];
  'update:collapsed': [value: boolean];
}>();

interface NavItem {
  label: string;
  to: string;
  icon: Component;
  roles?: string[];
}

const route = useRoute();
const { user } = useAuth();

const navigation: NavItem[] = [
  { label: 'Dashboard', to: '/dashboard', icon: LayoutDashboard },
  { label: 'Projects', to: '/projects', icon: FolderKanban },
  { label: 'Clients', to: '/clients', icon: Briefcase },
  { label: 'Notes', to: '/notes', icon: StickyNote },
  { label: 'Finance', to: '/finance', icon: DollarSign, roles: ['ADMIN'] },
  { label: 'Meetings', to: '/meetings', icon: Video },
  { label: 'Chat', to: '/chat', icon: MessageSquare },
  { label: 'Team', to: '/team', icon: Users },
  { label: 'Reviews', to: '/reviews', icon: ClipboardList },
  { label: 'Insights', to: '/team/stats', icon: BarChart3, roles: ['ADMIN'] },
  { label: 'HR', to: '/hr', icon: UserCog, roles: ['ADMIN', 'HR'] },
  { label: 'Audit Log', to: '/audit-logs', icon: ScrollText, roles: ['ADMIN'] },
  { label: 'Settings', to: '/settings', icon: Settings },
];

const visibleNav = computed(() =>
  navigation.filter((item) => !item.roles || item.roles.includes(user.value?.role || 'EMPLOYEE'))
);
const bestMatch = computed(
  () =>
    visibleNav.value
      .filter((item) => route.path === item.to || route.path.startsWith(`${item.to}/`))
      .sort((a, b) => b.to.length - a.to.length)[0]?.to
);
const initials = computed(
  () =>
    user.value?.name
      ?.split(' ')
      .map((part) => part[0])
      .join('')
      .toUpperCase()
      .slice(0, 2) || 'DF'
);
</script>

<template>
  <div
    v-if="open"
    class="fixed inset-0 z-40 bg-black/50 backdrop-blur-sm lg:hidden"
    aria-hidden="true"
    @click="emit('close')"
  />

  <aside
    class="legacy-sidebar fixed inset-y-0 left-0 z-50 flex -translate-x-full flex-col border-r border-[var(--sidebar-border)] bg-[var(--sidebar)] text-[var(--sidebar-foreground)] transition-[width,transform] duration-300 ease-in-out lg:translate-x-0"
    :class="[collapsed ? 'w-16' : 'w-60', open ? 'translate-x-0' : '']"
    role="navigation"
    aria-label="Main navigation"
  >
    <div
      class="flex h-16 shrink-0 items-center border-b border-[var(--sidebar-border)] px-4"
      :class="collapsed ? 'justify-center' : 'gap-3'"
    >
      <AppLogo :size="32" variant="white" />
      <div v-if="!collapsed" class="flex min-w-0 flex-col overflow-hidden">
        <strong
          class="block font-display text-sm font-semibold tracking-tight text-[var(--sidebar-accent-foreground)]"
        >
          DevFathom
        </strong>
        <span
          class="text-[10px] uppercase tracking-[0.18em] text-[color:var(--sidebar-foreground)]/50"
        >
          Company hub
        </span>
      </div>
      <button
        v-if="!collapsed"
        class="ml-auto grid h-8 w-8 place-items-center rounded-lg text-[color:var(--sidebar-foreground)]/70 hover:bg-[var(--sidebar-accent)] lg:hidden"
        aria-label="Close navigation"
        @click="emit('close')"
      >
        ×
      </button>
    </div>

    <nav class="flex-1 space-y-1 overflow-y-auto px-2 py-4">
      <NuxtLink
        v-for="item in visibleNav"
        :key="item.to"
        :to="item.to"
        class="group relative flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-colors duration-150"
        :class="[
          collapsed ? 'justify-center' : '',
          bestMatch === item.to
            ? 'bg-[var(--sidebar-accent)] text-[var(--sidebar-accent-foreground)] shadow-sm'
            : 'text-[var(--sidebar-foreground)] hover:bg-[color:var(--sidebar-accent)]/40 hover:text-[var(--sidebar-accent-foreground)]',
        ]"
        :title="collapsed ? item.label : undefined"
        :aria-current="bestMatch === item.to ? 'page' : undefined"
        @click="emit('close')"
      >
        <component
          :is="item.icon"
          :size="18"
          class="relative z-10 shrink-0 transition-colors"
          :class="
            bestMatch === item.to
              ? 'text-[var(--sidebar-primary)]'
              : 'text-[color:var(--sidebar-foreground)]/60 group-hover:text-[var(--sidebar-foreground)]'
          "
        />
        <span v-if="!collapsed" class="relative z-10 truncate">{{ item.label }}</span>
        <span
          v-if="bestMatch === item.to && !collapsed"
          class="relative z-10 ml-auto h-1.5 w-1.5 rounded-full bg-[var(--sidebar-primary)]"
        />
      </NuxtLink>
    </nav>

    <button
      class="mx-2 mb-2 hidden items-center justify-center rounded-lg p-2 text-[color:var(--sidebar-foreground)]/50 transition-colors hover:bg-[color:var(--sidebar-accent)]/50 hover:text-[var(--sidebar-foreground)] lg:flex"
      :aria-label="collapsed ? 'Expand sidebar' : 'Collapse sidebar'"
      @click="emit('update:collapsed', !collapsed)"
    >
      <ChevronRight v-if="collapsed" :size="16" />
      <ChevronLeft v-else :size="16" />
    </button>

    <div
      class="border-t border-[var(--sidebar-border)] p-3"
      :class="collapsed ? 'flex justify-center' : ''"
    >
      <div class="flex items-center gap-3" :class="collapsed ? 'justify-center' : ''">
        <span
          class="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-[color:var(--sidebar-primary)]/20 text-xs font-medium text-[var(--sidebar-primary)]"
        >
          {{ initials }}
        </span>
        <div v-if="!collapsed" class="flex min-w-0 flex-col overflow-hidden">
          <span class="truncate text-sm font-medium text-[var(--sidebar-accent-foreground)]">{{
            user?.name
          }}</span>
          <span class="truncate text-xs text-[color:var(--sidebar-foreground)]/50">
            {{ user?.title || user?.role }}
          </span>
        </div>
      </div>
    </div>
  </aside>
</template>
