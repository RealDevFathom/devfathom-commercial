<script setup lang="ts">
import { Search, X } from 'lucide-vue-next';
import type { CollaborationSearch } from '~/types/collaboration';

const collaboration = useCollaboration();
const query = ref('');
const results = ref<CollaborationSearch | null>(null);
const loading = ref(false);
let timer: ReturnType<typeof setTimeout> | undefined;
watch(query, (value) => {
  clearTimeout(timer);
  if (value.trim().length < 2) {
    results.value = null;
    return;
  }
  timer = setTimeout(async () => {
    loading.value = true;
    try {
      results.value = await collaboration.search(value);
    } finally {
      loading.value = false;
    }
  }, 250);
});
</script>

<template>
  <div class="search-register">
    <Search :size="17" /><input
      v-model="query"
      aria-label="Search collaboration records"
      placeholder="Search notes, messages, meetings, people…"
    />
    <button v-if="query" aria-label="Clear search" @click="query = ''"><X :size="15" /></button>
    <span v-if="loading">Indexing…</span>
    <div v-if="results" class="results">
      <section>
        <h3>Notes</h3>
        <NuxtLink v-for="item in results.notes" :key="item.id" :to="`/notes/${item.id}`">{{
          item.title
        }}</NuxtLink
        ><small v-if="!results.notes.length">No notes</small>
      </section>
      <section>
        <h3>Meetings</h3>
        <NuxtLink v-for="item in results.meetings" :key="item.id" :to="`/meetings/${item.id}`">{{
          item.title
        }}</NuxtLink
        ><small v-if="!results.meetings.length">No meetings</small>
      </section>
      <section>
        <h3>People</h3>
        <span v-for="item in results.team" :key="item.id"
          >{{ item.name }} · {{ item.title || 'Team' }}</span
        ><small v-if="!results.team.length">No people</small>
      </section>
    </div>
  </div>
</template>

<style scoped>
.search-register {
  position: relative;
  display: flex;
  align-items: center;
  gap: 10px;
  min-height: 48px;
  margin-bottom: 18px;
  padding: 0 14px;
  background: var(--paper);
  border: 1px solid var(--border);
}
input {
  flex: 1;
  min-width: 0;
  color: var(--text);
  background: transparent;
  border: 0;
  outline: 0;
}
button {
  display: grid;
  place-items: center;
  background: transparent;
  border: 0;
  cursor: pointer;
}
.search-register > span {
  color: var(--muted);
  font:
    9px 'IBM Plex Mono',
    monospace;
  text-transform: uppercase;
}
.results {
  position: absolute;
  z-index: 20;
  top: calc(100% + 5px);
  left: 0;
  right: 0;
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  padding: 14px;
  background: var(--paper);
  border: 1px solid var(--border);
  box-shadow: var(--shadow);
}
section {
  display: grid;
  align-content: start;
  gap: 8px;
  min-width: 0;
  padding: 4px 14px 12px;
  border-right: 1px solid var(--border);
}
section:last-child {
  border: 0;
}
h3 {
  margin: 0 0 4px;
  font:
    500 9px 'IBM Plex Mono',
    monospace;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  color: var(--clay-500);
}
a,
section span,
small {
  overflow: hidden;
  color: var(--muted);
  font-size: 12px;
  text-overflow: ellipsis;
  white-space: nowrap;
}
a:hover {
  color: var(--clay-500);
}
@media (max-width: 720px) {
  .results {
    grid-template-columns: 1fr;
  }
  section {
    border: 0;
    border-bottom: 1px solid var(--border);
  }
}
</style>
