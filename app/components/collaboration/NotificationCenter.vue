<script setup lang="ts">
import { Bell, CheckCheck, Settings2, X } from 'lucide-vue-next';
import type { NotificationItem, NotificationPreferences } from '~/types/collaboration';
const api = useCollaboration();
const open = ref(false);
const view = ref<'inbox' | 'preferences'>('inbox');
const items = ref<NotificationItem[]>([]);
const prefs = ref<NotificationPreferences>({});
const loading = ref(false);
const categories = [
  'task',
  'mention',
  'meeting',
  'leave',
  'invoice',
  'project',
  'client',
  'resignation',
  'note',
] as const;
const unread = computed(() => items.value.filter((item) => !item.isRead).length);
async function load() {
  loading.value = true;
  try {
    items.value = await api.notifications();
    prefs.value = (await api.preferences()) || {};
  } finally {
    loading.value = false;
  }
}
async function show() {
  open.value = true;
  await load();
}
async function mark(item: NotificationItem) {
  if (!item.isRead) {
    await api.markRead(item.id);
    item.isRead = true;
  }
}
async function markAll() {
  await api.markAllRead();
  items.value.forEach((item) => (item.isRead = true));
}
async function save() {
  await api.savePreferences(prefs.value);
  view.value = 'inbox';
}
function ensure(category: (typeof categories)[number]) {
  prefs.value[category] ||= { inApp: true, email: false };
  return prefs.value[category]!;
}
const date = (value: string) =>
  new Intl.DateTimeFormat('en', { dateStyle: 'medium', timeStyle: 'short' }).format(
    new Date(value)
  );
</script>
<template>
  <div>
    <button class="bell" aria-label="Open notifications" @click="show">
      <Bell :size="17" /><b v-if="unread">{{ unread }}</b></button
    ><Teleport to="body"
      ><div v-if="open" class="scrim" @mousedown.self="open = false">
        <aside role="dialog" aria-modal="true" aria-label="Notifications">
          <header>
            <div>
              <span>Signal desk</span>
              <h2>{{ view === 'inbox' ? 'Notifications' : 'Preferences' }}</h2>
            </div>
            <div>
              <button v-if="view === 'inbox'" aria-label="Mark all read" @click="markAll">
                <CheckCheck :size="17" /></button
              ><button
                aria-label="Notification settings"
                @click="view = view === 'inbox' ? 'preferences' : 'inbox'"
              >
                <Settings2 :size="17" /></button
              ><button aria-label="Close" @click="open = false"><X :size="17" /></button>
            </div>
          </header>
          <DeliveryFieldState v-if="loading" loading />
          <div v-else-if="view === 'inbox'" class="inbox">
            <article
              v-for="item in items"
              :key="item.id"
              :class="{ unread: !item.isRead }"
              tabindex="0"
              @click="mark(item)"
              @keydown.enter="mark(item)"
            >
              <i />
              <div>
                <strong>{{ item.title }}</strong>
                <p>{{ item.message }}</p>
                <small>{{ date(item.createdAt) }}</small>
              </div>
            </article>
            <DeliveryFieldState v-if="!items.length" empty="No new signals." />
          </div>
          <form v-else class="preferences" @submit.prevent="save">
            <div v-for="category in categories" :key="category">
              <strong>{{ category }}</strong
              ><label><input v-model="ensure(category).inApp" type="checkbox" /> In app</label
              ><label><input v-model="ensure(category).email" type="checkbox" /> Email</label>
            </div>
            <button class="button">Save preferences</button>
          </form>
        </aside>
      </div></Teleport
    >
  </div>
</template>
<style scoped>
.bell {
  position: relative;
  display: grid;
  place-items: center;
  width: 38px;
  height: 38px;
  color: var(--text);
  background: var(--paper);
  border: 1px solid var(--border);
  cursor: pointer;
}
.bell b {
  position: absolute;
  top: -5px;
  right: -5px;
  display: grid;
  place-items: center;
  min-width: 18px;
  height: 18px;
  color: white;
  background: var(--clay-500);
  border-radius: 10px;
  font-size: 9px;
}
.scrim {
  position: fixed;
  z-index: 90;
  inset: 0;
  background: rgba(28, 35, 29, 0.45);
}
aside {
  position: absolute;
  right: 0;
  top: 0;
  width: min(440px, 100%);
  height: 100%;
  overflow-y: auto;
  background: var(--paper);
  box-shadow: -20px 0 70px rgba(0, 0, 0, 0.16);
}
header {
  position: sticky;
  top: 0;
  z-index: 2;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 20px;
  border-bottom: 1px solid var(--border);
  background: var(--paper);
}
header span {
  color: var(--clay-500);
  font:
    9px 'IBM Plex Mono',
    monospace;
  text-transform: uppercase;
}
h2 {
  margin: 2px 0;
  font-size: 26px;
}
header > div:last-child {
  display: flex;
}
header button {
  display: grid;
  place-items: center;
  width: 34px;
  height: 34px;
  color: var(--muted);
  background: transparent;
  border: 1px solid var(--border);
  cursor: pointer;
}
.inbox article {
  display: grid;
  grid-template-columns: 9px 1fr;
  gap: 10px;
  padding: 15px 20px;
  border-bottom: 1px solid var(--border);
  cursor: pointer;
}
.inbox article:hover,
.inbox article:focus-visible {
  background: var(--linen);
  outline: 0;
}
.inbox i {
  width: 7px;
  height: 7px;
  margin-top: 5px;
  background: transparent;
  border-radius: 50%;
}
.inbox .unread i {
  background: var(--clay-500);
}
.inbox strong {
  font-size: 12px;
}
.inbox p {
  margin: 4px 0;
  color: var(--muted);
  font-size: 11px;
  line-height: 1.5;
}
.inbox small {
  color: var(--muted);
  font:
    8px 'IBM Plex Mono',
    monospace;
}
.preferences {
  display: grid;
}
.preferences > div {
  display: grid;
  grid-template-columns: 1fr 90px 80px;
  align-items: center;
  min-height: 52px;
  padding: 0 20px;
  border-bottom: 1px solid var(--border);
  text-transform: capitalize;
}
.preferences strong {
  font:
    500 10px 'IBM Plex Mono',
    monospace;
}
.preferences label {
  display: flex;
  gap: 6px;
  color: var(--muted);
  font-size: 10px;
}
.preferences > .button {
  margin: 20px;
  justify-self: end;
}
</style>
