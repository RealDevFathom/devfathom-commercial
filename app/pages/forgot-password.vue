<script setup lang="ts">
import { ArrowRight, CheckCircle2 } from 'lucide-vue-next';
definePageMeta({ layout: false });
useHead({ title: 'Reset password · DevFathom Hub' });
const { request } = useApi();
const email = ref('');
const sent = ref(false);
const loading = ref(false);
const error = ref('');
async function submit() {
  loading.value = true;
  error.value = '';
  try {
    await request('/api/auth/password-reset/request', {
      method: 'POST',
      body: { email: email.value },
    });
    sent.value = true;
  } catch (caught: any) {
    error.value = caught?.data?.detail || 'The request could not be completed.';
  } finally {
    loading.value = false;
  }
}
</script>
<template>
  <AuthFrame
    eyebrow="Account recovery"
    title="Reset your password"
    description="We’ll send a time-limited link if the address belongs to an active account."
    ><div v-if="sent" class="success">
      <CheckCircle2 :size="24" /><strong>Check your inbox</strong>
      <p>For privacy, the same confirmation is shown for every address.</p>
      <NuxtLink class="button" to="/login">Return to sign in</NuxtLink>
    </div>
    <form v-else @submit.prevent="submit">
      <label
        >Email address<input v-model="email" type="email" autocomplete="email" required
      /></label>
      <p v-if="error" class="error">{{ error }}</p>
      <button class="button" :disabled="loading">
        {{ loading ? 'Sending…' : 'Send reset link' }}<ArrowRight :size="16" /></button
      ><NuxtLink to="/login">Return to sign in</NuxtLink>
    </form></AuthFrame
  >
</template>
<style scoped>
form,
.success {
  display: grid;
  gap: 16px;
}
label {
  display: grid;
  gap: 6px;
  color: var(--muted);
  font:
    9px 'IBM Plex Mono',
    monospace;
  text-transform: uppercase;
}
input {
  min-height: 44px;
  padding: 0 12px;
  color: var(--text);
  background: var(--paper);
  border: 1px solid var(--border);
}
form > a {
  color: var(--clay-500);
  font-size: 11px;
}
.success strong {
  font:
    600 22px 'Newsreader',
    serif;
}
.success p,
.error {
  color: var(--muted);
  font-size: 12px;
}
.error {
  color: var(--clay-600);
}
</style>
