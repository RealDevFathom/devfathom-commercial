<script setup lang="ts">
import {
  Bookmark,
  Check,
  Copy,
  MessageSquareText,
  MoreHorizontal,
  Pencil,
  Pin,
  SmilePlus,
  Trash2,
  X,
} from 'lucide-vue-next';
import type { Message } from '~/types/collaboration';

const props = defineProps<{ message: Message; grouped?: boolean }>();
const emit = defineEmits<{
  thread: [message: Message];
  react: [message: Message, emoji: string];
  pin: [message: Message];
  save: [message: Message];
  changed: [];
}>();
const chat = useChat();
const { user } = useAuth();
const editing = ref(false);
const editText = ref('');
const busy = ref(false);
const menuOpen = ref(false);
const copied = ref(false);
const isOwn = computed(() => props.message.sender.id === user.value?.id);
const canDelete = computed(() => isOwn.value || user.value?.role === 'ADMIN');
const format = (value: string) =>
  new Intl.DateTimeFormat('en', { hour: 'numeric', minute: '2-digit' }).format(new Date(value));

function beginEdit() {
  editText.value = props.message.content;
  editing.value = true;
  menuOpen.value = false;
}

async function saveEdit() {
  const value = editText.value.trim();
  if (!value || value === props.message.content) {
    editing.value = false;
    return;
  }
  busy.value = true;
  try {
    await chat.edit(props.message.id, value);
    editing.value = false;
    emit('changed');
  } finally {
    busy.value = false;
  }
}

async function removeMessage() {
  menuOpen.value = false;
  if (!confirm('Delete this message?')) return;
  busy.value = true;
  try {
    await chat.remove(props.message.id);
    emit('changed');
  } finally {
    busy.value = false;
  }
}

async function copyText() {
  await navigator.clipboard.writeText(props.message.content);
  copied.value = true;
  menuOpen.value = false;
  window.setTimeout(() => (copied.value = false), 1600);
}
</script>

<template>
  <article
    class="dispatch"
    :class="{ deleted: message.deletedAt, grouped }"
    :data-message-id="message.id"
  >
    <time class="time" :datetime="message.createdAt">{{ format(message.createdAt) }}</time>
    <div class="avatar" :title="message.sender.name">
      <img v-if="message.sender.avatar" :src="message.sender.avatar" :alt="message.sender.name" />
      <template v-else>{{ message.sender.name.slice(0, 2).toUpperCase() }}</template>
    </div>
    <div class="body">
      <header>
        <strong>{{ message.sender.name }}</strong>
        <span>{{ message.sender.title }}</span>
        <em v-if="message.isEdited">edited</em>
      </header>

      <form v-if="editing" class="edit-form" @submit.prevent="saveEdit">
        <textarea
          v-model="editText"
          rows="3"
          aria-label="Edit message"
          @keydown.escape.prevent="editing = false"
        />
        <div>
          <button type="button" @click="editing = false"><X :size="13" /> Cancel</button>
          <button type="submit" :disabled="busy || !editText.trim()">
            <Check :size="13" /> Save
          </button>
        </div>
      </form>
      <p v-else>{{ message.deletedAt ? 'Message deleted' : message.content }}</p>

      <a
        v-for="file in message.attachments"
        :key="file.id"
        :href="file.url"
        target="_blank"
        rel="noopener noreferrer"
      >
        {{ file.name }}
      </a>

      <div v-if="!message.deletedAt" class="reactions">
        <button
          v-for="reaction in message.reactions"
          :key="reaction.emoji"
          :class="{ mine: reaction.reactedByMe }"
          @click="emit('react', message, reaction.emoji)"
        >
          {{ reaction.emoji }} {{ reaction.count }}
        </button>
        <button aria-label="Add thumbs-up reaction" @click="emit('react', message, '👍')">
          <SmilePlus :size="13" />
        </button>
      </div>
      <button v-if="message.replyCount" class="thread-count" @click="emit('thread', message)">
        {{ message.replyCount }} {{ message.replyCount === 1 ? 'reply' : 'replies' }}
      </button>
    </div>

    <div v-if="!message.deletedAt" class="tools">
      <button aria-label="Reply in thread" @click="emit('thread', message)">
        <MessageSquareText :size="14" />
      </button>
      <button
        :aria-label="message.isPinned ? 'Unpin' : 'Pin'"
        :class="{ active: message.isPinned }"
        @click="emit('pin', message)"
      >
        <Pin :size="14" />
      </button>
      <button
        :aria-label="message.isSaved ? 'Remove from saved' : 'Save for later'"
        :class="{ active: message.isSaved }"
        @click="emit('save', message)"
      >
        <Bookmark :size="14" />
      </button>
      <div class="more">
        <button aria-label="More message actions" @click="menuOpen = !menuOpen">
          <MoreHorizontal :size="14" />
        </button>
        <div v-if="menuOpen" class="action-menu">
          <button v-if="isOwn" @click="beginEdit"><Pencil :size="13" /> Edit</button>
          <button @click="copyText"><Copy :size="13" /> Copy text</button>
          <button v-if="canDelete" class="danger" @click="removeMessage">
            <Trash2 :size="13" /> Delete
          </button>
        </div>
      </div>
    </div>
    <span v-if="copied" class="copied">Copied</span>
  </article>
</template>

