<script setup lang="ts">
import {
  AtSign,
  Clock3,
  FileText,
  Globe2,
  History,
  Link2,
  Loader2,
  LockKeyhole,
  Pencil,
  Plus,
  Save,
  Search,
  Share2,
  Trash2,
  Undo2,
  Users,
  X,
} from 'lucide-vue-next';
import type { Note, NoteRevision, NoteSummary, Person } from '~/types/collaboration';

const route = useRoute();
const router = useRouter();
const api = useNotes();
const collaboration = useCollaboration();
const { user } = useAuth();
const id = computed(() => String(route.params.id));
const note = ref<Note | null>(null);
const revisions = ref<NoteRevision[]>([]);
const loading = ref(true);
const saving = ref(false);
const error = ref('');
const title = ref('');
const visibility = ref<Note['visibility']>('PRIVATE');
const contentJson = ref<any>({ type: 'doc', content: [] });
const editing = ref(false);
const shareOpen = ref(false);
const historyOpen = ref(false);
const peopleQuery = ref('');
const people = ref<Person[]>([]);
const selectedShares = ref<{ userId: string; permission: 'VIEW' | 'EDIT'; user: Person }[]>([]);
const notes = ref<NoteSummary[]>([]);
const scope = ref<'all' | 'mine' | 'shared' | 'mentions'>('all');
const search = ref('');
const listLoading = ref(true);
const listError = ref('');
const creating = ref(false);
const scopeLabels = { all: 'All', mine: 'My notes', shared: 'Shared', mentions: 'Mentions' };
const visibilityLabels = { PRIVATE: 'Private', SHARED: 'Shared', TEAM: 'Team' } as const;
useHead(() => ({ title: note.value ? `${note.value.title} · Notes` : 'Note · DevFathom Hub' }));

async function load() {
  loading.value = true;
  error.value = '';
  try {
    const value = await api.get(id.value);
    note.value = value;
    title.value = value.title;
    visibility.value = value.visibility;
    contentJson.value = value.contentJson;
    selectedShares.value = value.shares.map((s) => ({
      userId: s.userId,
      permission: s.permission,
      user: s.user,
    }));
    revisions.value = await api.revisions(id.value);
  } catch (caught: any) {
    error.value = caught?.data?.detail || 'This note could not be opened.';
  } finally {
    loading.value = false;
  }
}

await load();

async function loadNotes() {
  listLoading.value = true;
  listError.value = '';
  try {
    notes.value =
      scope.value === 'mentions'
        ? await api.mentions()
        : await api.list({ scope: scope.value, search: search.value || undefined });
  } catch (caught: any) {
    listError.value = caught?.data?.detail || 'The note index is unavailable.';
  } finally {
    listLoading.value = false;
  }
}
await loadNotes();
watch(scope, loadNotes);
watch(id, async () => {
  editing.value = false;
  shareOpen.value = false;
  historyOpen.value = false;
  await Promise.all([load(), loadNotes()]);
});
let searchTimer: ReturnType<typeof setTimeout> | undefined;
watch(search, () => {
  if (searchTimer) clearTimeout(searchTimer);
  searchTimer = setTimeout(loadNotes, 200);
});

async function save() {
  saving.value = true;
  try {
    await api.update(id.value, {
      title: title.value.trim() || 'Untitled',
      visibility: visibility.value,
      contentJson: contentJson.value,
    });
    await api.setShares(
      id.value,
      selectedShares.value.map(({ userId, permission }) => ({ userId, permission }))
    );
    editing.value = false;
    await Promise.all([load(), loadNotes()]);
  } finally {
    saving.value = false;
  }
}

async function cancelEdit() {
  editing.value = false;
  await load();
}

async function updateVisibility() {
  if (!note.value?.editable) return;
  saving.value = true;
  try {
    await api.update(id.value, { visibility: visibility.value });
    await Promise.all([load(), loadNotes()]);
  } finally {
    saving.value = false;
  }
}

async function remove() {
  if (confirm('Delete this note? This cannot be undone.')) {
    await api.remove(id.value);
    await router.push('/notes');
  }
}

async function restore(revisionId: string) {
  if (confirm('Restore this revision as the current note?')) {
    await api.restore(revisionId);
    historyOpen.value = false;
    await Promise.all([load(), loadNotes()]);
  }
}

let peopleTimer: ReturnType<typeof setTimeout> | undefined;
function findPeople() {
  if (peopleTimer) clearTimeout(peopleTimer);
  peopleTimer = setTimeout(async () => {
    if (peopleQuery.value.trim().length < 2) {
      people.value = [];
      return;
    }
    people.value = (await collaboration.search(peopleQuery.value)).team;
  }, 180);
}
onBeforeUnmount(() => {
  if (peopleTimer) clearTimeout(peopleTimer);
  if (searchTimer) clearTimeout(searchTimer);
});

