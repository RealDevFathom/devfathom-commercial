<script setup lang="ts">
import { X } from 'lucide-vue-next';
import {
  getBestNavigationMatch,
  getVisibleNavigation,
  navigationGroups,
} from '~/components/layout/navigation';

const props = defineProps<{
  open?: boolean;
}>();

const emit = defineEmits<{
  close: [];
}>();

const route = useRoute();
const { user } = useAuth();

const visibleNav = computed(() => getVisibleNavigation(user.value?.role));
const bestMatch = computed(() => getBestNavigationMatch(route.path, visibleNav.value));
const initials = computed(
  () =>
    user.value?.name
      ?.split(' ')
      .map((part) => part[0])
      .join('')
      .toUpperCase()
      .slice(0, 2) || 'DF'
);

function itemsForGroup(group: (typeof navigationGroups)[number]) {
  return visibleNav.value.filter((item) => item.group === group);
}

function itemNumber(to: string) {
  return String(visibleNav.value.findIndex((item) => item.to === to) + 1).padStart(2, '0');
}
</script>

<template>
  <button
    v-if="props.open"
    class="fixed inset-0 z-40 bg-black/50 backdrop-blur-sm lg:hidden"
    aria-label="Close navigation"
    @click="emit('close')"
  />

  <aside
    class="studio-drawer fixed inset-y-0 left-0 z-50 flex w-[min(20rem,88vw)] -translate-x-full flex-col border-r border-sidebar-border bg-sidebar text-sidebar-foreground shadow-2xl transition-transform duration-300 ease-out lg:hidden"
    :class="props.open ? 'translate-x-0' : ''"
    :aria-hidden="props.open ? undefined : true"
    :inert="props.open ? undefined : true"
    role="navigation"
    aria-label="Main navigation"
  >
    <div class="flex h-20 shrink-0 items-center gap-3 border-b border-sidebar-border px-5">
      <AppLogo :size="36" />
      <div class="flex min-w-0 flex-col overflow-hidden leading-tight">
        <strong
          class="truncate text-[15px] font-semibold tracking-[-0.025em] text-sidebar-accent-foreground"
        >
          DevFathom
        </strong>
        <span
          class="truncate font-mono text-[9px] uppercase tracking-[0.2em] text-sidebar-foreground/55"
        >
          Company workspace
        </span>
      </div>
      <button
        class="studio-icon-button ml-auto"
        aria-label="Close navigation"
        @click="emit('close')"
      >
        <X :size="18" />
      </button>
    </div>

    <nav class="flex-1 space-y-6 overflow-y-auto px-3 py-5">
      <section v-for="group in navigationGroups" :key="group" class="space-y-1">
        <p
          class="px-2 pb-2 font-mono text-[9px] font-semibold uppercase tracking-[0.2em] text-sidebar-foreground/45"
        >
          Runbook / {{ group }}
        </p>
        <NuxtLink
          v-for="item in itemsForGroup(group)"
          :key="item.to"
          :to="item.to"
          class="group relative flex min-h-11 items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium transition-colors duration-150"
          :class="
            bestMatch === item.to
              ? 'bg-foreground text-primary-foreground'
              : 'text-sidebar-foreground hover:bg-muted hover:text-sidebar-accent-foreground'
          "
          :aria-current="bestMatch === item.to ? 'page' : undefined"
          @click="emit('close')"
        >
          <span
            class="relative z-10 w-5 shrink-0 text-center font-mono text-[10px] tabular-nums"
            :class="bestMatch === item.to ? 'text-accent-brand' : 'text-sidebar-foreground/45'"
          >
            {{ itemNumber(item.to) }}
          </span>
          <span class="relative z-10 truncate">{{ item.label }}</span>
        </NuxtLink>
      </section>
    </nav>

    <div class="border-t border-sidebar-border p-4">
      <div class="flex items-center gap-3">
        <span
          class="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-primary/10 font-mono text-xs font-medium text-primary"
        >
          {{ initials }}
        </span>
        <div class="flex min-w-0 flex-col overflow-hidden">
          <span class="truncate text-sm font-medium text-sidebar-accent-foreground">{{
            user?.name
          }}</span>
          <span class="truncate font-mono text-[11px] text-sidebar-foreground/50">
            {{ user?.title || user?.role }}
          </span>
        </div>
      </div>
    </div>
  </aside>
</template>
