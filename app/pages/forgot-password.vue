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
  >
    <div v-if="sent" class="fieldbook-state">
      <CheckCircle2 :size="24" class="fieldbook-state-icon" />
      <strong>Check your inbox</strong>
      <p>For privacy, the same confirmation is shown for every address.</p>
      <NuxtLink class="fieldbook-primary" to="/login">Return to sign in</NuxtLink>
    </div>

    <form v-else class="fieldbook-stack" @submit.prevent="submit">
      <div class="fieldbook-field">
        <label for="recovery-email">Email address</label>
        <input
          id="recovery-email"
          v-model="email"
          class="fieldbook-input"
          type="email"
          autocomplete="email"
          placeholder="you@company.com"
          required
          autofocus
        />
      </div>
      <p v-if="error" role="alert" class="fieldbook-alert">{{ error }}</p>
      <button class="fieldbook-primary" :disabled="loading">
        {{ loading ? 'Sending…' : 'Send reset link' }}
        <ArrowRight v-if="!loading" :size="16" />
      </button>
      <NuxtLink class="fieldbook-link" to="/login">Return to sign in</NuxtLink>
    </form>
  </AuthFrame>
</template>
