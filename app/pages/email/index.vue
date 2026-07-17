<script setup lang="ts">
import { Mail, Paperclip, Plus, RefreshCw, Search, Send, X } from 'lucide-vue-next';
import type { MailMessage, MailProvider, Mailbox } from '~/types/email';

useHead({ title: 'Email · DevFathom Hub' });
const email = useEmail();
const providers = ref<Record<MailProvider, boolean>>({ GMAIL: false, OUTLOOK: false });
const mailboxes = ref<Mailbox[]>([]);
const mailboxId = ref('');
const messages = ref<MailMessage[]>([]);
const selected = ref<MailMessage | null>(null);
const query = ref('');
const loading = ref(true);
const busy = ref(false);
const error = ref('');
const compose = ref(false);
const accountMenu = ref(false);
const draft = reactive({ to: '', cc: '', subject: '', text: '' });
const current = computed(
  () => mailboxes.value.find((item) => item.id === mailboxId.value) || mailboxes.value[0]
);
const safeBody = computed(() => {
  if (!selected.value) return '';
  if (selected.value.bodyText) return selected.value.bodyText;
  return (selected.value.bodyHtml || '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
});

async function loadMailboxes() {
  [providers.value, mailboxes.value] = await Promise.all([email.providers(), email.mailboxes()]);
}
async function loadMessages() {
  if (!mailboxes.value.length) {
    messages.value = [];
    return;
  }
  if (mailboxId.value) {
    messages.value = await email.messages(mailboxId.value, query.value);
    return;
  }
  const inboxes = await Promise.all(
    mailboxes.value.map((mailbox) => email.messages(mailbox.id, query.value).catch(() => []))
  );
  messages.value = inboxes
    .flat()
    .sort((a, b) => new Date(b.sentAt || 0).getTime() - new Date(a.sentAt || 0).getTime());
}
async function boot() {
  loading.value = true;
  error.value = '';
  try {
    await loadMailboxes();
    await loadMessages();
  } catch (caught: any) {
    error.value = caught?.data?.detail || 'The correspondence desk is unavailable.';
  } finally {
    loading.value = false;
  }
}
await boot();
watch(mailboxId, async () => {
  selected.value = null;
  await loadMessages();
});
function mailboxConnected(event: MessageEvent) {
  if (event.origin === window.location.origin && event.data?.type === 'devfathom-mailbox-connected')
    void boot();
}
onMounted(() => window.addEventListener('message', mailboxConnected));
onBeforeUnmount(() => window.removeEventListener('message', mailboxConnected));
async function connect(provider: MailProvider) {
  accountMenu.value = false;
  error.value = '';
  try {
    const { url } = await email.connect(provider);
    window.open(url, 'devfathom-mailbox-oauth', 'popup,width=620,height=760');
  } catch (caught: any) {
    error.value = caught?.data?.detail || `${provider} is not configured.`;
  }
}
async function openMessage(item: MailMessage) {
  selected.value = await email.message(item.mailboxId, item.id);
  if (!item.isRead) {
    await email.markRead(item.mailboxId, item.id);
    item.isRead = true;
  }
}
async function refresh() {
  if (!mailboxes.value.length) return;
  busy.value = true;
  try {
    if (mailboxId.value) await email.refresh(mailboxId.value);
    else await Promise.all(mailboxes.value.map((mailbox) => email.refresh(mailbox.id)));
    await loadMessages();
  } finally {
    busy.value = false;
  }
}
const addresses = (value: string) =>
  value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
async function submit(saveDraft = false) {
  const fromId = mailboxId.value || current.value?.id || '';
  if (!fromId || (!saveDraft && !addresses(draft.to).length)) return;
  busy.value = true;
  try {
    const payload = {
      mailboxId: fromId,
      to: addresses(draft.to),
      cc: addresses(draft.cc),
      subject: draft.subject,
      text: draft.text,
    };
    if (saveDraft) await email.draft(payload);
    else await email.send(payload);
    Object.assign(draft, { to: '', cc: '', subject: '', text: '' });
    compose.value = false;
  } catch (caught: any) {
    error.value = caught?.data?.detail || 'The message could not be filed.';
  } finally {
    busy.value = false;
  }
}
async function disconnect(id = mailboxId.value) {
  if (!id) return;
  const result = await email.disconnect(id);
  const guidance = result.revocation.guidance || '';
  mailboxId.value = '';
  await boot();
  if (guidance) error.value = guidance;
}

function displayName(value: string) {
  const match = value.match(/^\s*"?([^"<]+)"?\s*</);
  return match?.[1]?.trim() || value.split('@')[0] || 'Unknown sender';
}

