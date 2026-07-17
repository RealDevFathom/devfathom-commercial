<script setup lang="ts">
import AppTopNavigation from '~/components/layout/AppTopNavigation.vue';
import AppTopbar from '~/components/layout/AppTopbar.vue';

const route = useRoute();
const mobileOpen = ref(false);
const immersive = computed(
  () => route.path === '/chat' || /^\/meetings\/[^/]+\/call$/.test(route.path)
);

watch(
  () => route.fullPath,
  () => {
    mobileOpen.value = false;
  }
);
</script>

<template>
  <div class="studio-viewport h-dvh overflow-hidden">
    <AppSidebar :open="mobileOpen" @close="mobileOpen = false" />

    <div class="studio-shell flex h-full min-w-0 flex-1 flex-col overflow-hidden">
      <AppTopbar @open-menu="mobileOpen = true" />
      <AppTopNavigation />

      <main
        data-slot="app-canvas"
        class="studio-canvas relative min-h-0 flex-1 overflow-y-auto scroll-pt-24"
      >
        <div
          class="studio-stage mx-auto w-full"
          :class="
            immersive
              ? 'h-full max-w-none overflow-hidden'
              : 'min-h-full max-w-[1540px] px-4 py-4 sm:px-6 sm:py-6 xl:px-8 xl:pb-8'
          "
        >
          <slot />
        </div>
      </main>
    </div>

    <AssistantPanel />
  </div>
</template>
