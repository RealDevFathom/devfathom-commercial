<script setup lang="ts">
import { ArrowRight, CheckCircle2, LoaderCircle } from 'lucide-vue-next';

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
  >
    <div v-if="checking" class="fieldbook-state" aria-live="polite">
      <LoaderCircle :size="24" class="fieldbook-state-icon animate-spin" />
      <strong>Checking your link</strong>
      <p>This will only take a moment.</p>
    </div>

    <div v-else-if="!valid" class="fieldbook-state">
      <strong>Link unavailable</strong>
      <p>This reset link is invalid or expired.</p>
      <NuxtLink class="fieldbook-primary" to="/forgot-password">Request another</NuxtLink>
    </div>

    <div v-else-if="done" class="fieldbook-state">
      <CheckCircle2 :size="24" class="fieldbook-state-icon" />
      <strong>Password changed</strong>
      <p>Your new password is ready to use.</p>
      <NuxtLink class="fieldbook-primary" to="/login">Sign in</NuxtLink>
    </div>

    <form v-else class="fieldbook-stack" @submit.prevent="submit">
      <div class="fieldbook-field">
        <label for="new-password">New password</label>
        <input
          id="new-password"
          v-model="password"
          class="fieldbook-input"
          type="password"
          autocomplete="new-password"
          required
          minlength="8"
          autofocus
        />
      </div>
      <div class="fieldbook-field">
        <label for="confirm-password">Confirm password</label>
        <input
          id="confirm-password"
          v-model="confirm"
          class="fieldbook-input"
          type="password"
          autocomplete="new-password"
          required
        />
      </div>
      <p v-if="error" role="alert" class="fieldbook-alert">{{ error }}</p>
      <button class="fieldbook-primary" :disabled="loading">
        {{ loading ? 'Saving…' : 'Set password' }}
        <ArrowRight v-if="!loading" :size="16" />
      </button>
    </form>
  </AuthFrame>
</template>
