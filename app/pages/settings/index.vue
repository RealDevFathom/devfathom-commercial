<script setup lang="ts">
import {
  AlertCircle,
  Bell,
  Check,
  Copy,
  History,
  KeyRound,
  Lock,
  LogOut,
  Monitor,
  Moon,
  Palette,
  Plus,
  Save,
  ShieldCheck,
  Sun,
  Trash2,
  UserRound,
  Webhook,
  X,
} from 'lucide-vue-next';
import type { ApiTokenRecord, Resignation, TeamMember, Webhook as WebhookType } from '~/types/firm';

useHead({ title: 'Settings · DevFathom Hub' });

const api = useFirm();
const { request } = useApi();
const { user, logout } = useAuth();
const colorMode = useColorMode();
const admin = computed(() => user.value?.role === 'ADMIN');

const member = ref<TeamMember | null>(null);
const prefs = ref<Record<string, any>>({});
const notificationPrefs = ref<Record<string, Record<string, boolean>>>({});
const sessions = ref<Record<string, any>[]>([]);
const tokens = ref<ApiTokenRecord[]>([]);
const webhooks = ref<WebhookType[]>([]);
const resignations = ref<Resignation[]>([]);
const loading = ref(true);
const message = ref('');
const error = ref('');
const editingProfile = ref(false);
const showTokenForm = ref(false);
const showWebhookForm = ref(false);
const showResignForm = ref(false);

const profile = reactive({ name: '', phone: '', bio: '', skills: '' });
const password = reactive({ current: '', next: '', confirm: '' });
const twoFactor = reactive({
  enabled: false,
  secret: '',
  uri: '',
  code: '',
  recovery: [] as string[],
});
const tokenDraft = reactive({ name: '', scopes: 'team:read', expires_in_days: 90 });
const webhookDraft = reactive({ url: '', events: ['invoice.paid'] as string[], active: true });
const oneShot = ref<{ label: string; secret: string } | null>(null);
const resignation = reactive({ reason: '', proposed_last_day: '' });

const notificationSettings = [
  { key: 'task', label: 'Tasks', description: 'Task assignments and updates' },
  { key: 'mention', label: 'Mentions', description: 'When someone @mentions you in chat' },
  { key: 'meeting', label: 'Meetings', description: 'Meeting invites' },
  { key: 'leave', label: 'Time off', description: 'Decisions on your leave requests' },
  { key: 'invoice', label: 'Invoices', description: 'Invoice and billing activity' },
  { key: 'project', label: 'Projects', description: 'Project membership and files' },
  { key: 'client', label: 'Clients', description: 'Client and contract changes' },
  {
    key: 'resignation',
    label: 'Resignations',
    description: 'Resignation submissions and decisions',
  },
  { key: 'note', label: 'Notes', description: 'When a note is shared with you' },
];

const scopeOptions = [
  { value: '*', label: 'Full Access' },
  { value: 'tasks:read', label: 'Tasks (read)' },
  { value: 'tasks:write', label: 'Tasks (write)' },
  { value: 'projects:read', label: 'Projects (read)' },
  { value: 'projects:write', label: 'Projects (write)' },
  { value: 'clients:read', label: 'Clients (read)' },
  { value: 'clients:write', label: 'Clients (write)' },
  { value: 'team:read', label: 'Team (read)' },
  { value: 'finance:read', label: 'Finance (read)' },
  { value: 'finance:write', label: 'Finance (write)' },
  { value: 'meetings:read', label: 'Meetings (read)' },
  { value: 'meetings:write', label: 'Meetings (write)' },
];

async function load() {
  loading.value = true;
  error.value = '';
  try {
    member.value = await api.member(user.value!.id);
    Object.assign(profile, {
      name: member.value.name,
      phone: member.value.phone || '',
      bio: member.value.bio || '',
      skills: member.value.skills?.join(', ') || '',
    });
    const saved = await api.preferences();
    prefs.value = {
      theme: colorMode.value === 'dark' ? 'dark' : 'light',
      density: 'default',
      type: 'default',
      accent: 'quiet',
      layout: 'top',
      icons: 'numeric',
      ...(saved.preferences || {}),
    };
    notificationPrefs.value = saved.notificationPreferences || {};
    sessions.value = (await api.sessions()).data;
    twoFactor.enabled = Boolean((await api.twoFactorStatus()).enabled);
    resignations.value = await api.resignations(true);
    if (admin.value) {
      [tokens.value, webhooks.value] = await Promise.all([api.apiTokens(), api.webhooks()]);
    }
  } catch (caught: any) {
    error.value = caught?.data?.detail || 'Settings could not be loaded.';
  } finally {
    loading.value = false;
  }
}

await load();

