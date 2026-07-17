<script setup lang="ts">
import { Bookmark, MessageSquareText, MoreHorizontal, Pin, SmilePlus } from 'lucide-vue-next';
import type { Message } from '~/types/collaboration';
defineProps<{ message: Message }>();
const emit = defineEmits<{
  thread: [message: Message];
  react: [message: Message, emoji: string];
  pin: [message: Message];
  save: [message: Message];
}>();
const format = (value: string) =>
  new Intl.DateTimeFormat('en', { hour: 'numeric', minute: '2-digit' }).format(new Date(value));
</script>
<template>
  <article class="dispatch" :class="{ deleted: message.deletedAt }">
    <div class="time">{{ format(message.createdAt) }}</div>
    <div class="avatar">{{ message.sender.name.slice(0, 2).toUpperCase() }}</div>
    <div class="body">
      <header>
        <strong>{{ message.sender.name }}</strong
        ><span>{{ message.sender.title }}</span
        ><em v-if="message.isEdited">revised</em>
      </header>
      <p>{{ message.deletedAt ? 'Message withdrawn' : message.content }}</p>
      <a
        v-for="file in message.attachments"
        :key="file.id"
        :href="file.url"
        target="_blank"
        rel="noopener noreferrer"
        >{{ file.name }}</a
      >
      <div class="reactions">
        <button
          v-for="reaction in message.reactions"
          :key="reaction.emoji"
          :class="{ mine: reaction.reactedByMe }"
          @click="emit('react', message, reaction.emoji)"
        >
          {{ reaction.emoji }} {{ reaction.count }}</button
        ><button aria-label="Add reaction" @click="emit('react', message, '👍')">
          <SmilePlus :size="13" />
        </button>
      </div>
      <button v-if="message.replyCount" class="thread-count" @click="emit('thread', message)">
        {{ message.replyCount }} {{ message.replyCount === 1 ? 'reply' : 'replies' }}
      </button>
    </div>
    <div class="tools">
      <button aria-label="Open thread" @click="emit('thread', message)">
        <MessageSquareText :size="14" /></button
      ><button
        :aria-label="message.isPinned ? 'Unpin' : 'Pin'"
        :class="{ active: message.isPinned }"
        @click="emit('pin', message)"
      >
        <Pin :size="14" /></button
      ><button
        :aria-label="message.isSaved ? 'Unsave' : 'Save'"
        :class="{ active: message.isSaved }"
        @click="emit('save', message)"
      >
        <Bookmark :size="14" /></button
      ><MoreHorizontal :size="14" />
    </div>
  </article>
</template>
<style scoped>
.dispatch {
  position: relative;
  display: grid;
  grid-template-columns: 36px minmax(0, 1fr) auto;
  grid-template-areas: 'avatar body time';
  gap: 12px;
  margin-top: 12px;
  padding: 4px 16px;
  border-left: 2px solid transparent;
  border-radius: 6px;
}
.dispatch:hover {
  background: color-mix(in srgb, var(--muted) 40%, transparent);
}
.time {
  grid-area: time;
  padding-top: 3px;
  color: var(--text-muted);
  font-size: 11px;
  font-variant-numeric: tabular-nums;
}
.avatar {
  grid-area: avatar;
  display: grid;
  place-items: center;
  width: 36px;
  height: 36px;
  color: var(--foreground);
  background: var(--secondary);
  font:
    500 10px 'Instrument Sans',
    sans-serif;
  border-radius: 50%;
}
.body {
  grid-area: body;
  min-width: 0;
}
.body header {
  display: flex;
  align-items: baseline;
  gap: 8px;
}
.body strong {
  color: var(--foreground);
  font:
    600 14px 'Instrument Sans',
    sans-serif;
}
.body header span,
.body header em {
  color: var(--text-muted);
  font-size: 11px;
  font-style: normal;
}
.body p {
  margin: 2px 0 7px;
  white-space: pre-wrap;
  color: var(--foreground);
  font-size: 14px;
  line-height: 1.45;
}
.body > a {
  display: block;
  color: var(--primary);
  font-size: 11px;
}
.tools {
  position: absolute;
  top: -13px;
  right: 14px;
  display: flex;
  align-items: center;
  gap: 1px;
  padding: 2px;
  background: var(--card);
  border: 1px solid var(--border-subtle);
  border-radius: 7px;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.06);
  opacity: 0;
}
.dispatch:hover .tools,
.tools:focus-within {
  opacity: 1;
}
.tools button,
.reactions button,
.thread-count {
  padding: 4px;
  color: var(--text-muted);
  background: transparent;
  border: 0;
  cursor: pointer;
}
.tools .active {
  color: var(--primary);
}
.reactions {
  display: flex;
  gap: 4px;
}
.reactions button {
  padding: 3px 6px;
  background: var(--card);
  border: 1px solid var(--border-subtle);
  border-radius: 12px;
  font-size: 10px;
}
.reactions .mine {
  color: var(--primary);
  border-color: var(--primary);
}
.thread-count {
  margin-top: 5px;
  color: var(--primary);
  font-size: 10px;
}
.deleted {
  opacity: 0.65;
  font-style: italic;
}
@media (max-width: 620px) {
  .dispatch {
    grid-template-columns: 32px 1fr;
    grid-template-areas: 'avatar body';
    padding-right: 8px;
  }
  .time {
    display: none;
  }
  .tools {
    position: static;
    grid-column: 2;
    grid-row: 2;
    width: max-content;
    box-shadow: none;
    opacity: 1;
  }
  .avatar {
    width: 32px;
    height: 32px;
  }
}
</style>
