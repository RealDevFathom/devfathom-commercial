<script setup lang="ts">
import { ArrowRight, CheckCircle2 } from 'lucide-vue-next';
definePageMeta({ layout: false });
const route = useRoute();
const { request } = useApi();
const token = String(route.params.token);
useHead({ title: 'Choose password · DevFathom Hub' });
const valid = ref(false);
const checking = ref(true);
const password = ref('');
const confirm = ref('');
const done = ref(false);
const loading = ref(false);
const error = ref('');
try {
  valid.value = (
    await request<{ valid: boolean }>(`/api/auth/password-reset/${token}/validate`)
  ).valid;
} finally {
  checking.value = false;
}
async function submit() {
  error.value = '';
  if (password.value !== confirm.value) {
    error.value = 'Passwords do not match.';
    return;
  }
  loading.value = true;
  try {
    await request('/api/auth/password-reset', {
      method: 'POST',
      body: { token, new_password: password.value },
    });
    done.value = true;
  } catch (caught: any) {
    error.value = caught?.data?.detail || 'This reset could not be completed.';
  } finally {
    loading.value = false;
  }
}
</script>
<template>
  <AuthFrame
    eyebrow="Account recovery"
    title="Choose a new password"
    description="Use at least eight characters with uppercase, lowercase, and a number."
    ><DeliveryFieldState v-if="checking" loading />
    <div v-else-if="!valid" class="state">
      <strong>Link unavailable</strong>
      <p>This reset link is invalid or expired.</p>
      <NuxtLink class="button" to="/forgot-password">Request another</NuxtLink>
    </div>
    <div v-else-if="done" class="state">
      <CheckCircle2 :size="24" /><strong>Password changed</strong
      ><NuxtLink class="button" to="/login">Sign in</NuxtLink>
    </div>
    <form v-else @submit.prevent="submit">
      <label
        >New password<input
          v-model="password"
          type="password"
          autocomplete="new-password"
          required
          minlength="8" /></label
      ><label
        >Confirm password<input
          v-model="confirm"
          type="password"
          autocomplete="new-password"
          required
      /></label>
      <p v-if="error">{{ error }}</p>
      <button class="button" :disabled="loading">
        {{ loading ? 'Saving…' : 'Set password' }}<ArrowRight :size="16" />
      </button></form
  ></AuthFrame>
</template>
<style scoped>
form,
.state {
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
p {
  color: var(--clay-600);
  font-size: 12px;
}
.state strong {
  font:
    600 22px 'Newsreader',
    serif;
}
.state p {
  color: var(--muted);
}
</style>
