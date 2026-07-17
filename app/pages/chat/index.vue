<script setup lang="ts">
import {
  BellOff,
  Bookmark,
  Hash,
  LockKeyhole,
  Menu,
  MessageSquare,
  Paperclip,
  Pin,
  Plus,
  Search,
  Send,
  Users,
  X,
} from 'lucide-vue-next';
import type { Channel, Message } from '~/types/collaboration';

useHead({ title: 'Chat · DevFathom Hub' });
const chat = useChat();
const channels = ref<Channel[]>([]);
const channelId = ref<string | null>(null);
const messages = ref<Message[]>([]);
const loading = ref(true);
const loadingMessages = ref(false);
const error = ref('');
const draft = ref('');
const channelForm = ref(false);
const mobileChannels = ref(false);
const threadParent = ref<Message | null>(null);
const threadReplies = ref<Message[]>([]);
const threadDraft = ref('');
const utility = ref<'none' | 'pins' | 'saved' | 'search'>('none');
const utilityMessages = ref<Message[]>([]);
const searchQuery = ref('');
const channelFilter = ref('');
const uploads = ref<UploadedFile[]>([]);
const uploading = ref(false);
const fileInput = ref<HTMLInputElement | null>(null);
const { upload } = useUploads();
const current = computed(() => channels.value.find((c) => c.id === channelId.value) || null);
const visibleChannels = computed(() => {
  const value = channelFilter.value.trim().toLowerCase();
  return value
    ? channels.value.filter((channel) => channelName(channel).toLowerCase().includes(value))
    : channels.value;
});
const regularChannels = computed(() => visibleChannels.value.filter((channel) => !channel.isDM));
const directChannels = computed(() => visibleChannels.value.filter((channel) => channel.isDM));
async function loadChannels() {
  try {
    channels.value = await chat.channels();
    if (!channelId.value && channels.value[0]) channelId.value = channels.value[0].id;
  } catch (caught: any) {
    error.value = caught?.data?.detail || 'Channels are unavailable.';
  } finally {
    loading.value = false;
  }
}
async function loadMessages(silent = false) {
  if (!channelId.value) return;
  if (!silent) loadingMessages.value = true;
  try {
    const result = await chat.messages(channelId.value);
    messages.value = result.items;
    await chat.read(channelId.value);
  } finally {
    loadingMessages.value = false;
  }
}
await loadChannels();
if (channelId.value) await loadMessages();
watch(channelId, async () => {
  threadParent.value = null;
  utility.value = 'none';
  mobileChannels.value = false;
  await loadMessages();
});
useChatRealtime(channelId, () => loadMessages(true));
async function send(parentId?: string) {
  const text = parentId ? threadDraft.value : draft.value;
  if (!channelId.value || (!text.trim() && !uploads.value.length)) return;
  await chat.send(channelId.value, text, parentId, parentId ? [] : uploads.value);
  if (parentId) {
    threadDraft.value = '';
    if (threadParent.value) await openThread(threadParent.value);
  } else {
    draft.value = '';
    uploads.value = [];
    await loadMessages();
  }
}
async function addFiles(event: Event) {
  const input = event.target as HTMLInputElement;
  const files = Array.from(input.files || []);
  if (!files.length) return;
  uploading.value = true;
  error.value = '';
  try {
    for (const file of files) uploads.value.push(await upload(file));
  } catch (caught: any) {
    error.value = caught?.data?.detail || 'The attachment could not be uploaded.';
  } finally {
    uploading.value = false;
    input.value = '';
  }
}
async function openThread(message: Message) {
  const data = await chat.thread(message.id);
  threadParent.value = data.parent;
  threadReplies.value = data.replies;
}
async function react(message: Message, emoji: string) {
  await chat.react(message.id, emoji);
  await loadMessages(true);
  if (threadParent.value) await openThread(threadParent.value);
}
async function pin(message: Message) {
  await chat.pin(message.id);
  await loadMessages(true);
}
async function save(message: Message) {
  await chat.save(message.id);
  await loadMessages(true);
}
async function openUtility(kind: 'pins' | 'saved') {
  utility.value = kind;
  utilityMessages.value =
    kind === 'pins' && channelId.value ? await chat.pins(channelId.value) : await chat.saved();
}
async function search() {
  if (searchQuery.value.trim())
    utilityMessages.value = await chat.search(searchQuery.value, channelId.value || undefined);
}
async function toggleMute() {
  if (!current.value) return;
  await chat.mute(current.value.id, !current.value.muted);
  await loadChannels();
}
const channelName = (c: Channel) => (c.isDM ? c.dmPeer?.name || 'Direct message' : c.name);
</script>

