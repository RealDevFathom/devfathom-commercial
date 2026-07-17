<script setup lang="ts">
import { X } from 'lucide-vue-next';

const props = defineProps<{
  open: boolean;
  title: string;
  description?: string;
  wide?: boolean;
}>();
const emit = defineEmits<{ close: [] }>();
const dialog = ref<HTMLElement | null>(null);

function onKeydown(event: KeyboardEvent) {
  if (props.open && event.key === 'Escape') emit('close');
}

watch(
  () => props.open,
  async (open) => {
    if (!open) return;
    await nextTick();
    dialog.value?.querySelector<HTMLElement>('input, select, textarea, button')?.focus();
  }
);
onMounted(() => window.addEventListener('keydown', onKeydown));
onBeforeUnmount(() => window.removeEventListener('keydown', onKeydown));
</script>

<template>
  <Teleport to="body">
    <div v-if="open" class="dialog-layer" role="presentation" @mousedown.self="emit('close')">
      <section
        ref="dialog"
        class="field-dialog"
        :class="{ wide }"
        role="dialog"
        aria-modal="true"
        :aria-label="title"
      >
        <header>
          <div>
            <h2>{{ title }}</h2>
            <p v-if="description">{{ description }}</p>
          </div>
          <button class="close" type="button" aria-label="Close" @click="emit('close')">
            <X :size="18" />
          </button>
        </header>
        <div class="dialog-body"><slot /></div>
      </section>
    </div>
  </Teleport>
</template>

<style scoped>
.dialog-layer {
  position: fixed;
  inset: 0;
  z-index: 80;
  display: grid;
  place-items: center;
  padding: 16px;
  background: rgb(0 0 0 / 40%);
  backdrop-filter: blur(4px);
}
.field-dialog {
  width: min(560px, 100%);
  max-height: min(88vh, 920px);
  overflow: auto;
  border: 1px solid var(--border-default);
  border-radius: 16px;
  color: var(--foreground);
  background: var(--background);
  box-shadow: 0 25px 60px rgb(0 0 0 / 22%);
}
.field-dialog.wide {
  width: min(980px, 100%);
}
header {
  position: sticky;
  top: 0;
  z-index: 2;
  display: flex;
  justify-content: space-between;
  gap: 24px;
  padding: 16px 24px;
  background: color-mix(in srgb, var(--background) 92%, transparent);
  border-bottom: 1px solid var(--border-subtle);
  backdrop-filter: blur(16px);
}
h2 {
  margin: 0 0 3px;
  font-size: 18px;
  font-weight: 700;
  letter-spacing: -0.02em;
}
header p:not(.folio) {
  margin: 0;
  color: var(--text-muted);
  font-size: 12px;
}
.close {
  display: grid;
  place-items: center;
  width: 34px;
  height: 34px;
  color: var(--text-muted);
  background: transparent;
  border: 0;
  border-radius: 8px;
  cursor: pointer;
}
.close:focus-visible {
  outline: 3px solid color-mix(in srgb, var(--primary) 25%, transparent);
  outline-offset: 2px;
}
.dialog-body {
  padding: 24px;
}
@media (max-width: 640px) {
  .dialog-layer {
    align-items: end;
    padding: 0;
  }
  .field-dialog {
    width: 100%;
    max-height: 94vh;
  }
}
</style>