function emailOnly(value: string) {
  return value.match(/<([^>]+)>/)?.[1] || value;
}

function formatWhen(value?: string | number | null) {
  if (!value) return '';
  const when = new Date(value);
  const today = new Date();
  return when.toDateString() === today.toDateString()
    ? new Intl.DateTimeFormat('en', { hour: 'numeric', minute: '2-digit' }).format(when)
    : new Intl.DateTimeFormat('en', { month: 'short', day: 'numeric' }).format(when);
}
</script>

<template>
  <section class="inbox-page">
    <PageHeader eyebrow="Workspace" title="Inbox">
      <button class="mail-action" :disabled="busy || !current" @click="refresh">
        <RefreshCw :size="16" /> Refresh
      </button>
      <div class="add-account">
        <button class="mail-action" @click="accountMenu = !accountMenu">
          <Plus :size="16" /> Add account
        </button>
        <div v-if="accountMenu" class="account-menu">
          <button :disabled="!providers.GMAIL" @click="connect('GMAIL')">
            <Mail :size="14" /> Gmail
          </button>
          <button :disabled="!providers.OUTLOOK" @click="connect('OUTLOOK')">
            <Mail :size="14" /> Outlook
          </button>
        </div>
      </div>
      <button class="mail-action primary" :disabled="!current" @click="compose = true">
        <Plus :size="16" /> Compose
      </button>
    </PageHeader>
    <p v-if="error" class="error-banner">{{ error }}</p>
    <DeliveryFieldState v-if="loading" loading />
    <div v-else-if="!mailboxes.length" class="connect-card">
      <span class="connect-icon"><Mail :size="24" /></span>
      <h2>Connect your inbox</h2>
      <p>Link an account and your email shows up here. One click, nothing to set up.</p>
      <div class="connect-actions">
        <button class="provider-button" :disabled="!providers.GMAIL" @click="connect('GMAIL')">
          <Mail :size="16" /> Connect Gmail</button
        ><button class="provider-button" :disabled="!providers.OUTLOOK" @click="connect('OUTLOOK')">
          <Mail :size="16" /> Connect Outlook
        </button>
      </div>
    </div>
    <template v-else>
      <div class="account-filters" aria-label="Mailbox filters">
        <button class="filter-pill" :class="{ active: !mailboxId }" @click="mailboxId = ''">
          All inboxes
        </button>
        <span
          v-for="box in mailboxes"
          :key="box.id"
          class="account-pill"
          :class="{ active: mailboxId === box.id }"
        >
          <button @click="mailboxId = box.id"><Mail :size="12" /> {{ box.emailAddress }}</button>
          <button class="disconnect" aria-label="Disconnect mailbox" @click="disconnect(box.id)">
            <X :size="12" />
          </button>
        </span>
      </div>
      <div class="mail-shell" :class="{ reading: selected }">
        <main class="message-list">
          <form class="mail-search" @submit.prevent="loadMessages">
            <Search :size="15" /><input
              v-model="query"
              aria-label="Search mail"
              placeholder="Search this mailbox"
            />
          </form>
          <button
            v-for="message in messages"
            :key="message.id"
            :class="{ unread: !message.isRead, active: selected?.id === message.id }"
            @click="openMessage(message)"
          >
            <span class="message-top"
              ><i v-if="!message.isRead" /><b>{{ displayName(message.fromAddr) }}</b
              ><Paperclip v-if="message.hasAttachments" :size="12" /><time>{{
                formatWhen(message.sentAt)
              }}</time></span
            ><strong>{{ message.subject || '(No subject)' }}</strong>
            <p>{{ message.snippet || 'No preview available.' }}</p>
          </button>
          <DeliveryFieldState v-if="!messages.length" empty="No messages yet" />
        </main>
        <article class="reader">
          <template v-if="selected">
            <header class="reader-head">
              <h2>{{ selected.subject || '(No subject)' }}</h2>
              <div>
                <strong>{{ displayName(selected.fromAddr) }}</strong>
                <span>{{ emailOnly(selected.fromAddr) }}</span>
                <p v-if="selected.toAddrs.length">
                  to {{ selected.toAddrs.map(emailOnly).join(', ') }}
                </p>
                <p>{{ selected.sentAt ? new Date(selected.sentAt).toLocaleString() : '' }}</p>
                <p>via {{ selected.mailbox.emailAddress }}</p>
              </div>
            </header>
            <iframe
              v-if="selected.bodyHtml"
              class="mail-body-frame"
              title="message"
              sandbox=""
              :srcdoc="selected.bodyHtml"
            />
            <pre v-else>{{ safeBody || selected.snippet || 'No content.' }}</pre>
          </template>
          <div v-else class="reader-empty">
            <Mail :size="40" />
            <p>Select a message to read it</p>
          </div>
        </article>
      </div>
    </template>

    <div v-if="compose" class="dialog-backdrop" @click.self="compose = false">
      <form class="compose-card" @submit.prevent="submit(false)">
        <header>
          <div>
            <span>Workspace inbox</span>
            <h2>New message</h2>
          </div>
          <button type="button" aria-label="Close" @click="compose = false">
            <X :size="18" />
          </button>
        </header>
        <label
          >From<select v-model="mailboxId">
            <option v-for="box in mailboxes" :key="box.id" :value="box.id">
              {{ box.emailAddress }}
            </option>
          </select></label
        ><label
          >To<input
            v-model="draft.to"
            type="text"
            required
            placeholder="name@example.com, …" /></label
        ><label>CC<input v-model="draft.cc" type="text" /></label
        ><label>Subject<input v-model="draft.subject" type="text" /></label
        ><label>Message<textarea v-model="draft.text" rows="10" required /></label>
        <footer>
          <button type="button" class="button secondary" :disabled="busy" @click="submit(true)">
            Save draft</button
          ><button class="button" :disabled="busy"><Send :size="15" /> Send</button>
        </footer>
      </form>
    </div>
  </section>
