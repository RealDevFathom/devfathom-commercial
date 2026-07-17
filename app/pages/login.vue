<script setup lang="ts">
import { Eye, EyeOff, LoaderCircle } from 'lucide-vue-next';

definePageMeta({ layout: false });
useHead({ title: 'Sign in · DevFathom', meta: [{ name: 'theme-color', content: '#f6f6f3' }] });

const route = useRoute();
const { login, verifyTwoFactor } = useAuth();
const email = ref('');
const password = ref('');
const loading = ref(false);
const error = ref('');
const errorKind = ref<'error' | 'hint'>('error');
const challenge = ref('');
const code = ref('');
const showPassword = ref(false);
const codeInput = ref<HTMLInputElement | null>(null);

watch(challenge, async (value) => {
  if (!value) return;
  await nextTick();
  codeInput.value?.focus();
});

function safeDestination(value: unknown) {
  return typeof value === 'string' && /^\/(?![\\/])/.test(value) ? value : '/dashboard';
}

function getErrorMessage(caught: unknown) {
  if (caught && typeof caught === 'object' && 'data' in caught) {
    const detail = (caught as { data?: { detail?: unknown } }).data?.detail;
    if (typeof detail === 'string') return detail;
  }
  return challenge.value
    ? 'That code is incorrect or expired. Try again, or use a recovery code.'
    : 'Invalid email or password. Please try again.';
}

function resetChallenge() {
  challenge.value = '';
  code.value = '';
  error.value = '';
  errorKind.value = 'error';
}

async function submit() {
  loading.value = true;
  error.value = '';
  errorKind.value = 'error';
  try {
    const response = challenge.value
      ? await verifyTwoFactor(challenge.value, code.value)
      : await login(email.value, password.value);
    if ('two_factor_required' in response) {
      challenge.value = response.challenge_token;
      error.value = 'Enter the 6-digit code from your authenticator app.';
      errorKind.value = 'hint';
      return;
    }
    await navigateTo(safeDestination(route.query.next ?? route.query.callbackUrl), {
      replace: true,
    });
  } catch (caught: unknown) {
    error.value = getErrorMessage(caught);
  } finally {
    loading.value = false;
  }
}
</script>

<template>
  <AuthFrame
    eyebrow="Secure workspace access"
    title="Welcome back"
    description="Sign in to pick up the work your team is moving forward."
  >
    <div
      v-if="error"
      role="alert"
      aria-live="polite"
      class="fieldbook-alert"
      :class="{ 'fieldbook-alert--hint': errorKind === 'hint' }"
    >
      {{ error }}
    </div>

    <form class="fieldbook-stack" @submit.prevent="submit">
      <div class="fieldbook-field">
        <label for="email">Email</label>
        <input
          id="email"
          v-model="email"
          class="fieldbook-input"
          type="email"
          autocomplete="email"
          placeholder="you@company.com"
          required
          autofocus
        />
      </div>

      <div v-if="!challenge" class="fieldbook-field">
        <div class="fieldbook-label-row">
          <label for="password">Password</label>
          <NuxtLink class="fieldbook-link" to="/forgot-password">Forgot password?</NuxtLink>
        </div>
        <div class="fieldbook-password">
          <input
            id="password"
            v-model="password"
            class="fieldbook-input"
            :type="showPassword ? 'text' : 'password'"
            autocomplete="current-password"
            placeholder="Enter your password"
            required
          />
          <button
            type="button"
            class="fieldbook-password-toggle"
            :aria-label="showPassword ? 'Hide password' : 'Show password'"
            tabindex="-1"
            @click="showPassword = !showPassword"
          >
            <EyeOff v-if="showPassword" :size="17" />
            <Eye v-else :size="17" />
          </button>
        </div>
      </div>

      <div v-else class="fieldbook-field" data-testid="two-factor-step">
        <label for="totp">Authentication code</label>
        <input
          id="totp"
          ref="codeInput"
          v-model="code"
          class="fieldbook-input"
          type="text"
          inputmode="text"
          autocomplete="one-time-code"
          placeholder="123456 or a recovery code"
          required
        />
        <p class="fieldbook-helper">
          Open your authenticator app, or enter one of your recovery codes.
        </p>
      </div>

      <button class="fieldbook-primary" :disabled="loading">
        <LoaderCircle v-if="loading" :size="16" class="animate-spin" />
        {{ loading ? 'Signing in...' : challenge ? 'Verify and sign in' : 'Sign in' }}
      </button>

      <button v-if="challenge" type="button" class="fieldbook-secondary" @click="resetChallenge">
        Use another account
      </button>
    </form>

    <template #footer>Need access? Contact your workspace admin.</template>
  </AuthFrame>
</template>
