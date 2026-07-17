<script setup lang="ts">
import { getBestNavigationMatch, getVisibleNavigation } from '~/components/layout/navigation';

const route = useRoute();
const { user } = useAuth();

const visibleNav = computed(() => getVisibleNavigation(user.value?.role));
const bestMatch = computed(() => getBestNavigationMatch(route.path, visibleNav.value));
</script>

<template>
  <div class="studio-navigation hidden shrink-0 border-b border-border-subtle bg-card lg:block">
    <nav
      aria-label="Primary navigation"
      class="mx-auto flex h-14 w-full max-w-[1540px] items-center gap-1 overflow-x-auto px-8"
    >
      <NuxtLink
        v-for="(item, index) in visibleNav"
        :key="item.to"
        :to="item.to"
        class="group relative isolate flex h-9 shrink-0 items-center gap-2 rounded-full px-3.5 text-xs font-medium text-text-muted transition-colors hover:bg-muted hover:text-text-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        :class="[
          bestMatch === item.to ? 'text-primary-foreground hover:text-primary-foreground' : '',
          item.group === 'Firm' && visibleNav[index - 1]?.group !== 'Firm' ? 'ml-3' : '',
        ]"
        :aria-current="bestMatch === item.to ? 'page' : undefined"
      >
        <span
          class="font-mono text-[10px] tabular-nums text-text-faint"
          :class="bestMatch === item.to ? 'text-accent-brand' : ''"
        >
          {{ String(index + 1).padStart(2, '0') }}
        </span>
        <span>{{ item.label }}</span>
        <span
          v-if="bestMatch === item.to"
          class="absolute inset-0 -z-10 rounded-full bg-foreground"
          aria-hidden="true"
        />
      </NuxtLink>
    </nav>
  </div>
</template>
