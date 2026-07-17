<script setup lang="ts">
defineProps<{ eyebrow?: string; title: string; description?: string }>();
</script>

<template>
  <header
    data-slot="page-header"
    class="fieldbook-page-header mb-10 flex flex-col gap-5 border-b border-border-default pb-7 sm:flex-row sm:items-start sm:justify-between"
  >
    <div class="flex min-w-0 items-stretch gap-4 sm:gap-5">
      <span aria-hidden="true" class="fieldbook-page-marker mt-1 shrink-0" />
      <div class="min-w-0 space-y-2">
        <p
          v-if="eyebrow"
          class="font-mono text-[10px] font-semibold uppercase tracking-[0.18em] text-accent-brand"
        >
          {{ eyebrow }}
        </p>
        <h1
          class="font-display text-[clamp(2.1rem,4vw,3.15rem)] font-semibold leading-[0.98] tracking-[-0.045em] text-text-strong"
        >
          {{ title }}
        </h1>
        <p v-if="description" class="max-w-2xl text-[0.9375rem] leading-relaxed text-text-muted">
          {{ description }}
        </p>
      </div>
    </div>
    <div class="page-actions flex shrink-0 flex-wrap items-center gap-2 sm:justify-end">
      <slot />
    </div>
  </header>
</template>