function notify(value: string) {
  message.value = value;
  setTimeout(() => (message.value = ''), 2200);
}

async function saveProfile() {
  await api.updateMe({
    name: profile.name,
    phone: profile.phone || null,
    bio: profile.bio || null,
    skills: profile.skills
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean),
  });
  editingProfile.value = false;
  await load();
  notify('Profile updated');
}

async function savePreference(key: string, value: string) {
  prefs.value[key] = value;
  if (key === 'theme') colorMode.preference = value;
  await api.savePreferences(prefs.value);
}

async function savePassword() {
  error.value = '';
  if (password.next !== password.confirm) {
    error.value = 'Passwords do not match.';
    return;
  }
  await api.changePassword(password.current, password.next);
  password.current = password.next = password.confirm = '';
  notify('Password changed successfully');
}

function categoryPrefs(category: string) {
  notificationPrefs.value[category] ||= { inApp: true, email: true };
  return notificationPrefs.value[category];
}

async function toggleNotification(category: string, channel: 'inApp' | 'email', value: boolean) {
  categoryPrefs(category)[channel] = value;
  await request('/api/auth/notification-preferences', {
    method: 'PUT',
    body: notificationPrefs.value,
  });
}

async function enroll() {
  const result = await api.twoFactorEnroll();
  twoFactor.secret = result.secret;
  twoFactor.uri = result.otpauthUri;
}

async function confirm2fa() {
  const result = await api.twoFactorConfirm(twoFactor.code);
  twoFactor.recovery = result.recoveryCodes;
  twoFactor.secret = '';
  twoFactor.uri = '';
  twoFactor.enabled = true;
  twoFactor.code = '';
}

async function disable2fa() {
  await api.twoFactorDisable(twoFactor.code);
  twoFactor.enabled = false;
  twoFactor.code = '';
  notify('Two-factor authentication disabled');
}

function selectedScopes() {
  return tokenDraft.scopes
    .split(',')
    .map((scope) => scope.trim())
    .filter(Boolean);
}

function toggleScope(scope: string) {
  const scopes = selectedScopes();
  tokenDraft.scopes = (
    scopes.includes(scope) ? scopes.filter((item) => item !== scope) : [...scopes, scope]
  ).join(',');
}

async function createToken() {
  const result = await api.createToken({
    name: tokenDraft.name,
    scopes: selectedScopes(),
    expires_in_days: tokenDraft.expires_in_days,
  });
  oneShot.value = { label: 'API token', secret: result.token };
  showTokenForm.value = false;
  await load();
}

async function createWebhook() {
  const result = await api.createWebhook(webhookDraft);
  oneShot.value = { label: 'Webhook signing secret', secret: result.secret };
  showWebhookForm.value = false;
  await load();
}

async function submitResignation() {
  await api.resign({
    reason: resignation.reason,
    proposed_last_day: new Date(resignation.proposed_last_day).toISOString(),
  });
  showResignForm.value = false;
  notify('Resignation submitted');
  await load();
}

function copySecret(secret: string) {
  if (import.meta.client) navigator.clipboard.writeText(secret);
  notify('Copied to clipboard');
}

const date = (value: unknown) =>
  value
    ? new Intl.DateTimeFormat('en', { dateStyle: 'medium', timeStyle: 'short' }).format(
        new Date(String(value))
      )
    : 'Never';

function initials(name?: string | null) {
  return (name || 'User')
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0])
    .join('')
    .toUpperCase();
}
</script>

