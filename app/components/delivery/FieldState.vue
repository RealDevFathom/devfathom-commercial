<script setup lang="ts">
import { AlertTriangle, LoaderCircle } from 'lucide-vue-next';

defineProps<{ loading?: boolean; error?: string; empty?: string; action?: string }>();
const emit = defineEmits<{ action: [] }>();
</script>

<template>
  <div class="field-state" :class="{ error: !!error }" role="status">
    <LoaderCircle v-if="loading" :size="20" class="spinning" />
    <AlertTriangle v-else-if="error" :size="20" />
    <div>
      <strong>{{
        loading ? 'Reading the ledger…' : error ? 'The record could not be read' : empty
      }}</strong>
      <p v-if="error">{{ error }}</p>
    </div>
    <button v-if="action && !loading" type="button" @click="emit('action')">{{ action }}</button>
  </div>
</template>

<style scoped>
.field-state {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 12px;
  min-height: 190px;
  padding: 28px;
  color: var(--muted);
  background: var(--paper);
  border: 1px dashed var(--border);
  text-align: left;
}
.field-state.error {
  color: var(--clay-600);
  border-color: color-mix(in srgb, var(--clay-500) 45%, var(--border));
}
strong {
  display: block;
  color: var(--text);
  font-family: 'Newsreader', serif;
  font-size: 20px;
}
p {
  margin: 3px 0 0;
  font-size: 12px;
}
button {
  margin-left: 12px;
  padding: 8px 11px;
  color: var(--text);
  background: transparent;
  border: 1px solid var(--border);
  cursor: pointer;
}
</style>
