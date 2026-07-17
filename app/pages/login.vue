<script setup lang="ts">
import { Eye, EyeOff, LoaderCircle } from 'lucide-vue-next';

definePageMeta({ layout: false });
useHead({ title: 'Sign in · DevFathom', meta: [{ name: 'theme-color', content: '#06090c' }] });

const route = useRoute();
const { login, verifyTwoFactor } = useAuth();
const email = ref('');
const password = ref('');
const loading = ref(false);
const error = ref('');
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
  return typeof value === 'string' && value.startsWith('/') && !value.startsWith('//')
    ? value
    : '/dashboard';
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

async function submit() {
  loading.value = true;
  error.value = '';
  try {
    const response = challenge.value
      ? await verifyTwoFactor(challenge.value, code.value)
      : await login(email.value, password.value);
    if ('two_factor_required' in response) {
      challenge.value = response.challenge_token;
      error.value = 'Enter the 6-digit code from your authenticator app.';
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
  <main class="production-login">
    <section class="login-hero" aria-labelledby="login-heading">
      <div class="login-aurora" aria-hidden="true">
        <div class="login-aurora-one" />
        <div class="login-aurora-two" />
      </div>
      <div class="login-grid" aria-hidden="true" />
      <div class="login-watermark" aria-hidden="true">
        <AppLogo :size="440" variant="white" />
      </div>

      <div class="login-hero-content">
        <header class="login-brand-row">
          <div class="login-wordmark">
            <AppLogo :size="44" variant="white" />
            <span>DevFathom</span>
          </div>
          <span class="login-version">v1.0</span>
        </header>

        <div class="production-login-story">
          <h1 id="login-heading">
            <span>Depth in</span>
            <span>everything</span>
            <span>we build.</span>
          </h1>
          <p>
            Projects, finance, clients, people, and real-time collaboration — one calm workspace for
            the team that designs, builds, and advises.
          </p>
        </div>

        <footer class="login-status">
          <span class="login-status-copy">
            <span class="login-live-dot"><span /></span>
            <span>All systems operational</span>
          </span>
          <span>DevFathom · Company hub</span>
        </footer>
      </div>
    </section>

    <section class="login-form-panel" aria-label="Sign in">
      <div class="login-panel-aurora" aria-hidden="true" />

      <div class="production-login-form-wrap">
        <div class="login-card">
          <div class="login-mobile-brand">
            <AppLogo :size="32" variant="white" />
            <strong>DevFathom</strong>
          </div>

          <header class="login-form-header">
            <h2>Welcome back</h2>
            <p>Sign in to your DevFathom workspace</p>
          </header>

          <div v-if="error" role="alert" class="login-error">{{ error }}</div>

          <form class="production-login-form" @submit.prevent="submit">
            <div class="login-field">
              <label for="email">Email</label>
              <input
                id="email"
                v-model="email"
                type="email"
                autocomplete="email"
                placeholder="you@company.com"
                required
                autofocus
              />
            </div>

            <div v-if="!challenge" class="login-field">
              <div class="login-field-label">
                <label for="password">Password</label>
                <NuxtLink to="/forgot-password">Forgot password?</NuxtLink>
              </div>
              <div class="login-password">
                <input
                  id="password"
                  v-model="password"
                  :type="showPassword ? 'text' : 'password'"
                  autocomplete="current-password"
                  placeholder="Enter your password"
                  required
                />
                <button
                  type="button"
                  :aria-label="showPassword ? 'Hide password' : 'Show password'"
                  tabindex="-1"
                  @click="showPassword = !showPassword"
                >
                  <EyeOff v-if="showPassword" :size="16" />
                  <Eye v-else :size="16" />
                </button>
              </div>
            </div>

            <div v-else class="login-field">
              <label for="totp">Authentication code</label>
              <input
                id="totp"
                ref="codeInput"
                v-model="code"
                type="text"
                inputmode="numeric"
                autocomplete="one-time-code"
                placeholder="123456 or a recovery code"
                required
              />
              <small>Open your authenticator app, or enter one of your recovery codes.</small>
            </div>

            <button class="login-submit" :disabled="loading">
              <LoaderCircle v-if="loading" :size="16" class="animate-spin" />
              {{ loading ? 'Signing in...' : challenge ? 'Verify and sign in' : 'Sign in' }}
            </button>

            <button
              v-if="challenge"
              type="button"
              class="login-another"
              @click="
                challenge = '';
                code = '';
                error = '';
              "
            >
              Use another account
            </button>
          </form>
        </div>

        <p class="login-help">Need access? Contact your workspace admin.</p>
      </div>
    </section>
  </main>
</template>

<style scoped>
.production-login {
  position: relative;
  display: flex;
  min-height: 100vh;
  color: #e6ebee;
  background: #06090c;
  font-family: var(--font-sans);
}

.login-hero {
  position: relative;
  display: none;
  width: 46%;
  min-height: 100vh;
  overflow: hidden;
  border-right: 1px solid rgba(255, 255, 255, 0.05);
}

.login-aurora {
  pointer-events: none;
  position: absolute;
  inset: 0;
}

.login-aurora-one,
.login-aurora-two,
.login-panel-aurora {
  position: absolute;
  border-radius: 999px;
}

.login-aurora-one {
  top: 25%;
  left: -12%;
  width: 24rem;
  height: 24rem;
  background: rgba(18, 58, 56, 0.2);
  filter: blur(130px);
  animation: aurora-one 13s ease-in-out infinite alternate;
}

.login-aurora-two {
  right: -6%;
  bottom: 8%;
  width: 20rem;
  height: 20rem;
  background: rgba(188, 136, 80, 0.12);
  filter: blur(130px);
  animation: aurora-two 16s ease-in-out infinite alternate;
}

.login-grid {
  position: absolute;
  inset: 0;
  opacity: 0.6;
  background-image:
    linear-gradient(rgba(22, 26, 25, 0.04) 1px, transparent 1px),
    linear-gradient(90deg, rgba(22, 26, 25, 0.04) 1px, transparent 1px);
  background-size: 56px 56px;
}

.login-watermark {
  pointer-events: none;
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  opacity: 0.05;
}

.login-hero-content {
  position: relative;
  z-index: 1;
  display: flex;
  width: 100%;
  flex-direction: column;
  justify-content: space-between;
  padding: 48px;
}

.login-brand-row,
.login-wordmark,
.login-status,
.login-status-copy {
  display: flex;
  align-items: center;
}

.login-brand-row {
  justify-content: space-between;
}

.login-wordmark {
  gap: 12px;
}

.login-wordmark span {
  color: white;
  font-family: var(--font-display);
  font-size: 20px;
  font-weight: 600;
  letter-spacing: -0.025em;
}

.login-version {
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 999px;
  padding: 4px 12px;
  color: #8a97a1;
  background: rgba(255, 255, 255, 0.05);
  font-size: 11px;
  font-weight: 500;
}

.production-login-story {
  max-width: 28rem;
}

.production-login-story h1 {
  margin: 0;
  color: white;
  font-family: var(--font-display);
  font-size: 2.7rem;
  font-weight: 700;
  line-height: 1.05;
  letter-spacing: -0.03em;
}

.production-login-story h1 span {
  display: block;
  overflow: hidden;
}

.production-login-story h1 span:last-child {
  color: #bc8850;
}

.production-login-story > p:last-child {
  max-width: 24rem;
  margin: 24px 0 0;
  color: #8a97a1;
  font-size: 16px;
  line-height: 1.625;
}

.login-status {
  gap: 24px;
  color: #5a6670;
  font-size: 14px;
}

.login-status-copy {
  gap: 8px;
}

.login-live-dot {
  position: relative;
  display: flex;
  width: 8px;
  height: 8px;
}

.login-live-dot::before,
.login-live-dot span {
  position: absolute;
  inset: 0;
  border-radius: 999px;
  background: #34d399;
}

.login-live-dot::before {
  content: '';
  animation: status-ping 1s cubic-bezier(0, 0, 0.2, 1) infinite;
  opacity: 0.6;
}

.login-form-panel {
  position: relative;
  display: flex;
  min-height: 100vh;
  flex: 1;
  align-items: center;
  justify-content: center;
  padding: 24px;
  overflow: hidden;
}

.login-panel-aurora {
  pointer-events: none;
  top: -8rem;
  right: 0;
  width: 18rem;
  height: 18rem;
  background: rgba(18, 58, 56, 0.1);
  filter: blur(120px);
}

.production-login-form-wrap {
  position: relative;
  z-index: 1;
  width: 100%;
  max-width: 400px;
}

.login-card {
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 16px;
  padding: 32px;
  background: rgba(255, 255, 255, 0.03);
  box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.4);
  backdrop-filter: blur(24px);
}

.login-mobile-brand {
  display: none;
  align-items: center;
  gap: 10px;
  margin-bottom: 28px;
}

.login-mobile-brand strong {
  color: white;
  font-family: var(--font-display);
  font-size: 16px;
  font-weight: 600;
  letter-spacing: -0.025em;
}

.login-form-header {
  margin-bottom: 28px;
}

.login-form-header h2 {
  margin: 0;
  color: white;
  font-family: var(--font-display);
  font-size: 20px;
  font-weight: 600;
  letter-spacing: -0.025em;
}

.login-form-header p {
  margin: 6px 0 0;
  color: #8a97a1;
  font-size: 14px;
}

.login-error {
  margin-bottom: 20px;
  border: 1px solid rgba(239, 68, 68, 0.2);
  border-radius: 12px;
  padding: 12px 16px;
  color: #f87171;
  background: rgba(239, 68, 68, 0.1);
  font-size: 14px;
}

.production-login-form {
  display: grid;
  gap: 20px;
}

.login-field {
  display: grid;
  gap: 8px;
}

.login-field-label {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.login-field label {
  color: #c2cbd1;
  font-size: 14px;
  font-weight: 500;
}

.login-field-label a {
  color: #8a97a1;
  font-size: 12px;
  font-weight: 500;
  text-underline-offset: 4px;
  transition: color 150ms ease;
}

.login-field-label a:hover {
  color: #bc8850;
  text-decoration: underline;
}

.login-field input {
  width: 100%;
  height: 44px;
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 12px;
  padding: 0 16px;
  color: white;
  background: rgba(255, 255, 255, 0.04);
  outline: none;
  font-size: 14px;
  transition:
    border-color 150ms ease,
    box-shadow 150ms ease;
}

.login-field input::placeholder {
  color: #5a6670;
}

.login-field input:focus {
  border-color: #bc8850;
  box-shadow: 0 0 0 3px rgba(188, 136, 80, 0.3);
}

.login-field small {
  color: #5a6670;
  font-size: 12px;
  font-weight: 400;
}

.login-password {
  position: relative;
  display: block;
}

.login-password input {
  padding-right: 40px;
}

.login-password button {
  position: absolute;
  top: 50%;
  right: 12px;
  color: #5a6670;
  transform: translateY(-50%);
  transition: color 150ms ease;
}

.login-password button:hover {
  color: white;
}

.login-submit {
  display: flex;
  width: 100%;
  height: 44px;
  align-items: center;
  justify-content: center;
  gap: 8px;
  border-radius: 12px;
  color: white;
  background: #123a38;
  font-size: 14px;
  font-weight: 600;
  transition:
    background-color 150ms ease,
    transform 150ms ease,
    opacity 150ms ease;
}

.login-submit:hover {
  background: #0c2e2c;
}

.login-submit:active {
  transform: scale(0.98);
}

.login-submit:disabled {
  pointer-events: none;
  opacity: 0.5;
}

.login-another {
  color: #8a97a1;
  font-size: 12px;
  font-weight: 600;
  transition: color 150ms ease;
}

.login-another:hover {
  color: white;
}

.login-help {
  margin: 24px 0 0;
  color: #5a6670;
  text-align: center;
  font-size: 12px;
}

@media (min-width: 640px) {
  .login-form-panel {
    padding: 32px;
  }
}

@media (min-width: 1024px) {
  .login-hero {
    display: flex;
  }
}

@media (max-width: 1023px) {
  .login-mobile-brand {
    display: flex;
  }
}

@media (min-width: 1280px) {
  .production-login-story h1 {
    font-size: 3.1rem;
  }
}

@media (prefers-reduced-motion: no-preference) {
  .login-wordmark,
  .login-version,
  .production-login-story h1 span,
  .production-login-story p,
  .login-status,
  .production-login-form-wrap {
    animation: login-reveal 700ms cubic-bezier(0.16, 1, 0.3, 1) both;
  }

  .login-version {
    animation-delay: 80ms;
  }

  .production-login-story h1 span:nth-child(1) {
    animation-delay: 120ms;
  }

  .production-login-story h1 span:nth-child(2) {
    animation-delay: 200ms;
  }

  .production-login-story h1 span:nth-child(3) {
    animation-delay: 280ms;
  }

  .production-login-story p {
    animation-delay: 340ms;
  }

  .login-status {
    animation-delay: 400ms;
  }

  .production-login-form-wrap {
    animation-delay: 100ms;
  }
}

@keyframes login-reveal {
  from {
    opacity: 0;
    transform: translateY(14px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}

@keyframes aurora-one {
  to {
    transform: translate(8%, -7%) scale(1.08);
  }
}

@keyframes aurora-two {
  to {
    transform: translate(-7%, 8%) scale(1.06);
  }
}

@keyframes status-ping {
  75%,
  100% {
    opacity: 0;
    transform: scale(2);
  }
}
</style>
