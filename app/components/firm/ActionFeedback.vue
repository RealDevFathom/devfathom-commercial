<script setup lang="ts">
import { AlertCircle, CheckCircle2, LoaderCircle, X } from 'lucide-vue-next';

defineProps<{
  busy?: boolean;
  busyLabel?: string;
  error?: string;
  success?: string;
}>();

defineEmits<{ dismiss: [] }>();
</script>

<template>
  <div
    v-if="busy || error || success"
    class="flex min-h-11 items-start gap-3 rounded-xl border px-4 py-3 text-sm"
    :class="
      error
        ? 'border-red-500/20 bg-red-500/[0.06] text-red-700'
        : success
          ? 'border-emerald-500/20 bg-emerald-500/[0.06] text-emerald-700'
          : 'border-primary/15 bg-primary/[0.04] text-foreground'
    "
    :role="error ? 'alert' : 'status'"
    aria-live="polite"
  >
    <LoaderCircle
      v-if="busy && !error && !success"
      :size="17"
      class="mt-0.5 shrink-0 animate-spin"
    />
    <AlertCircle v-else-if="error" :size="17" class="mt-0.5 shrink-0" />
    <CheckCircle2 v-else :size="17" class="mt-0.5 shrink-0" />
    <p class="min-w-0 flex-1 leading-5">{{ error || success || busyLabel || 'Saving changes…' }}</p>
    <button
      v-if="!busy"
      type="button"
      class="grid size-6 shrink-0 place-items-center rounded-md opacity-60 transition-opacity hover:opacity-100"
      aria-label="Dismiss message"
      @click="$emit('dismiss')"
    >
      <X :size="14" />
    </button>
  </div>
</template>