<template>
  <section class="settings-page animate-fade-in">
    <div>
      <h1 class="font-display text-2xl font-bold tracking-tight text-foreground">Settings</h1>
      <p class="mt-1.5 text-[15px] text-text-muted">
        Manage your profile, security, and preferences.
      </p>
    </div>

    <DeliveryFieldState
      v-if="loading || error"
      :loading="loading"
      :error="error"
      action="Try again"
      @action="load"
    />

    <div v-else class="settings-stack">
      <p v-if="message" class="settings-message"><Check :size="14" />{{ message }}</p>

      <section class="settings-card">
        <header class="settings-card-header row-between">
          <div class="settings-title">
            <span class="icon-tile tile-primary"><UserRound :size="14" /></span>
            <h2>Profile</h2>
          </div>
          <button v-if="!editingProfile" class="text-action" @click="editingProfile = true">
            Edit
          </button>
        </header>
        <div class="settings-card-body">
          <div v-if="!editingProfile" class="profile-summary">
            <span class="profile-avatar">{{ initials(member?.name || user?.name) }}</span>
            <div>
              <p class="profile-name">{{ member?.name || user?.name }}</p>
              <p class="settings-muted">{{ member?.title || user?.title }}</p>
              <p v-if="member?.phone" class="settings-muted profile-phone">{{ member.phone }}</p>
              <p v-if="member?.bio" class="profile-bio">{{ member.bio }}</p>
              <div v-if="member?.skills?.length" class="chip-row">
                <span v-for="skill in member.skills" :key="skill" class="soft-chip">{{
                  skill
                }}</span>
              </div>
            </div>
          </div>
          <form v-else class="settings-form" @submit.prevent="saveProfile">
            <div class="field-grid two">
              <label>Name<input v-model="profile.name" required /></label>
              <label>Phone<input v-model="profile.phone" /></label>
            </div>
            <label>Bio<textarea v-model="profile.bio" rows="2" /></label>
            <label
              >Skills<input v-model="profile.skills" placeholder="Add skills, separated by commas"
            /></label>
            <div class="form-actions">
              <button type="button" class="quiet-button" @click="editingProfile = false">
                Cancel
              </button>
              <button class="studio-primary-button"><Save :size="14" />Save</button>
            </div>
          </form>
        </div>
      </section>

      <section class="settings-card">
        <header class="settings-card-header">
          <div class="settings-title">
            <span class="icon-tile tile-amber"><Lock :size="14" /></span>
            <h2>Password</h2>
          </div>
        </header>
        <form class="settings-card-body settings-form" @submit.prevent="savePassword">
          <p v-if="error" class="inline-error">{{ error }}</p>
          <div class="field-grid three">
            <label
              >Current Password<input
                v-model="password.current"
                type="password"
                autocomplete="current-password"
                required
            /></label>
            <label
              >New Password<input
                v-model="password.next"
                type="password"
                autocomplete="new-password"
                minlength="8"
                required
            /></label>
            <label
              >Confirm<input
                v-model="password.confirm"
                type="password"
                autocomplete="new-password"
                required
            /></label>
          </div>
          <div class="form-actions">
            <button class="studio-primary-button"><Lock :size="14" />Change Password</button>
          </div>
          <div class="danger-row">
            <div>
              <strong>Sign out everywhere</strong>
              <p>
                Revoke all sessions on every device. Use this if you suspect your account is
                compromised.
              </p>
            </div>
            <button
              type="button"
              class="outline-button"
              @click="api.signOutEverywhere().then(logout)"
            >
              <LogOut :size="14" />Sign out everywhere
            </button>
          </div>
        </form>
      </section>

      <section class="settings-card">
        <header class="settings-card-header">
          <div class="settings-title">
            <span class="icon-tile tile-emerald"><ShieldCheck :size="14" /></span>
            <h2>Two-Factor Authentication</h2>
          </div>
          <p>Require a time-based code from an authenticator app at sign-in.</p>
        </header>
        <div class="settings-card-body">
          <AdminOneShotSecret
            v-if="twoFactor.recovery.length"
            label="Recovery codes"
            :secret="twoFactor.recovery.join('\n')"
            @dismiss="twoFactor.recovery = []"
          />
          <div v-else-if="twoFactor.secret" class="settings-form">
            <p class="settings-muted">
              Add this account to your authenticator app, then enter the 6-digit code to confirm.
            </p>
            <label
              >Setup key<code class="secret-code">{{ twoFactor.secret }}</code></label
            >
            <details>
              <summary>otpauth:// URI</summary>
              <code class="secret-code">{{ twoFactor.uri }}</code>
            </details>
            <div class="inline-controls">
              <input v-model="twoFactor.code" inputmode="numeric" placeholder="123456" /><button
                class="studio-primary-button"
                @click="confirm2fa"
              >
                Verify & enable</button
              ><button class="quiet-button" @click="twoFactor.secret = ''">Cancel</button>
            </div>
          </div>
          <form
            v-else-if="twoFactor.enabled"
            class="row-between responsive-row"
            @submit.prevent="disable2fa"
          >
            <p class="success-line"><Check :size="16" />Two-factor authentication is on.</p>
            <div class="inline-controls">
              <input v-model="twoFactor.code" placeholder="Code" required /><button
                class="danger-button"
              >
                Disable
              </button>
            </div>
          </form>
          <button v-else class="studio-primary-button" @click="enroll">
            Enable two-factor authentication
          </button>
        </div>
      </section>

      <section class="settings-card">
        <header class="settings-card-header">
          <div class="settings-title">
            <span class="icon-tile tile-indigo"><History :size="14" /></span>
            <h2>Recent sign-ins</h2>
          </div>
          <p>
            Your latest successful sign-ins. Use <strong>Sign out everywhere</strong> above to
            revoke them all.
          </p>
        </header>
        <div class="settings-card-body compact-body">
          <div v-if="sessions.length" class="list-divided">
            <article v-for="entry in sessions" :key="String(entry.id)" class="settings-list-row">
              <span class="device-icon"><Monitor :size="14" /></span>
              <div>
                <strong>{{ entry.userAgent || 'Unknown device' }}</strong
                ><small>{{ entry.ip || 'Unknown IP' }}</small>
              </div>
              <time>{{ date(entry.createdAt) }}</time>
            </article>
          </div>
          <p v-else class="empty-line">No recent sign-ins recorded.</p>
        </div>
      </section>

      <section class="settings-card">
        <header class="settings-card-header">
          <div class="settings-title">
            <span class="icon-tile tile-sky"><Bell :size="14" /></span>
            <h2>Notifications</h2>
          </div>
          <p>Choose how you're notified. Turn off in-app or email for any category.</p>
        </header>
        <div class="settings-card-body compact-body">
          <div class="notification-head"><span /><span>In-app</span><span>Email</span></div>
          <div class="list-divided">
            <article
              v-for="setting in notificationSettings"
              :key="setting.key"
              class="notification-row"
            >
              <div>
                <strong>{{ setting.label }}</strong
                ><small>{{ setting.description }}</small>
              </div>
              <label class="switch"
                ><input
                  :checked="categoryPrefs(setting.key).inApp !== false"
                  type="checkbox"
                  @change="
                    toggleNotification(
                      setting.key,
                      'inApp',
                      ($event.target as HTMLInputElement).checked
                    )
                  " /><span
              /></label>
              <label class="switch"
                ><input
                  :checked="categoryPrefs(setting.key).email !== false"
                  type="checkbox"
                  @change="
                    toggleNotification(
                      setting.key,
                      'email',
                      ($event.target as HTMLInputElement).checked
                    )
                  " /><span
              /></label>
            </article>
          </div>
        </div>
      </section>

      <section class="settings-card">
        <header class="settings-card-header">
          <div class="settings-title">
            <span class="icon-tile tile-violet"><Palette :size="14" /></span>
            <h2>Appearance</h2>
          </div>
          <p>
            Personalize the workspace. Changes apply instantly and are remembered on this device.
          </p>
        </header>
        <div class="settings-card-body">
          <label class="mb-3 block text-sm font-medium text-foreground">Theme</label>
          <div class="theme-grid">
            <button
              v-for="option in [
                { value: 'light', label: 'Light', icon: Sun },
                { value: 'dark', label: 'Dark', icon: Moon },
                { value: 'system', label: 'System', icon: Monitor },
              ]"
              :key="option.value"
              :class="{ active: prefs.theme === option.value }"
              @click="savePreference('theme', option.value)"
            >
              <component :is="option.icon" :size="20" />
              <span>{{ option.label }}</span>
            </button>
          </div>
        </div>
      </section>

      <section v-if="admin" class="settings-card">
        <header class="settings-card-header row-between">
          <div>
            <div class="settings-title">
              <span class="icon-tile tile-blue"><KeyRound :size="14" /></span>
              <h2>API Tokens</h2>
            </div>
            <p>Create scoped tokens for the REST API. Tokens are shown once.</p>
          </div>
          <button v-if="!showTokenForm" class="outline-button" @click="showTokenForm = true">
            <Plus :size="14" />New Token
          </button>
        </header>
        <div class="settings-card-body">
          <AdminOneShotSecret
            v-if="oneShot?.label === 'API token'"
            :label="oneShot.label"
            :secret="oneShot.secret"
            @dismiss="oneShot = null"
          />
          <div v-if="tokens.length" class="list-divided">
            <article v-for="token in tokens" :key="token.id" class="settings-list-row">
              <span class="device-icon"><KeyRound :size="14" /></span>
              <div>
                <strong>{{ token.name }}</strong
                ><small>{{ token.prefix }}… · {{ token.scopes.join(', ') }}</small>
              </div>
              <time>{{ date(token.expiresAt) }}</time
              ><button
                class="icon-button danger"
                aria-label="Revoke token"
                @click="api.revokeToken(token.id).then(load)"
              >
                <Trash2 :size="14" />
              </button>
            </article>
          </div>
          <p v-else class="empty-line">No API tokens yet</p>
          <form
            v-if="showTokenForm"
            class="create-panel settings-form"
            @submit.prevent="createToken"
          >
            <div class="field-grid two">
              <label>Token name<input v-model="tokenDraft.name" required /></label
              ><label
                >Expires in<input
                  v-model.number="tokenDraft.expires_in_days"
                  type="number"
                  min="1"
                  max="3650"
              /></label>
            </div>
            <label>Scopes</label>
            <div class="chip-row">
              <button
                v-for="scope in scopeOptions"
                :key="scope.value"
                type="button"
                class="scope-chip"
                :class="{ active: selectedScopes().includes(scope.value) }"
                @click="toggleScope(scope.value)"
              >
                {{ scope.label }}
              </button>
            </div>
            <div class="form-actions">
              <button type="button" class="quiet-button" @click="showTokenForm = false">
                Cancel</button
              ><button class="studio-primary-button"><Plus :size="14" />Create Token</button>
            </div>
          </form>
        </div>
      </section>

      <section v-if="admin" class="settings-card">
        <header class="settings-card-header row-between">
          <div>
            <div class="settings-title">
              <span class="icon-tile tile-fuchsia"><Webhook :size="14" /></span>
              <h2>Webhooks</h2>
            </div>
            <p>Send a signed POST to your endpoint when events happen.</p>
          </div>
          <button v-if="!showWebhookForm" class="outline-button" @click="showWebhookForm = true">
            <Plus :size="14" />New Webhook
          </button>
        </header>
        <div class="settings-card-body">
          <AdminOneShotSecret
            v-if="oneShot?.label === 'Webhook signing secret'"
            :label="oneShot.label"
            :secret="oneShot.secret"
            @dismiss="oneShot = null"
          />
          <div v-if="webhooks.length" class="list-divided">
            <article v-for="hook in webhooks" :key="hook.id" class="settings-list-row">
              <span class="device-icon"><Webhook :size="14" /></span>
              <div>
                <strong class="mono-line">{{ hook.url }}</strong
                ><small>{{ hook.events.join(', ') }} · {{ hook.deliveryCount }} deliveries</small>
              </div>
              <span class="status-pill">{{ hook.active ? 'Active' : 'Paused' }}</span
              ><button
                class="icon-button danger"
                aria-label="Delete webhook"
                @click="api.removeWebhook(hook.id).then(load)"
              >
                <Trash2 :size="14" />
              </button>
            </article>
          </div>
          <p v-else class="empty-line">No webhooks yet</p>
          <form
            v-if="showWebhookForm"
            class="create-panel settings-form"
            @submit.prevent="createWebhook"
          >
            <label
              >Endpoint URL<input
                v-model="webhookDraft.url"
                type="url"
                required
                placeholder="https://example.com/webhooks/devfathom"
            /></label>
            <label>Events</label>
            <div class="chip-row">
              <button
                v-for="event in ['invoice.paid', 'task.created']"
                :key="event"
                type="button"
                class="scope-chip"
                :class="{ active: webhookDraft.events.includes(event) }"
                @click="
                  webhookDraft.events = webhookDraft.events.includes(event)
                    ? webhookDraft.events.filter((item) => item !== event)
                    : [...webhookDraft.events, event]
                "
              >
                {{ event }}
              </button>
            </div>
            <div class="form-actions">
              <button type="button" class="quiet-button" @click="showWebhookForm = false">
                Cancel</button
              ><button class="studio-primary-button"><Plus :size="14" />Create Webhook</button>
            </div>
          </form>
        </div>
      </section>

      <section class="settings-card">
        <header class="settings-card-header">
          <div class="settings-title">
            <span class="icon-tile tile-neutral"><UserRound :size="14" /></span>
            <h2>Account</h2>
          </div>
        </header>
        <dl class="settings-card-body account-grid">
          <div>
            <dt>Email</dt>
            <dd class="mono-line">{{ user?.email }}</dd>
          </div>
          <div>
            <dt>Role</dt>
            <dd>{{ user?.role }}</dd>
          </div>
          <div>
            <dt>Department</dt>
            <dd>{{ user?.department || '—' }}</dd>
          </div>
          <div>
            <dt>Title</dt>
            <dd>{{ user?.title || member?.title || '—' }}</dd>
          </div>
        </dl>
      </section>

      <section class="settings-card danger-card">
        <header class="settings-card-header row-between">
          <div>
            <div class="settings-title">
              <span class="icon-tile tile-red"><LogOut :size="14" /></span>
              <h2>Leave the company</h2>
            </div>
            <p>Submit a formal resignation request for administrator review.</p>
          </div>
          <button
            v-if="!showResignForm && !resignations.some((item) => item.status === 'PENDING')"
            class="danger-outline"
            @click="showResignForm = true"
          >
            Submit resignation
          </button>
        </header>
        <div class="settings-card-body">
          <div v-if="resignations.length" class="list-divided">
            <article v-for="item in resignations" :key="item.id" class="settings-list-row">
              <span class="device-icon"><AlertCircle :size="14" /></span>
              <div>
                <strong>{{ item.status }}</strong
                ><small>Proposed {{ date(item.proposedLastDay) }} · {{ item.reason }}</small>
              </div>
              <button
                v-if="item.status === 'PENDING'"
                class="outline-button"
                @click="api.withdrawResignation(item.id).then(load)"
              >
                Withdraw
              </button>
            </article>
          </div>
          <form
            v-if="showResignForm"
            class="create-panel settings-form"
            @submit.prevent="submitResignation"
          >
            <label
              >Reason<textarea
                v-model="resignation.reason"
                rows="5"
                minlength="10"
                required
              /></label
            ><label
              >Proposed last day<input v-model="resignation.proposed_last_day" type="date" required
            /></label>
            <div class="form-actions">
              <button type="button" class="quiet-button" @click="showResignForm = false">
                Cancel</button
              ><button class="danger-button">Submit resignation</button>
            </div>
          </form>
        </div>
      </section>
    </div>
  </section>