<template>
  <section class="chat-page">
    <div class="global-chat-bar">
      <button
        class="jump-button"
        @click="
          utility = 'search';
          mobileChannels = true;
        "
      >
        <Search :size="14" /><span>Jump to a channel or person…</span><kbd>⌘K</kbd>
      </button>
      <button class="saved-button" @click="openUtility('saved')">
        <Bookmark :size="14" /><span>Saved</span>
      </button>
      <button class="mobile-menu" aria-label="Show channels" @click="mobileChannels = true">
        <Menu :size="16" />
      </button>
    </div>
    <div class="chat-shell">
      <aside class="channels" :class="{ open: mobileChannels }">
        <header class="channel-filter">
          <label
            ><Hash :size="12" /><input v-model="channelFilter" placeholder="Filter channels…"
          /></label>
          <button class="mobile-close" aria-label="Close channels" @click="mobileChannels = false">
            <X :size="16" />
          </button>
        </header>
        <DeliveryFieldState v-if="loading || error" :loading="loading" :error="error" />
        <nav v-else>
          <div class="section-heading">
            <span>Channels</span
            ><button aria-label="Create channel" @click="channelForm = true">
              <Plus :size="13" />
            </button>
          </div>
          <button
            v-for="channel in regularChannels"
            :key="channel.id"
            :class="{ active: channelId === channel.id }"
            @click="channelId = channel.id"
          >
            <span class="symbol"
              ><LockKeyhole v-if="channel.isPrivate" :size="14" /><Hash v-else :size="14" /></span
            ><span
              ><strong>{{ channelName(channel) }}</strong></span
            ><b v-if="channel.unreadCount">{{ channel.unreadCount }}</b>
          </button>
          <p v-if="!regularChannels.length" class="channel-empty">No channels match.</p>
          <div class="channel-divider" />
          <div class="section-heading"><span>Direct messages</span></div>
          <button
            v-for="channel in directChannels"
            :key="channel.id"
            :class="{ active: channelId === channel.id }"
            @click="channelId = channel.id"
          >
            <span class="symbol"><Users :size="14" /></span
            ><span
              ><strong>{{ channelName(channel) }}</strong></span
            ><b v-if="channel.unreadCount">{{ channel.unreadCount }}</b>
          </button>
          <div v-if="!directChannels.length" class="dm-empty">
            <MessageSquare :size="24" />
            <span>No direct messages.</span>
          </div>
        </nav>
      </aside>
      <main class="transcript">
        <header v-if="current">
          <div class="channel-identity">
            <span class="identity-icon"
              ><Users v-if="current.isDM" :size="16" /><LockKeyhole
                v-else-if="current.isPrivate"
                :size="16" /><Hash v-else :size="16"
            /></span>
            <strong>{{ channelName(current) }}</strong>
            <i v-if="current.topic || current.description">·</i>
            <p>{{ current.topic || current.description }}</p>
          </div>
          <div class="channel-actions">
            <button class="members-button" aria-label="Members">
              <Users :size="16" /><span>{{ current.memberCount }}</span>
            </button>
            <button
              :class="{ active: current.muted }"
              :aria-label="current.muted ? 'Unmute' : 'Mute'"
              @click="toggleMute"
            >
              <BellOff :size="16" /></button
            ><button
              :class="{ active: utility === 'pins' }"
              aria-label="Pinned messages"
              @click="openUtility('pins')"
            >
              <Pin :size="16" /></button
            ><button
              :class="{ active: utility === 'saved' }"
              aria-label="Saved messages"
              @click="openUtility('saved')"
            >
              <Bookmark :size="16" /></button
            ><button
              aria-label="Search messages"
              @click="utility = utility === 'search' ? 'none' : 'search'"
            >
              <Search :size="16" />
            </button>
          </div>
        </header>
        <div v-else class="empty-conversation">
          <span><MessageSquare :size="24" /></span><strong>No conversation selected</strong>
          <p>Pick a channel on the left, or press ⌘K to jump to one.</p>
        </div>
        <DeliveryFieldState v-if="loadingMessages" loading />
        <div v-else class="messages" aria-live="polite">
          <div class="date-rule"><span>Latest dispatches</span></div>
          <CollaborationMessageRow
            v-for="message in messages"
            :key="message.id"
            :message="message"
            @thread="openThread"
            @react="react"
            @pin="pin"
            @save="save"
          /><DeliveryFieldState v-if="!messages.length" empty="No dispatches have been entered." />
        </div>
        <form class="composer" @submit.prevent="send()">
          <input ref="fileInput" class="sr-only" type="file" multiple @change="addFiles" />
          <button
            type="button"
            class="attach-button"
            :disabled="!current || uploading"
            aria-label="Attach a file"
            @click="fileInput?.click()"
          >
            <Paperclip :size="16" />
          </button>
          <textarea
            v-model="draft"
            :disabled="!current"
            rows="2"
            aria-label="Message"
            placeholder="Write a dispatch…"
            @keydown.ctrl.enter.prevent="send()"
          /><button
            class="button"
            :disabled="(!draft.trim() && !uploads.length) || uploading"
            aria-label="Send message"
          >
            <Send :size="16" /></button
          ><small>{{
            uploads.length ? `${uploads.length} attachment(s) ready` : 'Ctrl + Enter to send'
          }}</small>
        </form>
      </main>
      <aside v-if="threadParent || utility !== 'none'" class="side-panel">
        <header>
          <strong>{{
            threadParent
              ? 'Thread'
              : utility === 'pins'
                ? 'Pinned dispatches'
                : utility === 'saved'
                  ? 'Saved dispatches'
                  : 'Search transcript'
          }}</strong
          ><button
            aria-label="Close panel"
            @click="
              threadParent = null;
              utility = 'none';
            "
          >
            <X :size="16" />
          </button>
        </header>
        <template v-if="threadParent"
          ><CollaborationMessageRow
            :message="threadParent"
            @thread="() => {}"
            @react="react"
            @pin="pin"
            @save="save" />
          <div class="reply-rule">Replies · {{ threadReplies.length }}</div>
          <CollaborationMessageRow
            v-for="reply in threadReplies"
            :key="reply.id"
            :message="reply"
            @thread="() => {}"
            @react="react"
            @pin="pin"
            @save="save" />
          <form class="thread-compose" @submit.prevent="send(threadParent.id)">
            <textarea
              v-model="threadDraft"
              rows="2"
              aria-label="Thread reply"
              placeholder="Reply in thread…"
            /><button class="button" aria-label="Send reply">
              <Send :size="15" />
            </button></form></template
        ><template v-else
          ><form v-if="utility === 'search'" class="utility-search" @submit.prevent="search">
            <input v-model="searchQuery" aria-label="Search transcript" autofocus /><button
              class="button"
            >
              <Search :size="15" />
            </button>
          </form>
          <CollaborationMessageRow
            v-for="message in utilityMessages"
            :key="message.id"
            :message="message"
            @thread="openThread"
            @react="react"
            @pin="pin"
            @save="save" /><DeliveryFieldState
            v-if="utilityMessages.length === 0"
            empty="Nothing is filed here yet."
        /></template>
      </aside>
    </div>
    <CollaborationChannelForm
      :open="channelForm"
      @close="channelForm = false"
      @saved="loadChannels"
    />
  </section>
