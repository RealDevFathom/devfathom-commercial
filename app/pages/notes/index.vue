<script setup lang="ts">
import {
  AtSign,
  FileText,
  Globe2,
  Loader2,
  LockKeyhole,
  Plus,
  Search,
  Users,
} from 'lucide-vue-next';
import type { NoteSummary } from '~/types/collaboration';

useHead({ title: 'Notes · DevFathom Hub' });
const api = useNotes();
const { user } = useAuth();
const router = useRouter();
const notes = ref<NoteSummary[]>([]);
const scope = ref<'all' | 'mine' | 'shared' | 'mentions'>('all');
const search = ref('');
const loading = ref(true);
const error = ref('');
const creating = ref(false);

const scopeLabels = { all: 'All', mine: 'My notes', shared: 'Shared', mentions: 'Mentions' };
const visibilityLabels = { PRIVATE: 'Private', SHARED: 'Shared', TEAM: 'Team' } as const;

async function load() {
  loading.value = true;
  error.value = '';
  try {
    notes.value =
      scope.value === 'mentions'
        ? await api.mentions()
        : await api.list({ scope: scope.value, search: search.value || undefined });
  } catch (caught: any) {
    error.value = caught?.data?.detail || 'The note index is unavailable.';
  } finally {
    loading.value = false;
  }
}
await load();
watch(scope, load);
let timer: ReturnType<typeof setTimeout> | undefined;
watch(search, () => {
  if (timer) clearTimeout(timer);
  timer = setTimeout(load, 200);
});
onBeforeUnmount(() => timer && clearTimeout(timer));

function relativeDate(value?: string) {
  if (!value) return 'Unrecorded';
  const days = Math.max(0, Math.floor((Date.now() - new Date(value).getTime()) / 86_400_000));
  if (days === 0) return 'Today';
  if (days === 1) return 'Yesterday';
  if (days < 7) return `${days} days ago`;
  return new Intl.DateTimeFormat('en', { month: 'short', day: 'numeric' }).format(new Date(value));
}

async function handleCreate() {
  creating.value = true;
  try {
    const created = await api.create({
      title: 'Untitled',
      contentJson: { type: 'doc', content: [] },
      visibility: 'PRIVATE',
    });
    await router.push(`/notes/${created.id}`);
  } finally {
    creating.value = false;
  }
}
</script>