</template>

<style scoped>
.inbox-page {
  display: flex;
  min-height: calc(100vh - 148px);
  flex-direction: column;
  gap: 12px;
}
.error-banner {
  padding: 9px 12px;
  color: var(--color-danger, #c03b2d);
  background: color-mix(in srgb, var(--color-danger, #c03b2d) 8%, transparent);
  border: 1px solid color-mix(in srgb, var(--color-danger, #c03b2d) 25%, transparent);
  border-radius: 10px;
  font-size: 12px;
}
.connect-card {
  width: min(448px, 100%);
  margin: auto;
  padding: 32px;
  text-align: center;
  background: var(--card);
  border: 1px solid var(--border-subtle);
  border-radius: 10px;
}
.connect-icon {
  display: grid;
  place-items: center;
  width: 48px;
  height: 48px;
  margin: 0 auto;
  color: var(--primary);
  background: color-mix(in srgb, var(--primary) 10%, transparent);
  border-radius: 8px;
}
.connect-card h2 {
  margin: 16px 0 6px;
  font-size: 18px;
  font-weight: 600;
}
.connect-card p {
  max-width: 330px;
  margin: 0 auto;
  color: var(--text-muted);
  font-size: 14px;
  line-height: 1.5;
}
.connect-actions {
  display: flex;
  flex-direction: column;
  gap: 10px;
  margin-top: 24px;
}
.provider-button,
.mail-action {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  border: 1px solid var(--border);
  background: var(--background);
  color: var(--foreground);
  border-radius: 10px;
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
  transition: 0.15s;
}
.provider-button {
  padding: 11px 16px;
}
.mail-action {
  min-height: 36px;
  padding: 0 12px;
}
.mail-action.primary {
  color: white;
  background: var(--primary);
  border-color: var(--primary);
}
.provider-button:hover,
.mail-action:hover {
  background: var(--muted);
}
.mail-action.primary:hover {
  background: color-mix(in srgb, var(--primary) 88%, black);
}
.provider-button:disabled,
.mail-action:disabled {
  cursor: not-allowed;
  opacity: 0.45;
}
.add-account {
  position: relative;
}
.account-menu {
  position: absolute;
  z-index: 20;
  top: calc(100% + 6px);
  right: 0;
  width: 164px;
  overflow: hidden;
  padding: 4px;
  background: var(--card);
  border: 1px solid var(--border);
  border-radius: 10px;
  box-shadow: 0 12px 32px rgba(0, 0, 0, 0.12);
}
.account-menu button {
  display: flex;
  width: 100%;
  align-items: center;
  gap: 8px;
  padding: 8px 9px;
  color: var(--foreground);
  background: transparent;
  border: 0;
  border-radius: 7px;
  font-size: 12px;
  text-align: left;
  cursor: pointer;
}
.account-menu button:hover {
  background: var(--muted);
}
.account-menu button:disabled {
  cursor: not-allowed;
  opacity: 0.4;
}
.account-filters {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}
.filter-pill,
.account-pill {
  min-height: 28px;
  border: 1px solid var(--border);
  border-radius: 999px;
  color: var(--text-muted);
  background: transparent;
  font-size: 12px;
  transition: 0.15s;
}
.filter-pill {
  padding: 0 12px;
  cursor: pointer;
}
.filter-pill.active,
.account-pill.active {
  color: var(--primary);
  background: color-mix(in srgb, var(--primary) 10%, transparent);
  border-color: color-mix(in srgb, var(--primary) 40%, transparent);
}
.account-pill {
  display: inline-flex;
  align-items: center;
  padding: 0 6px 0 10px;
}
.account-pill > button:first-child {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  border: 0;
  background: transparent;
  color: inherit;
  cursor: pointer;
}
.account-pill .disconnect {
  display: grid;
  place-items: center;
  width: 20px;
  height: 20px;
  margin-left: 3px;
  border: 0;
  border-radius: 50%;
  color: inherit;
  background: transparent;
  opacity: 0.5;
  cursor: pointer;
}
.account-pill .disconnect:hover {
  color: var(--color-danger, #c03b2d);
  background: color-mix(in srgb, var(--color-danger, #c03b2d) 10%, transparent);
  opacity: 1;
}
.mail-shell {
  display: flex;
  min-height: 0;
  flex: 1;
  gap: 12px;
}
.message-list {
  width: 380px;
  flex: 0 0 380px;
  overflow: auto;
  background: var(--card);
  border: 1px solid var(--border);
  border-radius: 12px;
}
.mail-search {
  display: flex;
  gap: 8px;
  align-items: center;
  padding: 12px;
  border-bottom: 1px solid var(--border-subtle);
}
.mail-search input {
  width: 100%;
  color: var(--foreground);
  background: transparent;
  border: 0;
  outline: 0;
  font-size: 12px;
}
.message-list > button {
  display: flex;
  width: 100%;
  flex-direction: column;
  gap: 2px;
  padding: 10px 12px;
  text-align: left;
  color: var(--foreground);
  background: transparent;
  border: 0;
  border-bottom: 1px solid var(--border-subtle);
  cursor: pointer;
  transition: 0.15s;
}
.message-list > button:hover {
  background: color-mix(in srgb, var(--muted) 60%, transparent);
}
.message-list > button.active {
  background: color-mix(in srgb, var(--primary) 5%, transparent);
}
.message-list > button.unread {
  background: color-mix(in srgb, var(--primary) 3%, transparent);
}
.message-top {
  display: flex;
  align-items: center;
  gap: 7px;
  width: 100%;
  overflow: hidden;
  color: var(--text-muted);
  font-size: 13px;
  white-space: nowrap;
}
.message-top b {
  min-width: 0;
  flex: 1;
  overflow: hidden;
  font-weight: inherit;
  text-overflow: ellipsis;
}
.message-top time {
  flex: none;
  font-size: 11px;
}
.message-top i {
  width: 6px;
  height: 6px;
  flex: none;
  border-radius: 50%;
  background: var(--primary);
}
.message-list > button.unread strong {
  color: var(--foreground);
  font-weight: 600;
}
.message-list strong {
  display: block;
  width: 100%;
  overflow: hidden;
  color: var(--text-muted);
  font-size: 12px;
  font-weight: 400;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.message-list p {
  width: 100%;
  margin: 0;
  overflow: hidden;
  color: var(--text-muted);
  font-size: 11px;
  text-overflow: ellipsis;
  white-space: nowrap;
  opacity: 0.8;
}
.reader {
  min-width: 0;
  flex: 1;
  padding: 0;
  overflow: auto;
  background: var(--card);
  border: 1px solid var(--border);
  border-radius: 12px;
}
.reader-head {
  padding: 16px;
  border-bottom: 1px solid var(--border);
}
.reader-head h2 {
  margin: 0;
  font-size: 16px;
  font-weight: 650;
}
.reader-head > div {
  margin-top: 8px;
  color: var(--text-muted);
  font-size: 12px;
}
.reader-head strong {
  color: var(--foreground);
  font-weight: 550;
}
.reader-head span {
  margin-left: 5px;
}
.reader-head p {
  margin: 2px 0 0;
}
.reader pre {
  padding: 20px;
  white-space: pre-wrap;
  font:
    13px/1.7 'Instrument Sans',
    sans-serif;
}
.mail-body-frame {
  display: block;
  width: 100%;
  min-height: 520px;
  border: 0;
  background: white;
}
.reader-empty {
  display: flex;
  height: 100%;
  min-height: 320px;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  color: var(--text-muted);
  text-align: center;
}
.reader-empty svg {
  opacity: 0.3;
}
.reader-empty p {
  margin-top: 8px;
  font-size: 14px;
}
.dialog-backdrop {
  position: fixed;
  inset: 0;
  z-index: 60;
  display: grid;
  place-items: center;
  padding: 20px;
  background: rgba(18, 24, 19, 0.65);
}
.compose-card {
  width: min(680px, 100%);
  padding: 24px;
  background: var(--card);
  border: 1px solid var(--border);
  border-radius: 14px;
  box-shadow: 0 24px 70px rgba(0, 0, 0, 0.22);
}
.compose-card header,
.compose-card footer {
  display: flex;
  justify-content: space-between;
  align-items: center;
}
.compose-card header span {
  color: var(--primary);
  font:
    9px 'IBM Plex Mono',
    monospace;
  text-transform: uppercase;
}
.compose-card header h2 {
  margin: 5px 0 20px;
}
.compose-card header button {
  color: var(--foreground);
  background: none;
  border: 0;
}
.compose-card label {
  display: grid;
  gap: 5px;
  margin: 10px 0;
  color: var(--text-muted);
  font-size: 10px;
  text-transform: uppercase;
}
.compose-card input,
.compose-card textarea,
.compose-card select {
  padding: 10px;
  color: var(--foreground);
  background: var(--background);
  border: 1px solid var(--border);
  border-radius: 8px;
  resize: vertical;
}
.compose-card footer {
  justify-content: flex-end;
  gap: 8px;
  margin-top: 16px;
}
@media (max-width: 1000px) {
  .message-list {
    width: 340px;
    flex-basis: 340px;
  }
}
@media (max-width: 680px) {
  .inbox-page {
    min-height: calc(100vh - 112px);
  }
  .mail-shell {
    display: block;
  }
  .message-list {
    width: 100%;
    height: calc(100vh - 240px);
  }
  .mail-shell.reading .message-list {
    display: none;
  }
  .reader {
    min-height: calc(100vh - 240px);
    padding: 20px;
  }
  .mail-shell:not(.reading) .reader {
    display: none;
  }
}
</style>
