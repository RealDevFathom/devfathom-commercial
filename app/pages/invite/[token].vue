<script setup lang="ts">
import { ArrowRight, CheckCircle2, LoaderCircle } from 'lucide-vue-next';

definePageMeta({ layout: false });
const route = useRoute();
const { request } = useApi();
const token = String(route.params.token);
const invite = ref<{
  name: string;
  email: string;
  title: string;
  department: string;
  role: string;
} | null>(null);
const checking = ref(true);
const password = ref('');
const phone = ref('');
const bio = ref('');
const skills = ref('');
const done = ref(false);
const error = ref('');
const loading = ref(false);

try {
  invite.value = await request(`/api/auth/invitations/${token}`);
} catch (caught: any) {
  error.value = caught?.data?.detail || 'This invitation is unavailable.';
} finally {
  checking.value = false;
}

async function submit() {
  loading.value = true;
  error.value = '';
  try {
    await request('/api/auth/invitations/accept', {
      method: 'POST',
      body: {
        token,
        password: password.value,
        phone: phone.value,
        bio: bio.value || null,
        skills: skills.value
          .split(',')
          .map((value) => value.trim())
          .filter(Boolean),
      },
    });
    done.value = true;
  } catch (caught: any) {
    error.value = caught?.data?.detail || 'The invitation could not be accepted.';
  } finally {
    loading.value = false;
  }
}
</script>

<template>
  <AuthFrame
    eyebrow="Team invitation"
    :title="invite ? `Welcome, ${invite.name}` : 'Accept invitation'"
    :description="
      invite
        ? `${invite.title} · ${invite.department} · ${invite.role}`
        : 'Set up your DevFathom account.'
    "
  >
    <div v-if="checking" class="fieldbook-state" aria-live="polite">
      <LoaderCircle :size="24" class="fieldbook-state-icon animate-spin" />
      <strong>Checking your invitation</strong>
      <p>This will only take a moment.</p>
    </div>

    <div v-else-if="done" class="fieldbook-state">
      <CheckCircle2 :size="24" class="fieldbook-state-icon" />
      <strong>Account activated</strong>
      <p>Your workspace access is ready.</p>
      <NuxtLink class="fieldbook-primary" to="/login">Continue to sign in</NuxtLink>
    </div>

    <form v-else-if="invite" class="fieldbook-stack" @submit.prevent="submit">
      <div class="fieldbook-field">
        <label for="invite-email">Email</label>
        <input
          id="invite-email"
          class="fieldbook-input"
          :value="invite.email"
          type="email"
          disabled
        />
      </div>
      <div class="fieldbook-field">
        <label for="invite-password">Password</label>
        <input
          id="invite-password"
          v-model="password"
          class="fieldbook-input"
          type="password"
          autocomplete="new-password"
          minlength="8"
          required
        />
      </div>
      <div class="fieldbook-field">
        <label for="invite-phone">Phone</label>
        <input
          id="invite-phone"
          v-model="phone"
          class="fieldbook-input"
          type="tel"
          autocomplete="tel"
          required
        />
      </div>
      <div class="fieldbook-field">
        <label for="invite-bio">Short bio</label>
        <textarea id="invite-bio" v-model="bio" class="fieldbook-textarea" rows="3" />
      </div>
      <div class="fieldbook-field">
        <label for="invite-skills">Skills, comma separated</label>
        <input id="invite-skills" v-model="skills" class="fieldbook-input" />
      </div>
      <p v-if="error" role="alert" class="fieldbook-alert">{{ error }}</p>
      <button class="fieldbook-primary" :disabled="loading">
        {{ loading ? 'Activating…' : 'Activate account' }}
        <ArrowRight v-if="!loading" :size="16" />
      </button>
    </form>

    <div v-else class="fieldbook-state">
      <strong>Invitation unavailable</strong>
      <p>{{ error }}</p>
    </div>
  </AuthFrame>
</template>
