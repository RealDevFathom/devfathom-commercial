<script setup lang="ts">
import { LoaderCircle, MessageSquare, Search } from 'lucide-vue-next';
import type { Person } from '~/types/collaboration';

const props = defineProps<{ open: boolean }>();
const emit = defineEmits<{ close: []; created: [channelId: string] }>();
const collaboration = useCollaboration();
const chat = useChat();
const { user } = useAuth();
const query = ref('');
const people = ref<Person[]>([]);
const loading = ref(false);
const openingId = ref<string | null>(null);
const error = ref('');
let timer: ReturnType<typeof setTimeout> | undefined;

watch(
  () => props.open,
  (open) => {
    if (open) return;
    clearTimeout(timer);
    query.value = '';
    people.value = [];
    error.value = '';
    openingId.value = null;
  }
);

watch(query, (value) => {
  clearTimeout(timer);
  error.value = '';
  const term = value.trim();
  if (term.length < 2) {
    people.value = [];
    loading.value = false;
    return;
  }
  timer = setTimeout(async () => {
    loading.value = true;
    try {
      people.value = (await collaboration.people(term)).filter(
        (person) => person.id !== user.value?.id
      );
    } catch (caught: any) {
      error.value = caught?.data?.detail || 'Teammates could not be searched.';
    } finally {
      loading.value = false;
    }
  }, 220);
});

async function openConversation(person: Person) {
  if (openingId.value) return;
  openingId.value = person.id;
  error.value = '';
  try {
    const channel = await chat.directMessage(person.id);
    emit('created', channel.id);
    emit('close');
  } catch (caught: any) {
    error.value = caught?.data?.detail || 'The direct message could not be opened.';
    openingId.value = null;
  }
}
</script>

<template>
  <DeliveryFieldDialog
    :open="open"
    title="New direct message"
    description="Find a teammate and open your shared conversation."
    @close="emit('close')"
  >
    <div class="dm-dialog">
      <label class="search-field">
        <Search :size="15" />
        <input v-model="query" autofocus placeholder="Find a teammate…" />
        <LoaderCircle v-if="loading" class="spin" :size="15" />
      </label>

      <p v-if="error" class="error" role="alert">{{ error }}</p>

      <div class="people" aria-live="polite">
        <button
          v-for="person in people"
          :key="person.id"
          type="button"
          :disabled="Boolean(openingId)"
          @click="openConversation(person)"
        >
          <span class="avatar">
            <img v-if="person.avatar" :src="person.avatar" :alt="person.name" />
            <template v-else>{{ person.name.slice(0, 2).toUpperCase() }}</template>
          </span>
          <span class="identity">
            <strong>{{ person.name }}</strong>
            <small>{{ person.title || 'Team member' }}</small>
          </span>
          <LoaderCircle v-if="openingId === person.id" class="spin" :size="16" />
          <MessageSquare v-else :size="16" />
        </button>

        <div v-if="query.trim().length < 2" class="empty">
          <Search :size="22" />
          <span>Type at least two characters to find someone.</span>
        </div>
        <div v-else-if="!loading && !people.length && !error" class="empty">
          <MessageSquare :size="22" />
          <span>No teammates match that search.</span>
        </div>
      </div>
    </div>
  </DeliveryFieldDialog>
</template>

<style scoped>
.dm-dialog {
  display: grid;
  gap: 12px;
}
.search-field {
  display: flex;
  min-height: 42px;
  align-items: center;
  gap: 9px;
  padding: 0 12px;
  color: var(--text-muted);
  background: var(--background);
  border: 1px solid var(--border);
  border-radius: 10px;
}
.search-field:focus-within {
  border-color: var(--primary);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--primary) 12%, transparent);
}
.search-field input {
  min-width: 0;
  flex: 1;
  color: var(--foreground);
  background: transparent;
  border: 0;
  outline: 0;
  font-size: 13px;
}
.people {
  max-height: 320px;
  overflow-y: auto;
  border: 1px solid var(--border-subtle);
  border-radius: 12px;
}
.people > button {
  display: flex;
  width: 100%;
  min-height: 56px;
  align-items: center;
  gap: 11px;
  padding: 8px 10px;
  color: var(--text-muted);
  text-align: left;
  background: transparent;
  border: 0;
  border-bottom: 1px solid var(--border-subtle);
  cursor: pointer;
}
.people > button:last-of-type {
  border-bottom: 0;
}
.people > button:hover:not(:disabled) {
  color: var(--primary);
  background: var(--secondary);
}
.people > button:disabled {
  cursor: wait;
  opacity: 0.65;
}
.avatar {
  display: grid;
  width: 36px;
  height: 36px;
  flex: none;
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
.identity {
  min-width: 0;
  flex: 1;
}
.identity strong,
.identity small {
  display: block;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.identity strong {
  color: var(--foreground);
  font-size: 13px;
}
.identity small,
.empty {
  color: var(--text-muted);
  font-size: 11px;
}
.empty {
  display: flex;
  min-height: 128px;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 18px;
  text-align: center;
}
.empty svg {
  opacity: 0.35;
}
.error {
  margin: 0;
  color: #dc2626;
  font-size: 12px;
}
.spin {
  animation: spin 0.9s linear infinite;
}
@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}
</style>