<style scoped>
.dispatch {
  position: relative;
  display: grid;
  grid-template-columns: 36px minmax(0, 1fr) auto;
  grid-template-areas: 'avatar body time';
  gap: 12px;
  padding: 7px 18px;
  border-left: 2px solid transparent;
}
.dispatch:hover,
.dispatch:focus-within {
  background: color-mix(in srgb, var(--muted) 40%, transparent);
}
.dispatch.grouped {
  padding-top: 2px;
}
.dispatch.grouped .avatar,
.dispatch.grouped .body > header {
  visibility: hidden;
}
.dispatch.grouped:hover .time {
  opacity: 1;
}
.time {
  grid-area: time;
  padding-top: 3px;
  color: var(--text-muted);
  font-size: 10px;
  font-variant-numeric: tabular-nums;
  opacity: 0.75;
}
.avatar {
  grid-area: avatar;
  display: grid;
  width: 36px;
  height: 36px;
  overflow: hidden;
  place-items: center;
  color: var(--foreground);
  background: var(--secondary);
  border-radius: 50%;
  font-size: 10px;
  font-weight: 650;
}
.avatar img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}
.body {
  grid-area: body;
  min-width: 0;
}
.body header {
  display: flex;
  min-height: 20px;
  align-items: baseline;
  gap: 8px;
}
.body strong {
  color: var(--foreground);
  font-size: 14px;
  font-weight: 650;
}
.body header span,
.body header em {
  color: var(--text-muted);
  font-size: 11px;
  font-style: normal;
}
.body p {
  margin: 1px 0 6px;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  color: var(--foreground);
  font-size: 14px;
  line-height: 1.48;
}
.body > a {
  display: block;
  width: max-content;
  max-width: 100%;
  overflow: hidden;
  color: var(--primary);
  font-size: 11px;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.tools {
  position: absolute;
  z-index: 3;
  top: -12px;
  right: 14px;
  display: flex;
  align-items: center;
  gap: 1px;
  padding: 2px;
  background: var(--card);
  border: 1px solid var(--border-subtle);
  border-radius: 8px;
  box-shadow: 0 4px 14px rgba(0, 0, 0, 0.08);
  opacity: 0;
}
.dispatch:hover .tools,
.dispatch:focus-within .tools {
  opacity: 1;
}
.tools > button,
.more > button,
.reactions button,
.thread-count,
.edit-form button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 5px;
  padding: 5px;
  color: var(--text-muted);
  background: transparent;
  border: 0;
  border-radius: 5px;
  cursor: pointer;
}
.tools button:hover,
.tools .active {
  color: var(--primary);
  background: var(--secondary);
}
.more {
  position: relative;
}
.action-menu {
  position: absolute;
  z-index: 5;
  top: calc(100% + 5px);
  right: 0;
  width: 150px;
  padding: 4px;
  background: var(--card);
  border: 1px solid var(--border-subtle);
  border-radius: 9px;
  box-shadow: 0 14px 36px rgba(0, 0, 0, 0.14);
}
.action-menu button {
  display: flex;
  width: 100%;
  align-items: center;
  gap: 8px;
  padding: 8px;
  color: var(--foreground);
  text-align: left;
  background: transparent;
  border: 0;
  border-radius: 6px;
  font-size: 12px;
  cursor: pointer;
}
.action-menu button:hover {
  background: var(--secondary);
}
.action-menu .danger {
  color: #dc2626;
}
.reactions {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}
.reactions button {
  padding: 3px 7px;
  background: var(--card);
  border: 1px solid var(--border-subtle);
  border-radius: 999px;
  font-size: 10px;
}
.reactions .mine {
  color: var(--primary);
  border-color: color-mix(in srgb, var(--primary) 55%, var(--border));
  background: color-mix(in srgb, var(--primary) 8%, var(--card));
}
.thread-count {
  margin-top: 4px;
  padding-left: 0;
  color: var(--primary);
  font-size: 10px;
  font-weight: 650;
}
.edit-form {
  display: grid;
  gap: 6px;
  margin: 2px 0 6px;
}
.edit-form textarea {
  min-height: 74px;
  resize: vertical;
  padding: 9px 10px;
  color: var(--foreground);
  background: var(--card);
  border: 1px solid var(--primary);
  border-radius: 8px;
  outline: 0;
  font: inherit;
}
.edit-form > div {
  display: flex;
  justify-content: flex-end;
  gap: 4px;
}
.edit-form button[type='submit'] {
  color: white;
  background: var(--primary);
}
.copied {
  position: absolute;
  z-index: 4;
  right: 18px;
  bottom: -14px;
  padding: 3px 7px;
  color: white;
  background: var(--foreground);
  border-radius: 5px;
  font-size: 9px;
}
.deleted {
  opacity: 0.62;
  font-style: italic;
}
@media (max-width: 620px) {
  .dispatch {
    grid-template-columns: 32px minmax(0, 1fr);
    grid-template-areas: 'avatar body';
    padding: 7px 10px;
  }
  .time {
    display: none;
  }
  .tools {
    position: static;
    grid-column: 2;
    grid-row: 2;
    width: max-content;
    margin-top: 4px;
    box-shadow: none;
    opacity: 1;
  }
  .avatar {
    width: 32px;
    height: 32px;
  }
  .dispatch.grouped .avatar,
  .dispatch.grouped .body > header {
    display: none;
  }
  .action-menu {
    right: auto;
    left: 0;
  }
}
</style>
