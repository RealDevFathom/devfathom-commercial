<script setup lang="ts">
import type { Component } from 'vue';

const props = defineProps<{
  card: {
    title: string;
    value: string;
    change?: string;
    changeLabel?: string;
    icon: Component;
    trend?: 'up' | 'down' | 'neutral';
  };
}>();

const delta = computed(() => {
  if (props.card.trend === 'up') return { glyph: '\u2191', color: 'text-emerald-600' };
  if (props.card.trend === 'down') return { glyph: '\u2193', color: 'text-red-500' };
  return { glyph: '\u2212', color: 'text-text-muted' };
});
</script>

<template>
  <article class="studio-kpi-card bg-card p-5 sm:p-6">
    <span class="studio-kpi-icon">
      <component :is="card.icon" :size="16" aria-hidden="true" />
    </span>
    <div class="space-y-2 pr-8" data-slot="stat">
      <div class="eyebrow">{{ card.title }}</div>
      <div class="stat-figure break-words text-[clamp(1.5rem,7vw,2rem)]">
        {{ card.value }}
      </div>
      <div
        v-if="card.change"
        class="flex items-center gap-1 font-mono text-xs tabular-nums"
        :class="delta.color"
      >
        <span aria-hidden="true" class="text-[0.625rem] leading-none">{{ delta.glyph }}</span>
        <span>{{ card.change }}</span>
      </div>
      <div v-if="card.changeLabel" class="text-xs text-text-muted">{{ card.changeLabel }}</div>
    </div>
  </article>
</template>
