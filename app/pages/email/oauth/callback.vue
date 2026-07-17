<script setup lang="ts">
import { AlertTriangle, CheckCircle2, LoaderCircle } from 'lucide-vue-next';
definePageMeta({ layout: false });
useHead({ title: 'Connect mailbox · DevFathom Hub' });
const route = useRoute();
const status = ref('Finishing your secure mailbox connection…');
const error = ref(false);
const done = computed(() => !error.value && status.value.startsWith('Mailbox connected'));

onMounted(async () => {
  const code = typeof route.query.code === 'string' ? route.query.code : '';
  const state = typeof route.query.state === 'string' ? route.query.state : '';
  const providerError = typeof route.query.error === 'string' ? route.query.error : '';
  try {
    if (providerError) throw new Error('The provider declined the connection.');
    if (!code || !state) throw new Error('The provider response is incomplete.');
    await useEmail().callback(code, state);
    status.value = 'Mailbox connected. You can close this window.';
    window.opener?.postMessage({ type: 'devfathom-mailbox-connected' }, window.location.origin);
    window.setTimeout(() => window.close(), 700);
  } catch (caught: any) {
    error.value = true;
    status.value = caught?.data?.detail || caught?.message || 'Mailbox connection failed.';
  }
});
</script>

<template>
  <main class="callback-page">
    <section>
      <span v-if="error" class="status-icon error"><AlertTriangle :size="20" /></span>
      <span v-else-if="done" class="status-icon done"><CheckCircle2 :size="20" /></span>
      <span v-else class="status-icon working"><LoaderCircle :size="20" /></span>
      <h1>{{ error ? 'Couldn’t connect' : done ? 'Connected' : 'Connecting…' }}</h1>
      <p>
        {{
          error
            ? status
            : done
              ? 'You can close this window.'
              : 'Hang tight, this only takes a moment.'
        }}
      </p>
      <NuxtLink v-if="error" to="/email">Close</NuxtLink>
    </section>
  </main>
</template>

<style scoped>
.callback-page {
  min-height: 100vh;
  display: grid;
  place-items: center;
  padding: 24px;
  background: var(--background);
}
section {
  width: min(384px, 100%);
  padding: 32px;
  text-align: center;
  background: var(--card);
  border: 1px solid var(--border);
  border-radius: 16px;
  box-shadow: 0 2px 12px rgba(0, 0, 0, 0.05);
}
.status-icon {
  display: grid;
  width: 44px;
  height: 44px;
  place-items: center;
  margin: 0 auto;
  border-radius: 50%;
}
.status-icon.error {
  color: var(--color-danger, #c03b2d);
  background: color-mix(in srgb, var(--color-danger, #c03b2d) 10%, transparent);
}
.status-icon.done {
  color: #059669;
  background: color-mix(in srgb, #10b981 10%, transparent);
}
.status-icon.working {
  color: var(--primary);
  background: color-mix(in srgb, var(--primary) 10%, transparent);
}
.status-icon.working svg {
  animation: spin 1s linear infinite;
}
h1 {
  margin: 12px 0 0;
  font-size: 16px;
  font-weight: 600;
}
p {
  margin: 4px 0 0;
  color: var(--text-muted);
  font-size: 14px;
  line-height: 1.5;
}
a {
  display: inline-flex;
  margin-top: 20px;
  padding: 8px 16px;
  color: var(--foreground);
  border: 1px solid var(--border);
  border-radius: 8px;
  font-size: 14px;
  text-decoration: none;
}
@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}
</style>
