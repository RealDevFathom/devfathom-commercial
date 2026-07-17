<script setup lang="ts">
import { Copy, Eye, EyeOff, ShieldAlert, X } from 'lucide-vue-next';
const props = defineProps<{ label: string; secret: string }>();
const emit = defineEmits<{ dismiss: [] }>();
const visible = ref(false);
const copied = ref(false);
async function copy() {
  await navigator.clipboard.writeText(props.secret);
  copied.value = true;
  setTimeout(() => (copied.value = false), 1500);
}
function dismiss() {
  visible.value = false;
  copied.value = false;
  emit('dismiss');
}
</script>
<template>
  <section class="secret" role="alert">
    <ShieldAlert :size="20" />
    <div>
      <strong>{{ label }}</strong>
      <p>This value is shown once. Store it now; it cannot be recovered.</p>
      <code>{{ visible ? secret : '•'.repeat(Math.min(secret.length, 42)) }}</code>
      <div>
        <button @click="visible = !visible">
          <EyeOff v-if="visible" :size="14" /><Eye v-else :size="14" />{{
            visible ? 'Hide' : 'Reveal'
          }}</button
        ><button @click="copy"><Copy :size="14" />{{ copied ? 'Copied' : 'Copy' }}</button>
      </div>
    </div>
    <button class="dismiss" type="button" aria-label="Dismiss and clear secret" @click="dismiss">
      <X :size="15" />
    </button>
  </section>
</template>
<style scoped>
.secret {
  position: relative;
  display: grid;
  grid-template-columns: 24px 1fr;
  gap: 12px;
  padding: 16px;
  color: #6f2818;
  background: var(--clay-100);
  border: 1px solid #e7b7a7;
}
.secret .dismiss {
  position: absolute;
  top: 8px;
  right: 8px;
  display: grid;
  place-items: center;
  width: 28px;
  height: 28px;
  padding: 0;
}
.secret strong {
  font:
    600 17px 'Newsreader',
    serif;
}
.secret p {
  margin: 3px 0 10px;
  font-size: 11px;
}
.secret code {
  display: block;
  overflow-wrap: anywhere;
  white-space: pre-wrap;
  padding: 10px;
  color: var(--text);
  background: var(--paper);
  border: 1px solid var(--border);
  font-size: 11px;
}
.secret div div {
  display: flex;
  gap: 6px;
  margin-top: 8px;
}
.secret button {
  display: flex;
  align-items: center;
  gap: 5px;
  padding: 6px 9px;
  background: var(--paper);
  border: 1px solid var(--border);
  cursor: pointer;
  font-size: 10px;
}
</style>
