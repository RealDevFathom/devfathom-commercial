<script setup lang="ts">
import { ArrowRight, CalendarDays, SlidersHorizontal, Sparkles } from 'lucide-vue-next';

defineProps<{
  greeting: string;
  firstName: string;
  date: {
    day: string;
    weekday: string;
    monthYear: string;
  };
  arrangeOpen: boolean;
}>();

const emit = defineEmits<{
  toggleArrange: [];
}>();

const { open: assistantOpen } = useAssistant();

function openAssistant() {
  assistantOpen.value = true;
}
</script>

<template>
  <section class="studio-command-grid" aria-labelledby="dashboard-greeting">
    <div class="studio-date-panel">
      <span class="studio-date-number">{{ date.day }}</span>
      <div>
        <span class="block text-xs font-semibold uppercase tracking-[0.14em] text-text-muted">{{
          date.weekday
        }}</span>
        <span class="mt-1 block text-sm text-foreground">{{ date.monthYear }}</span>
      </div>
      <CalendarDays :size="20" class="ml-auto text-accent-brand" aria-hidden="true" />
    </div>

    <div class="studio-greeting-panel">
      <div class="min-w-0">
        <p class="text-xs font-semibold uppercase tracking-[0.14em] text-accent-brand">
          Your operating view
        </p>
        <h1
          id="dashboard-greeting"
          class="mt-2 text-[clamp(2rem,4.1vw,4.8rem)] font-medium leading-[0.94] tracking-[-0.065em] text-foreground"
        >
          {{ greeting }}, {{ firstName }}.
        </h1>
        <p class="mt-3 max-w-2xl text-sm text-text-muted sm:text-base">
          Delivery signals, open work, and the decisions that need you today.
        </p>
      </div>

      <button type="button" class="studio-prompt-button" @click="openAssistant">
        <span
          class="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-accent-brand text-white"
        >
          <Sparkles :size="16" aria-hidden="true" />
        </span>
        <span class="min-w-0 flex-1 text-left">
          <span class="block text-xs text-text-muted">Need a hand?</span>
          <span class="block truncate text-sm font-semibold text-foreground">
            Ask Fathom anything
          </span>
        </span>
        <ArrowRight :size="16" class="shrink-0 text-text-muted" aria-hidden="true" />
      </button>
    </div>

    <button
      type="button"
      class="studio-customize-button"
      :class="{ 'is-active': arrangeOpen }"
      :aria-expanded="arrangeOpen"
      aria-controls="dashboard-widget-controls"
      @click="emit('toggleArrange')"
    >
      <SlidersHorizontal :size="16" aria-hidden="true" />
      <span>Arrange</span>
    </button>
  </section>
</template>