<template>
  <section class="core-route animate-fade-in space-y-6">
    <PageHeader
      eyebrow="Knowledge"
      title="Notes"
      description="Capture decisions, connect context, and share working knowledge."
    >
      <button class="studio-primary-button" :disabled="creating" @click="handleCreate">
        <Loader2 v-if="creating" :size="16" class="animate-spin" />
        <Plus v-else :size="16" /> New Note
      </button>
    </PageHeader>

    <div class="grid grid-cols-1 gap-5 lg:grid-cols-[320px_minmax(0,1fr)]">
      <aside class="notes-index-panel space-y-3">
        <nav class="flex flex-wrap items-center gap-1.5" aria-label="Note filters">
          <button
            v-for="item in ['all', 'mine', 'shared', 'mentions'] as const"
            :key="item"
            class="flex items-center gap-1 rounded-lg px-2.5 py-1 text-xs font-medium transition-colors"
            :class="
              scope === item
                ? 'bg-primary/10 text-primary'
                : 'text-text-muted hover:bg-secondary hover:text-foreground'
            "
            @click="scope = item"
          >
            <AtSign v-if="item === 'mentions'" :size="12" />{{ scopeLabels[item] }}
          </button>
        </nav>
        <label class="relative block"
          ><Search
            :size="14"
            class="absolute left-2.5 top-1/2 -translate-y-1/2 text-text-muted" /><input
            v-model="search"
            placeholder="Search notes…"
            class="h-9 w-full rounded-xl border border-border bg-card pl-8 pr-3 text-xs text-foreground outline-none focus:border-primary focus:ring-2 focus:ring-primary/20"
        /></label>

        <DeliveryFieldState
          v-if="loading || error"
          :loading="loading"
          :error="error"
          action="Try again"
          @action="load"
        />
        <div
          v-else-if="!notes.length"
          class="rounded-xl border border-dashed border-border p-6 text-center"
        >
          <FileText :size="32" class="mx-auto text-text-faint/30" />
          <p class="mt-2 text-xs text-text-muted">
            {{ scope === 'mentions' ? 'No notes mention you yet' : 'No notes yet' }}
          </p>
          <button
            v-if="scope !== 'mentions'"
            class="mt-3 inline-flex items-center gap-1 rounded-lg bg-primary px-3 py-1.5 text-xs font-semibold text-white hover:bg-[#0C2E2C] disabled:opacity-50"
            :disabled="creating"
            @click="handleCreate"
          >
            <Plus :size="12" /> New note
          </button>
        </div>
        <div v-else class="space-y-1.5">
          <NuxtLink
            v-for="note in notes"
            :key="note.id"
            :to="`/notes/${note.id}`"
            class="block rounded-xl border border-border/60 bg-card px-3 py-2.5 transition-all hover:border-border hover:shadow-sm"
          >
            <div class="flex items-start justify-between gap-2">
              <h2 class="truncate text-sm font-medium text-foreground">
                {{ note.title || 'Untitled' }}
              </h2>
              <span
                class="inline-flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-[10px] font-medium"
                :class="{
                  'bg-muted text-text-muted': note.visibility === 'PRIVATE',
                  'bg-blue-500/10 text-blue-500': note.visibility === 'SHARED',
                  'bg-emerald-500/10 text-emerald-500': note.visibility === 'TEAM',
                }"
                ><LockKeyhole v-if="note.visibility === 'PRIVATE'" :size="10" /><Users
                  v-else-if="note.visibility === 'SHARED'"
                  :size="10"
                /><Globe2 v-else :size="10" />{{ visibilityLabels[note.visibility] }}</span
              >
            </div>
            <footer class="mt-1 flex items-center gap-2 text-[11px] text-text-muted">
              <span
                class="grid h-3.5 w-3.5 shrink-0 place-items-center overflow-hidden rounded-full bg-secondary text-[7px] font-medium"
              >
                <img
                  v-if="note.author?.avatar"
                  :src="note.author.avatar"
                  :alt="note.author.name"
                  class="h-full w-full object-cover"
                />
                <template v-else>{{ note.author?.name?.[0] || '?' }}</template>
              </span>
              <span>{{ note.authorId === user?.id ? 'You' : note.author?.name || 'Unknown' }}</span>
              <span>·</span><time>{{ relativeDate(note.updatedAt) }}</time>
            </footer>
          </NuxtLink>
        </div>
      </aside>

      <section class="note-canvas min-w-0">
        <div class="flex min-h-[520px] flex-col items-center justify-center p-8 text-center">
          <FileText :size="48" class="text-text-faint/20" />
          <h2 class="mt-4 text-lg font-semibold text-foreground">Select a note</h2>
          <p class="mt-1 text-sm text-text-muted">
            Pick one from the list or create a new note to get started.
          </p>
          <p class="mt-3 max-w-sm text-xs text-text-muted">
            Tip: type <span class="rounded bg-muted px-1.5 py-0.5 font-mono">[[</span> inside any
            note to link to another note, or
            <span class="rounded bg-muted px-1.5 py-0.5 font-mono">@name</span> to mention a
            teammate.
          </p>
        </div>
      </section>
    </div>
  </section>
</template>

<style scoped>
.notes-index-panel,
.note-canvas {
  border: 1px solid var(--border-default);
  border-radius: 24px;
  background: var(--surface-card);
  box-shadow: var(--shadow-xs);
}
.notes-index-panel {
  padding: 16px;
}
.note-canvas {
  overflow: hidden;
  background: linear-gradient(var(--border-subtle) 1px, transparent 1px), var(--surface-card);
  background-size: 100% 44px;
}
@media (min-width: 1024px) {
  .notes-index-panel {
    position: sticky;
    top: 20px;
    max-height: calc(100vh - 120px);
    overflow: auto;
  }
}
</style>