</template>

<style scoped>
.chat-page {
  display: flex;
  height: calc(100dvh - 4rem);
  flex-direction: column;
  margin: -1rem;
  overflow: hidden;
  background: var(--background);
}
.global-chat-bar {
  display: flex;
  height: 44px;
  flex: none;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 0 14px;
  background: var(--card);
  border-bottom: 1px solid var(--border-subtle);
}
.global-chat-bar button {
  display: inline-flex;
  min-height: 30px;
  align-items: center;
  gap: 6px;
  padding: 0 10px;
  color: var(--text-muted);
  background: transparent;
  border: 1px solid var(--border-subtle);
  border-radius: 8px;
  font-size: 12px;
  font-weight: 500;
  cursor: pointer;
}
.global-chat-bar button:hover {
  color: var(--foreground);
  background: var(--muted);
}
.jump-button {
  width: 230px;
}
.jump-button span {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.jump-button kbd {
  margin-left: auto;
  padding: 0 4px;
  background: var(--background);
  border: 1px solid var(--border-subtle);
  border-radius: 3px;
  font:
    10px 'IBM Plex Mono',
    monospace;
}
.chat-shell {
  display: flex;
  min-height: 0;
  flex: 1;
}
.channels {
  display: flex;
  width: 280px;
  flex: 0 0 280px;
  flex-direction: column;
  overflow: hidden;
  background: color-mix(in srgb, var(--card) 40%, transparent);
  border-right: 1px solid var(--border-subtle);
}
.channel-filter,
.side-panel > header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  height: 49px;
  flex: none;
  padding: 9px 12px;
  border-bottom: 1px solid var(--border-subtle);
}
.channel-filter label {
  display: flex;
  height: 28px;
  min-width: 0;
  flex: 1;
  align-items: center;
  gap: 6px;
  padding: 0 8px;
  color: var(--text-muted);
  background: color-mix(in srgb, var(--muted) 50%, transparent);
  border-radius: 7px;
}
.channel-filter input {
  min-width: 0;
  flex: 1;
  color: var(--foreground);
  background: transparent;
  border: 0;
  outline: 0;
  font-size: 12px;
}
.channels nav {
  flex: 1;
  overflow-y: auto;
  padding: 8px 0;
}
.section-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  min-height: 28px;
  padding: 4px 12px;
  color: color-mix(in srgb, var(--text-muted) 70%, transparent);
  font-size: 11px;
  font-weight: 650;
  text-transform: uppercase;
  letter-spacing: 0.08em;
}
.section-heading button {
  display: grid;
  width: 24px;
  height: 24px;
  place-items: center;
  color: var(--text-muted);
  background: transparent;
  border: 0;
  border-radius: 5px;
  cursor: pointer;
}
.section-heading button:hover {
  color: var(--foreground);
  background: var(--muted);
}
.channel-divider {
  height: 1px;
  margin: 8px 0;
  background: var(--border-subtle);
}
.channel-empty {
  padding: 8px 16px;
  color: color-mix(in srgb, var(--text-muted) 60%, transparent);
  font-size: 12px;
}
.dm-empty {
  padding: 12px 16px;
  color: color-mix(in srgb, var(--text-muted) 60%, transparent);
  text-align: center;
}
.dm-empty svg {
  margin: 0 auto;
  opacity: 0.35;
}
.dm-empty span {
  display: block;
  margin-top: 4px;
  font-size: 12px;
}
.channels nav > button {
  display: grid;
  width: calc(100% - 16px);
  min-height: 32px;
  grid-template-columns: 20px 1fr auto;
  align-items: center;
  gap: 6px;
  margin: 1px 8px;
  padding: 0 8px;
  color: var(--text-muted);
  text-align: left;
  background: transparent;
  border: 0;
  border-radius: 6px;
  cursor: pointer;
}
.channels nav > button:hover {
  color: var(--foreground);
  background: var(--muted);
}
.channels nav > button.active {
  color: var(--primary);
  background: color-mix(in srgb, var(--primary) 10%, transparent);
}
.channels nav strong {
  display: block;
  overflow: hidden;
  font-size: 13px;
  font-weight: 550;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.symbol {
  display: grid;
  place-items: center;
}
.channels nav b {
  display: grid;
  place-items: center;
  min-width: 18px;
  height: 18px;
  padding: 0 4px;
  color: white;
  background: var(--primary);
  border-radius: 9px;
  font-size: 10px;
}
.transcript {
  display: flex;
  min-width: 0;
  flex: 1;
  flex-direction: column;
  background: var(--background);
}
.transcript > header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  height: 56px;
  flex: none;
  padding: 0 16px;
  border-bottom: 1px solid var(--border-subtle);
}
.channel-identity {
  display: flex;
  min-width: 0;
  flex: 1;
  align-items: center;
  gap: 8px;
}
.channel-identity .identity-icon {
  display: grid;
  place-items: center;
  color: var(--text-muted);
}
.channel-identity strong {
  flex: none;
  color: var(--foreground);
  font-size: 14px;
  font-weight: 650;
}
.channel-identity i {
  color: color-mix(in srgb, var(--text-muted) 40%, transparent);
  font-style: normal;
}
.channel-identity p {
  min-width: 0;
  margin: 0;
  overflow: hidden;
  color: var(--text-muted);
  font-size: 12px;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.channel-actions {
  display: flex;
  flex: none;
  align-items: center;
  gap: 2px;
}
.channel-actions button,
.side-panel header button,
.mobile-close {
  display: inline-flex;
  min-width: 32px;
  height: 32px;
  align-items: center;
  justify-content: center;
  gap: 4px;
  color: var(--text-muted);
  background: transparent;
  border: 0;
  border-radius: 7px;
  cursor: pointer;
}
.channel-actions button:hover,
.side-panel header button:hover {
  color: var(--foreground);
  background: var(--muted);
}
.channel-actions button.active {
  opacity: 0.6;
}
.members-button {
  padding: 0 8px;
}
.members-button span {
  font-size: 12px;
  font-variant-numeric: tabular-nums;
}
.messages,
.side-panel {
  overflow-y: auto;
}
.messages {
  min-height: 0;
  flex: 1;
}
.date-rule {
  position: sticky;
  top: 8px;
  z-index: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  margin: 12px 0;
  color: var(--text-muted);
  font-size: 11px;
}
.date-rule span {
  padding: 2px 10px;
  background: var(--background);
  border: 1px solid var(--border-subtle);
  border-radius: 999px;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.04);
}
.empty-conversation {
  display: flex;
  min-height: 0;
  flex: 1;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 24px;
  color: var(--text-muted);
  text-align: center;
}
.empty-conversation > span {
  display: grid;
  width: 48px;
  height: 48px;
  place-items: center;
  margin-bottom: 12px;
  background: var(--muted);
  border-radius: 14px;
  opacity: 0.7;
}
.empty-conversation strong {
  color: var(--foreground);
  font-size: 14px;
}
.empty-conversation p {
  margin: 4px 0 0;
  font-size: 12px;
}
.composer,
.thread-compose {
  position: relative;
  display: grid;
  grid-template-columns: 1fr auto;
  gap: 8px;
  padding: 4px 16px 16px;
  background: var(--background);
}
.composer {
  grid-template-columns: auto 1fr auto;
}
.sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
}
.attach-button {
  width: 38px;
  color: var(--text-muted);
  background: var(--card);
  border: 1px solid var(--border-subtle);
  border-radius: 9px;
  cursor: pointer;
}
textarea {
  resize: none;
  padding: 10px;
  color: var(--foreground);
  background: var(--card);
  border: 1px solid var(--border);
  border-radius: 9px;
  font-size: 12px;
  outline: 0;
}
.composer textarea:focus,
.thread-compose textarea:focus {
  border-color: var(--primary);
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--primary) 15%, transparent);
}
.composer small {
  position: absolute;
  right: 72px;
  bottom: 7px;
  color: var(--text-muted);
  font-size: 8px;
}
.side-panel {
  width: 360px;
  flex: 0 0 360px;
  border-left: 1px solid var(--border-subtle);
  background: var(--card);
}
.reply-rule {
  padding: 12px;
  color: var(--primary);
  background: var(--muted);
  font:
    9px 'IBM Plex Mono',
    monospace;
  text-transform: uppercase;
}
.thread-compose {
  position: sticky;
  bottom: 0;
}
.utility-search {
  display: flex;
  gap: 6px;
  padding: 12px;
  border-bottom: 1px solid var(--border-subtle);
}
.utility-search input {
  min-width: 0;
  flex: 1;
  padding: 8px;
  border: 1px solid var(--border);
  border-radius: 8px;
}
.mobile-menu,
.mobile-close {
  display: none !important;
}
@media (max-width: 1050px) {
  .side-panel {
    position: fixed;
    z-index: 40;
    top: 76px;
    right: 0;
    width: min(390px, 90vw);
    height: calc(100vh - 76px);
    box-shadow: 0 18px 60px rgba(0, 0, 0, 0.2);
  }
}
@media (min-width: 640px) {
  .chat-page {
    height: calc(100vh - 8rem);
    margin: -1.5rem;
  }
}
@media (max-width: 760px) {
  .mobile-menu,
  .mobile-close {
    display: inline-flex !important;
  }
  .saved-button span,
  .jump-button kbd {
    display: none;
  }
  .jump-button {
    min-width: 0;
    flex: 1;
  }
  .channels {
    position: fixed;
    z-index: 50;
    inset: 76px auto 0 0;
    width: min(300px, 90vw);
    background: var(--card);
    transform: translateX(-101%);
    transition: 0.2s;
    box-shadow: 12px 0 30px rgba(0, 0, 0, 0.14);
  }
  .channels.open {
    transform: none;
  }
  .transcript {
    min-height: 0;
  }
  .channel-identity p,
  .members-button span {
    display: none;
  }
  .composer small {
    display: none;
  }
}
</style>
