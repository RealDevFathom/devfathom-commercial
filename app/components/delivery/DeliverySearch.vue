<script setup lang="ts">
import { FileText, FolderKanban, Search, SquareCheckBig, UserRound } from 'lucide-vue-next';
import type { SearchGroups } from '~/types/delivery';

const delivery = useDelivery();
const query = ref('');
const loading = ref(false);
const error = ref('');
const results = ref<SearchGroups | null>(null);
let timer: ReturnType<typeof setTimeout> | undefined;

watch(query, (value) => {
  clearTimeout(timer);
  if (value.trim().length < 2) {
    results.value = null;
    return;
  }
  timer = setTimeout(run, 240);
});
onBeforeUnmount(() => clearTimeout(timer));

async function run() {
  loading.value = true;
  error.value = '';
  try {
    results.value = await delivery.search(query.value);
  } catch (caught: any) {
    error.value = caught?.data?.detail || 'Search is unavailable.';
  } finally {
    loading.value = false;
  }
}

const total = computed(() =>
  results.value ? Object.values(results.value).reduce((sum, group) => sum + group.length, 0) : 0
);
</script>

<template>
  <section class="search-ledger" aria-label="Delivery search">
    <label>
      <Search :size="17" />
      <input v-model="query" placeholder="Find a project, task, client, note, or teammate" />
      <span>{{ loading ? 'Reading…' : 'Delivery index' }}</span>
    </label>
    <p v-if="error" class="search-error">{{ error }}</p>
    <div v-if="results" class="search-results">
      <p v-if="!total" class="no-results">No matching records.</p>
      <div v-if="results.projects.length">
        <h3>Projects</h3>
        <NuxtLink v-for="item in results.projects" :key="item.id" :to="`/projects/${item.id}`">
          <FolderKanban :size="15" /><span>{{ item.name }}</span
          ><small>{{ item.status }}</small>
        </NuxtLink>
      </div>
      <div v-if="results.tasks.length">
        <h3>Tasks</h3>
        <NuxtLink
          v-for="item in results.tasks"
          :key="item.id"
          :to="`/projects/${item.column?.board.projectId}/board/${item.column?.board.id}?task=${item.id}`"
        >
          <SquareCheckBig :size="15" /><span>{{ item.title }}</span
          ><small>{{ item.priority }}</small>
        </NuxtLink>
      </div>
      <div v-if="results.clients.length">
        <h3>Clients</h3>
        <NuxtLink v-for="item in results.clients" :key="item.id" :to="`/clients/${item.id}`">
          <UserRound :size="15" /><span>{{ item.name }}</span
          ><small>{{ item.industry || 'Client' }}</small>
        </NuxtLink>
      </div>
      <div v-if="results.notes.length">
        <h3>Notes</h3>
        <NuxtLink v-for="item in results.notes" :key="item.id" :to="`/notes/${item.id}`">
          <FileText :size="15" /><span>{{ item.title }}</span
          ><small>{{ item.visibility }}</small>
        </NuxtLink>
      </div>
      <div v-if="results.team.length">
        <h3>People</h3>
        <NuxtLink v-for="item in results.team" :key="item.id" :to="`/team/${item.id}`">
          <UserRound :size="15" /><span>{{ item.name }}</span
          ><small>{{ item.title || 'Team' }}</small>
        </NuxtLink>
      </div>
    </div>
  </section>
</template>

<style scoped>
.search-ledger {
  position: relative;
  margin-bottom: 18px;
}
label {
  display: grid;
  grid-template-columns: auto 1fr auto;
  align-items: center;
  gap: 12px;
  min-height: 52px;
  padding: 0 16px;
  color: var(--muted);
  background: var(--paper);
  border: 1px solid var(--border);
}
input {
  min-width: 0;
  color: var(--text);
  background: transparent;
  border: 0;
  outline: 0;
  font-size: 13px;
}
label span,
h3,
small {
  font-family: 'IBM Plex Mono', monospace;
  font-size: 9px;
  text-transform: uppercase;
  letter-spacing: 0.08em;
}
.search-results {
  position: absolute;
  z-index: 10;
  top: calc(100% + 5px);
  left: 0;
  right: 0;
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(210px, 1fr));
  max-height: 480px;
  overflow: auto;
  padding: 14px;
  background: var(--paper);
  border: 1px solid var(--border);
  box-shadow: var(--shadow);
}
h3 {
  margin: 7px 9px;
  color: var(--clay-500);
}
a {
  display: grid;
  grid-template-columns: 18px 1fr auto;
  gap: 8px;
  align-items: center;
  padding: 9px;
  border-top: 1px solid var(--border);
  font-size: 12px;
}
a:hover,
a:focus-visible {
  background: var(--linen);
  outline: 0;
}
small {
  color: var(--muted);
  letter-spacing: 0;
}
.search-error,
.no-results {
  margin: 8px 0 0;
  color: var(--clay-600);
  font-size: 11px;
}
.no-results {
  grid-column: 1 / -1;
  padding: 18px;
  color: var(--muted);
}
@media (max-width: 600px) {
  label span {
    display: none;
  }
}
</style>
