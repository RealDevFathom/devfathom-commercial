<script setup lang="ts">
import { ArrowRight, CheckCircle2 } from 'lucide-vue-next';
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
          .map((v) => v.trim())
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
    ><DeliveryFieldState v-if="checking" loading />
    <div v-else-if="done" class="done">
      <CheckCircle2 :size="24" /><strong>Account activated</strong
      ><NuxtLink class="button" to="/login">Continue to sign in</NuxtLink>
    </div>
    <form v-else-if="invite" @submit.prevent="submit">
      <label>Email<input :value="invite.email" disabled /></label
      ><label
        >Password<input
          v-model="password"
          type="password"
          autocomplete="new-password"
          minlength="8"
          required /></label
      ><label>Phone<input v-model="phone" type="tel" required /></label
      ><label>Short bio<textarea v-model="bio" rows="3" /></label
      ><label>Skills, comma separated<input v-model="skills" /></label>
      <p v-if="error">{{ error }}</p>
      <button class="button" :disabled="loading">
        {{ loading ? 'Activating…' : 'Activate account' }}<ArrowRight :size="16" />
      </button>
    </form>
    <div v-else class="done">
      <strong>Invitation unavailable</strong>
      <p>{{ error }}</p>
    </div></AuthFrame
  >
</template>
<style scoped>
form,
.done {
  display: grid;
  gap: 14px;
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
input,
textarea {
  padding: 10px;
  color: var(--text);
  background: var(--paper);
  border: 1px solid var(--border);
}
input:disabled {
  background: var(--linen);
}
p {
  color: var(--clay-600);
  font-size: 12px;
}
.done strong {
  font:
    600 22px 'Newsreader',
    serif;
}
</style>