function addShare(person: Person) {
  if (!selectedShares.value.some((s) => s.userId === person.id)) {
    selectedShares.value.push({ userId: person.id, permission: 'VIEW', user: person });
  }
  peopleQuery.value = '';
  people.value = [];
}

const date = (value?: string) =>
  value
    ? new Intl.DateTimeFormat('en', { dateStyle: 'medium', timeStyle: 'short' }).format(
        new Date(value)
      )
    : '—';

const isAuthor = computed(() => note.value?.authorId === user.value?.id);
const shortDate = (value?: string) =>
  value
    ? new Intl.DateTimeFormat('en', { month: 'short', day: 'numeric' }).format(new Date(value))
    : '—';

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
        <label class="relative block">
          <Search :size="14" class="absolute left-2.5 top-1/2 -translate-y-1/2 text-text-muted" />
          <input
            v-model="search"
            placeholder="Search notes…"
            class="h-9 w-full rounded-xl border border-border bg-card pl-8 pr-3 text-xs text-foreground outline-none focus:border-primary focus:ring-2 focus:ring-primary/20"
          />
        </label>

        <DeliveryFieldState
          v-if="listLoading || listError"
          :loading="listLoading"
          :error="listError"
          action="Try again"
          @action="loadNotes"
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
            class="mt-3 inline-flex items-center gap-1 rounded-lg bg-primary px-3 py-1.5 text-xs font-semibold text-white"
            :disabled="creating"
            @click="handleCreate"
          >
            <Plus :size="12" /> New note
          </button>
        </div>
        <div v-else class="space-y-1.5">
          <NuxtLink
            v-for="item in notes"
            :key="item.id"
            :to="`/notes/${item.id}`"
            class="block rounded-xl border px-3 py-2.5 transition-all"
            :class="
              item.id === id
                ? 'border-primary/40 bg-primary/5'
                : 'border-border/60 bg-card hover:border-border hover:shadow-sm'
            "
          >
            <div class="flex items-start justify-between gap-2">
              <h2 class="truncate text-sm font-medium text-foreground">
                {{ item.title || 'Untitled' }}
              </h2>
              <span
                class="inline-flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-[10px] font-medium"
                :class="{
                  'bg-muted text-text-muted': item.visibility === 'PRIVATE',
                  'bg-blue-500/10 text-blue-500': item.visibility === 'SHARED',
                  'bg-emerald-500/10 text-emerald-500': item.visibility === 'TEAM',
                }"
              >
                <LockKeyhole v-if="item.visibility === 'PRIVATE'" :size="10" />
                <Users v-else-if="item.visibility === 'SHARED'" :size="10" />
                <Globe2 v-else :size="10" />
                {{ visibilityLabels[item.visibility] }}
              </span>
            </div>
            <footer class="mt-1 flex items-center gap-2 text-[11px] text-text-muted">
              <span
                class="grid h-3.5 w-3.5 place-items-center overflow-hidden rounded-full bg-secondary text-[7px]"
              >
                <img
                  v-if="item.author?.avatar"
                  :src="item.author.avatar"
                  :alt="item.author.name"
                  class="h-full w-full object-cover"
                />
                <template v-else>{{ item.author?.name?.[0] || '?' }}</template>
              </span>
              <span>{{ item.authorId === user?.id ? 'You' : item.author?.name || 'Unknown' }}</span>
              <span>·</span><time>{{ shortDate(item.updatedAt) }}</time>
            </footer>
          </NuxtLink>
        </div>
      </aside>

      <main class="min-w-0">
        <DeliveryFieldState
          v-if="loading || error"
          :loading="loading"
          :error="error"
          action="Try again"
          @action="load"
        />

        <section v-else-if="note" class="note-document">
          <div class="space-y-4 p-5">
            <header class="flex flex-wrap items-start gap-3">
              <input
                v-model="title"
                :readonly="!editing"
                placeholder="Untitled"
                class="min-w-0 flex-1 truncate bg-transparent font-display text-2xl font-bold tracking-tight text-foreground outline-none placeholder:text-text-muted"
                :class="{ 'cursor-default': !editing }"
              />

              <template v-if="editing">
                <button
                  class="inline-flex items-center gap-1.5 rounded-lg border border-border bg-card px-3 py-1.5 text-xs font-medium text-text-muted transition-colors hover:text-foreground disabled:opacity-50"
                  :disabled="saving"
                  @click="cancelEdit"
                >
                  <X :size="14" /> Cancel
                </button>
                <button
                  class="inline-flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-xs font-semibold text-white transition-colors hover:bg-[#0C2E2C] disabled:opacity-50"
                  :disabled="saving"
                  title="Save"
                  @click="save"
                >
                  <Save :size="14" /> {{ saving ? 'Saving…' : 'Save' }}
                </button>
              </template>
              <button
                v-else-if="note.editable"
                class="inline-flex items-center gap-1.5 rounded-lg border border-border bg-card px-3 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-secondary"
                @click="
                  editing = true;
                  historyOpen = false;
                "
              >
                <Pencil :size="14" /> Edit
              </button>

              <button
                v-if="!editing"
                class="inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors"
                :class="
                  historyOpen
                    ? 'border-primary/30 bg-primary/10 text-primary'
                    : 'border-border bg-card text-text-muted hover:text-foreground'
                "
                @click="
                  historyOpen = !historyOpen;
                  shareOpen = false;
                "
              >
                <History :size="14" /> History
              </button>

              <template v-if="isAuthor">
                <select
                  v-model="visibility"
                  class="rounded-lg border border-border bg-background px-2.5 py-1.5 text-xs font-medium text-foreground outline-none focus:border-primary"
                  :disabled="saving"
                  @change="updateVisibility"
                >
                  <option value="PRIVATE">Private</option>
                  <option value="SHARED">Shared</option>
                  <option value="TEAM">Team</option>
                </select>
                <button
                  class="inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs font-medium transition-colors"
                  :class="
                    shareOpen || selectedShares.length
                      ? 'border-primary/30 bg-primary/10 text-primary'
                      : 'border-border bg-card text-text-muted hover:text-foreground'
                  "
                  @click="
                    shareOpen = !shareOpen;
                    historyOpen = false;
                  "
                >
                  <Share2 :size="14" /> Share
                  <span
                    v-if="selectedShares.length"
                    class="rounded-full bg-primary/20 px-1.5 text-[10px] font-bold"
                    >{{ selectedShares.length }}</span
                  >
                </button>
                <button
                  class="rounded-lg border border-border bg-card p-2 text-text-muted transition-colors hover:border-red-500/30 hover:bg-red-500/10 hover:text-red-500"
                  title="Delete note"
                  @click="remove"
                >
                  <Trash2 :size="14" />
                </button>
              </template>
            </header>

            <section
              v-if="shareOpen && isAuthor"
              class="space-y-3 rounded-xl border border-border/60 bg-secondary/30 p-4"
            >
              <header class="flex items-center justify-between">
                <div>
                  <h2 class="text-sm font-semibold text-foreground">Share note</h2>
                  <p class="mt-0.5 text-xs text-text-muted">
                    Choose who can view or edit this note.
                  </p>
                </div>
                <button class="text-text-muted hover:text-foreground" @click="shareOpen = false">
                  <X :size="15" />
                </button>
              </header>
              <label class="block">
                <span
                  class="mb-1 block text-[10px] font-medium uppercase tracking-wider text-text-muted"
                  >Find a teammate</span
                >
                <input
                  v-model="peopleQuery"
                  class="h-9 w-full rounded-lg border border-border bg-background px-3 text-xs text-foreground outline-none focus:border-primary"
                  placeholder="Search by name…"
                  @input="findPeople"
                />
              </label>
              <button
                v-for="person in people"
                :key="person.id"
                class="flex w-full items-center justify-between rounded-lg px-3 py-2 text-left text-xs hover:bg-secondary"
                @click="addShare(person)"
              >
                <span class="font-medium text-foreground">{{ person.name }}</span>
                <span class="text-text-muted">{{ person.title || 'Team' }}</span>
              </button>
              <article
                v-for="share in selectedShares"
                :key="share.userId"
                class="flex items-center gap-3 rounded-lg border border-border/60 bg-card px-3 py-2"
              >
                <span class="min-w-0 flex-1 truncate text-xs font-medium text-foreground">{{
                  share.user.name
                }}</span>
                <select
                  v-model="share.permission"
                  class="rounded-md border border-border bg-background px-2 py-1 text-[11px]"
                >
                  <option value="VIEW">Can view</option>
                  <option value="EDIT">Can edit</option>
                </select>
                <button
                  class="text-text-muted hover:text-red-500"
                  aria-label="Remove share"
                  @click="selectedShares = selectedShares.filter((s) => s.userId !== share.userId)"
                >
                  <X :size="14" />
                </button>
              </article>
              <footer class="flex justify-end">
                <button
                  class="inline-flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-50"
                  :disabled="saving"
                  @click="save"
                >
                  <Save :size="14" /> Save sharing
                </button>
              </footer>
            </section>

            <section
              v-if="historyOpen"
              class="space-y-2 rounded-xl border border-border/60 bg-secondary/30 p-4"
            >
              <header class="flex items-center justify-between">
                <div>
                  <h2 class="text-sm font-semibold text-foreground">Version history</h2>
                  <p class="mt-0.5 text-xs text-text-muted">Past saved versions of this note.</p>
                </div>
                <button class="text-text-muted hover:text-foreground" @click="historyOpen = false">
                  <X :size="15" />
                </button>
              </header>
              <article
                v-for="revision in revisions"
                :key="revision.id"
                class="flex items-center gap-3 rounded-lg border border-border/60 bg-card px-3 py-2"
              >
                <Clock3 :size="14" class="text-text-muted" />
                <div class="min-w-0 flex-1">
                  <strong class="block truncate text-xs font-medium text-foreground">{{
                    revision.title
                  }}</strong>
                  <small class="text-[10px] text-text-muted">{{ date(revision.createdAt) }}</small>
                </div>
                <button
                  v-if="note.editable"
                  class="inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px] text-text-muted hover:bg-secondary hover:text-foreground"
                  @click="restore(revision.id)"
                >
                  <Undo2 :size="13" /> Restore
                </button>
              </article>
              <p v-if="!revisions.length" class="py-4 text-center text-xs text-text-muted">
                No revisions recorded yet.
              </p>
            </section>

            <div
              class="flex flex-wrap items-center gap-3 border-b border-border/60 pb-3 text-xs text-text-muted"
            >
              <span
                class="grid h-4 w-4 place-items-center overflow-hidden rounded-full bg-secondary text-[8px]"
              >
                <img
                  v-if="note.author?.avatar"
                  :src="note.author.avatar"
                  :alt="note.author.name"
                  class="h-full w-full object-cover"
                />
                <template v-else>{{ note.author?.name?.[0] || '?' }}</template>
              </span>
              <span>{{ isAuthor ? 'You' : note.author?.name || 'Unknown author' }}</span>
              <span>·</span><span>Updated {{ date(note.updatedAt) }}</span>
              <template v-if="note.project">
                <span>·</span
                ><NuxtLink :to="`/projects/${note.project.id}`" class="hover:text-primary">{{
                  note.project.name
                }}</NuxtLink>
              </template>
              <template v-if="note.client">
                <span>·</span
                ><NuxtLink :to="`/clients/${note.client.id}`" class="hover:text-primary">{{
                  note.client.name
                }}</NuxtLink>
              </template>
              <template v-if="!note.editable"><span>·</span><span>View only</span></template>
              <template v-if="editing"
                ><span>·</span
                ><span class="rounded bg-amber-500/10 px-1.5 py-0.5 font-medium text-amber-600"
                  >Editing</span
                ></template
              >
            </div>

            <div v-if="note.mentions.length" class="flex flex-wrap items-center gap-1.5 text-xs">
              <span class="inline-flex items-center gap-1 font-medium text-text-muted"
                ><AtSign :size="12" /> Mentioned:</span
              >
              <span
                v-for="mention in note.mentions"
                :key="mention.id"
                class="inline-flex items-center gap-1 rounded-full bg-secondary px-2 py-0.5 text-foreground"
              >
                {{ mention.user.id === user?.id ? 'You' : mention.user.name }}
              </span>
            </div>

            <CollaborationRichEditor v-model="contentJson" :readonly="!editing" />

            <section v-if="note.linksTo.length" class="border-t border-border/60 pt-4">
              <h2
                class="mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-text-muted"
              >
                <Link2 :size="12" /> Linked mentions ({{ note.linksTo.length }})
              </h2>
              <div class="flex flex-wrap gap-1.5">
                <NuxtLink
                  v-for="link in note.linksTo"
                  :key="link.id"
                  :to="`/notes/${link.fromNote.id}`"
                  class="inline-flex items-center gap-1 rounded-lg bg-secondary px-2.5 py-1 text-xs text-foreground transition-colors hover:bg-primary/10 hover:text-primary"
                >
                  <FileText :size="12" /> {{ link.fromNote.title }}
                </NuxtLink>
              </div>
            </section>
          </div>
        </section>
      </main>
    </div>
  </section>
</template>

<style scoped>
.notes-index-panel,
.note-document {
  border: 1px solid var(--border-default);
  border-radius: 24px;
  background: var(--surface-card);
  box-shadow: var(--shadow-xs);
}
.notes-index-panel {
  padding: 16px;
}
.note-document {
  overflow: hidden;
}
.note-document > div {
  padding: clamp(20px, 4vw, 36px);
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