</template>

<style scoped>
.settings-page {
  max-width: 672px;
  display: grid;
  gap: 24px;
}
.settings-stack {
  display: grid;
  gap: 24px;
}
.settings-message {
  position: fixed;
  right: 24px;
  bottom: 24px;
  z-index: 60;
  display: flex;
  align-items: center;
  gap: 7px;
  border: 1px solid #a7f3d0;
  border-radius: 12px;
  padding: 10px 14px;
  color: #047857;
  background: #ecfdf5;
  font-size: 12px;
  font-weight: 600;
  box-shadow: var(--shadow-md);
}
.settings-card {
  display: flex;
  flex-direction: column;
  gap: 16px;
  overflow: hidden;
  border: 0;
  border-radius: 12px;
  padding: 16px 0;
  background: var(--surface-card);
  box-shadow: 0 0 0 1px color-mix(in srgb, var(--foreground) 10%, transparent);
}
.settings-card-header {
  padding: 0 16px 12px;
}
.settings-card-header > p,
.settings-card-header > div > p {
  margin: 6px 0 0 32px;
  color: var(--text-muted);
  font-size: 12px;
  line-height: 1.55;
}
.settings-card-body {
  padding: 0 16px;
}
.compact-body {
  padding-top: 0;
}
.row-between {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 18px;
}
.settings-title {
  display: flex;
  align-items: center;
  gap: 8px;
}
.settings-title h2 {
  margin: 0;
  color: var(--foreground);
  font-size: 15px;
  font-weight: 650;
  letter-spacing: -0.01em;
}
.icon-tile {
  display: grid;
  width: 24px;
  height: 24px;
  flex: 0 0 auto;
  place-items: center;
  border-radius: 7px;
}
.tile-primary {
  color: var(--accent-brand);
  background: color-mix(in srgb, var(--accent-brand) 11%, transparent);
}
.tile-amber {
  color: #d97706;
  background: #fef3c7;
}
.tile-emerald {
  color: #059669;
  background: #d1fae5;
}
.tile-indigo {
  color: #6366f1;
  background: #e0e7ff;
}
.tile-sky {
  color: #0284c7;
  background: #e0f2fe;
}
.tile-violet {
  color: #7c3aed;
  background: #ede9fe;
}
.tile-blue {
  color: #2563eb;
  background: #dbeafe;
}
.tile-fuchsia {
  color: #c026d3;
  background: #fae8ff;
}
.tile-neutral {
  color: var(--text-muted);
  background: var(--surface-sunken);
}
.tile-red {
  color: #dc2626;
  background: #fee2e2;
}
.text-action {
  border: 0;
  color: var(--accent-brand);
  background: transparent;
  font-size: 12px;
  font-weight: 650;
  cursor: pointer;
}
.text-action:hover {
  text-decoration: underline;
}
.profile-summary {
  display: flex;
  align-items: flex-start;
  gap: 16px;
}
.profile-avatar {
  display: grid;
  width: 64px;
  height: 64px;
  flex: 0 0 auto;
  place-items: center;
  border-radius: 50%;
  color: var(--foreground);
  background: var(--surface-sunken);
  font-size: 20px;
  font-weight: 750;
}
.profile-name {
  margin: 0;
  color: var(--foreground);
  font-size: 16px;
  font-weight: 650;
}
.settings-muted {
  margin: 2px 0 0;
  color: var(--text-muted);
  font-size: 13px;
}
.profile-phone {
  margin-top: 4px;
}
.profile-bio {
  margin: 10px 0 0;
  color: var(--text-muted);
  font-size: 13px;
  line-height: 1.55;
}
.chip-row {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 11px;
}
.soft-chip,
.scope-chip {
  border: 0;
  border-radius: 8px;
  padding: 4px 8px;
  color: var(--foreground);
  background: var(--surface-sunken);
  font-size: 11px;
  font-weight: 600;
}
.scope-chip {
  cursor: pointer;
}
.scope-chip.active {
  color: var(--accent-brand);
  background: color-mix(in srgb, var(--accent-brand) 10%, transparent);
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--accent-brand) 20%, transparent);
}
.settings-form {
  display: grid;
  gap: 15px;
}
.settings-form label {
  display: grid;
  gap: 6px;
  color: var(--foreground);
  font-size: 12px;
  font-weight: 600;
}
.settings-form input,
.settings-form select,
.settings-form textarea,
.inline-controls input {
  min-height: 40px;
  width: 100%;
  border: 1px solid var(--border-default);
  border-radius: 11px;
  padding: 8px 11px;
  color: var(--foreground);
  background: var(--surface-card);
  font: 13px var(--font-sans);
  outline: none;
}
.settings-form textarea {
  resize: vertical;
}
.settings-form input:focus,
.settings-form textarea:focus,
.inline-controls input:focus {
  border-color: var(--accent-brand);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent-brand) 12%, transparent);
}
.field-grid {
  display: grid;
  gap: 12px;
}
.field-grid.two {
  grid-template-columns: repeat(2, minmax(0, 1fr));
}
.field-grid.three {
  grid-template-columns: repeat(3, minmax(0, 1fr));
}
.form-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}
.studio-primary-button,
.quiet-button,
.outline-button,
.danger-button,
.danger-outline {
  min-height: 36px;
  border-radius: 10px;
  padding: 0 13px;
  font-size: 12px;
  font-weight: 650;
  cursor: pointer;
}
.studio-primary-button,
.outline-button,
.danger-button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
}
.quiet-button {
  border: 0;
  color: var(--text-muted);
  background: transparent;
}
.outline-button {
  border: 1px solid var(--border-default);
  color: var(--foreground);
  background: var(--surface-card);
}
.danger-button {
  border: 0;
  color: white;
  background: #ef4444;
}
.danger-outline {
  border: 1px solid #fecaca;
  color: #dc2626;
  background: transparent;
}
.inline-error {
  margin: 0;
  border-radius: 9px;
  padding: 9px 11px;
  color: #dc2626;
  background: #fee2e2;
  font-size: 12px;
}
.success-line {
  display: flex;
  align-items: center;
  gap: 7px;
  margin: 0;
  color: #059669;
  font-size: 13px;
  font-weight: 600;
}
.danger-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  margin-top: 4px;
  border-top: 1px solid var(--border-subtle);
  padding-top: 16px;
}
.danger-row strong {
  color: var(--foreground);
  font-size: 12px;
}
.danger-row p {
  max-width: 430px;
  margin: 3px 0 0;
  color: var(--text-muted);
  font-size: 11px;
  line-height: 1.45;
}
.secret-code {
  display: block;
  overflow-wrap: anywhere;
  border: 1px solid var(--border-default);
  border-radius: 9px;
  padding: 8px 10px;
  color: var(--foreground);
  background: var(--surface-sunken);
  font: 11px var(--font-mono);
}
.inline-controls {
  display: flex;
  align-items: center;
  gap: 8px;
}
.inline-controls input {
  max-width: 160px;
}
.list-divided > * + * {
  border-top: 1px solid var(--border-subtle);
}
.settings-list-row {
  display: flex;
  align-items: center;
  gap: 12px;
  min-height: 52px;
  padding: 10px 0;
}
.settings-list-row > div {
  min-width: 0;
  flex: 1;
}
.settings-list-row strong,
.settings-list-row small {
  display: block;
}
.settings-list-row strong {
  overflow: hidden;
  color: var(--foreground);
  font-size: 12px;
  font-weight: 600;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.settings-list-row small {
  overflow: hidden;
  margin-top: 3px;
  color: var(--text-muted);
  font-size: 10px;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.settings-list-row time {
  flex: 0 0 auto;
  color: var(--text-muted);
  font-size: 10px;
  font-variant-numeric: tabular-nums;
}
.device-icon {
  display: grid;
  width: 32px;
  height: 32px;
  flex: 0 0 auto;
  place-items: center;
  border-radius: 9px;
  color: var(--text-muted);
  background: var(--surface-sunken);
}
.empty-line {
  margin: 0;
  padding: 14px 0;
  color: var(--text-muted);
  text-align: center;
  font-size: 11px;
}
.notification-head,
.notification-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 48px 48px;
  align-items: center;
  gap: 16px;
}
.notification-head {
  padding-bottom: 8px;
  color: var(--text-muted);
  font-size: 9px;
  font-weight: 650;
  text-align: center;
  text-transform: uppercase;
  letter-spacing: 0.08em;
}
.notification-row {
  min-height: 56px;
  padding: 9px 0;
}
.notification-row strong,
.notification-row small {
  display: block;
}
.notification-row strong {
  color: var(--foreground);
  font-size: 12px;
}
.notification-row small {
  margin-top: 2px;
  color: var(--text-muted);
  font-size: 10px;
}
.switch {
  position: relative;
  display: block;
  width: 34px;
  height: 20px;
  margin: auto;
}
.switch input {
  position: absolute;
  opacity: 0;
  pointer-events: none;
}
.switch span {
  display: block;
  width: 100%;
  height: 100%;
  border-radius: 999px;
  background: var(--border-default);
  cursor: pointer;
  transition: 0.18s ease;
}
.switch span::after {
  content: '';
  position: absolute;
  top: 3px;
  left: 3px;
  width: 14px;
  height: 14px;
  border-radius: 50%;
  background: white;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.18);
  transition: 0.18s ease;
}
.switch input:checked + span {
  background: var(--accent-brand);
}
.switch input:checked + span::after {
  transform: translateX(14px);
}
.preference-list {
  display: grid;
  gap: 20px;
}
.preference-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 18px;
}
.preference-row strong {
  color: var(--foreground);
  font-size: 12px;
}
.preference-row p {
  margin: 2px 0 0;
  color: var(--text-muted);
  font-size: 10px;
}
.segmented {
  display: inline-flex;
  flex-wrap: wrap;
  gap: 2px;
  border: 1px solid var(--border-default);
  border-radius: 11px;
  padding: 2px;
  background: var(--surface-page);
}
.segmented button {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  min-height: 29px;
  border: 0;
  border-radius: 8px;
  padding: 0 10px;
  color: var(--text-muted);
  background: transparent;
  font-size: 11px;
  font-weight: 600;
  text-transform: capitalize;
  cursor: pointer;
}
.segmented button.active {
  color: var(--accent-brand);
  background: color-mix(in srgb, var(--accent-brand) 10%, transparent);
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--accent-brand) 20%, transparent);
}
.theme-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 12px;
}
.theme-grid button {
  display: flex;
  min-height: 86px;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  border: 1px solid var(--border-default);
  border-radius: 12px;
  color: var(--text-muted);
  background: var(--surface-card);
  font-size: 12px;
  font-weight: 600;
  transition: 0.18s ease;
}
.theme-grid button:hover {
  background: var(--surface-sunken);
}
.theme-grid button.active {
  border-color: var(--primary);
  color: var(--primary);
  background: color-mix(in srgb, var(--primary) 5%, var(--surface-card));
  box-shadow: 0 0 0 1px color-mix(in srgb, var(--primary) 20%, transparent);
}
.create-panel {
  margin-top: 14px;
  border: 1px solid color-mix(in srgb, var(--accent-brand) 20%, var(--border-subtle));
  border-radius: 13px;
  padding: 15px;
  background: var(--surface-page);
}
.icon-button {
  display: grid;
  width: 30px;
  height: 30px;
  place-items: center;
  border: 0;
  border-radius: 8px;
  color: var(--text-muted);
  background: transparent;
  cursor: pointer;
}
.icon-button.danger:hover {
  color: #dc2626;
  background: #fee2e2;
}
.status-pill {
  border-radius: 999px;
  padding: 4px 8px;
  color: #047857;
  background: #d1fae5;
  font-size: 9px;
  font-weight: 700;
}
.mono-line {
  font-family: var(--font-mono);
}
.account-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 18px;
}
.account-grid dt {
  margin-bottom: 5px;
  color: var(--text-muted);
  font-size: 9px;
  font-weight: 650;
  text-transform: uppercase;
  letter-spacing: 0.08em;
}
.account-grid dd {
  margin: 0;
  color: var(--foreground);
  font-size: 12px;
}
.danger-card {
  border-color: color-mix(in srgb, #ef4444 22%, var(--border-subtle));
}
@media (max-width: 760px) {
  .settings-page {
    max-width: none;
  }
  .field-grid.two,
  .field-grid.three,
  .account-grid {
    grid-template-columns: 1fr;
  }
  .row-between,
  .responsive-row,
  .danger-row,
  .preference-row {
    align-items: flex-start;
    flex-direction: column;
  }
  .settings-card-header > p,
  .settings-card-header > div > p {
    margin-left: 0;
  }
  .inline-controls {
    width: 100%;
    flex-wrap: wrap;
  }
  .notification-head,
  .notification-row {
    grid-template-columns: minmax(0, 1fr) 42px 42px;
    gap: 8px;
  }
  .settings-list-row {
    align-items: flex-start;
    flex-wrap: wrap;
  }
  .settings-list-row time {
    margin-left: 44px;
  }
  .segmented {
    width: 100%;
  }
  .form-actions {
    flex-wrap: wrap;
  }
  .profile-summary {
    flex-direction: column;
  }
}
</style>
