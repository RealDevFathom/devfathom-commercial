<script setup lang="ts">
import {
  AlertCircle,
  ArrowLeft,
  CheckCircle2,
  Columns3,
  FileJson,
  Loader2,
  StickyNote,
  Tag,
  Upload,
  Users,
} from 'lucide-vue-next';
import type { Project } from '~/types/delivery';
import type { TeamMember } from '~/types/firm';

type Step = 'upload' | 'preview' | 'importing' | 'done';
interface TrelloMember {
  id: string;
  fullName?: string;
  username?: string;
}

useHead({ title: 'Import from Trello · DevFathom Hub' });
const delivery = useDelivery();
const firm = useFirm();
const router = useRouter();
const steps: Step[] = ['upload', 'preview', 'importing', 'done'];
const step = ref<Step>('upload');
const error = ref('');
const trelloData = ref<Record<string, any> | null>(null);
const projects = ref<Project[]>([]);
const teamMembers = ref<TeamMember[]>([]);
const targetMode = ref<'existing' | 'new'>('existing');
const selectedProjectId = ref('');
const newProjectName = ref('');
const memberMapping = reactive<Record<string, string>>({});
const includeArchived = ref(false);
const importResult = ref<Record<string, any> | null>(null);

try {
  const [projectRows, teamRows] = await Promise.all([delivery.listProjects(), firm.team()]);
  projects.value = projectRows;
  teamMembers.value = teamRows;
} catch {
  // Upload remains available; destination loading errors surface when import is attempted.
}

const members = computed<TrelloMember[]>(() =>
  Array.isArray(trelloData.value?.members) ? trelloData.value.members : []
);
const counts = computed(() => {
  if (!trelloData.value) return null;
  const cards = Array.isArray(trelloData.value.cards) ? trelloData.value.cards : [];
  const archivedCards = cards.filter((card: any) => card.closed).length;
  return {
    openLists: (trelloData.value.lists || []).filter((list: any) => !list.closed).length,
    openCards: cards.filter((card: any) => !card.closed).length,
    labels: (trelloData.value.labels || []).filter((label: any) => label.name || label.color)
      .length,
    members: members.value.length,
    archivedCards,
  };
});
const canImport = computed(
  () => !!trelloData.value && (targetMode.value === 'existing' ? !!selectedProjectId.value : true)
);

async function readFile(file?: File) {
  if (!file) return;
  error.value = '';
  try {
    const json = JSON.parse(await file.text());
    if (
      !json ||
      typeof json.name !== 'string' ||
      !Array.isArray(json.lists) ||
      !Array.isArray(json.cards)
    ) {
      throw new Error('schema');
    }
    trelloData.value = json;
    step.value = 'preview';
  } catch {
    error.value =
      "This doesn't look like a Trello export. Export the board from Trello → Menu → Print and Export → Export as JSON.";
  }
}

function handleDrop(event: DragEvent) {
  event.preventDefault();
  const file = event.dataTransfer?.files?.[0];
  if (!file || (!file.name.endsWith('.json') && file.type !== 'application/json')) {
    error.value = 'Please upload a JSON file.';
    return;
  }
  void readFile(file);
}

async function importBoard() {
  if (!trelloData.value || !canImport.value) return;
  step.value = 'importing';
  error.value = '';
  try {
    importResult.value = await delivery.importTrello({
      trelloJson: trelloData.value,
      memberMapping: { ...memberMapping },
      includeArchived: includeArchived.value,
      ...(targetMode.value === 'existing'
        ? { projectId: selectedProjectId.value }
        : { newProjectName: newProjectName.value.trim() || trelloData.value.name }),
    });
    step.value = 'done';
  } catch (caught: any) {
    error.value = caught?.data?.detail || 'The board could not be imported.';
    step.value = 'preview';
  }
}

function isPast(index: number) {
  return steps.indexOf(step.value) > index;
}
</script>

<template>
  <section class="core-route mx-auto max-w-3xl animate-fade-in space-y-6">
    <div class="import-hero">
      <NuxtLink
        to="/projects"
        class="mb-4 inline-flex items-center gap-1.5 text-sm text-text-muted transition-colors hover:text-foreground"
      >
        <ArrowLeft :size="16" /> Back to Projects
      </NuxtLink>
      <p class="mb-2 font-mono text-[10px] font-semibold uppercase tracking-[0.18em] text-primary">
        Delivery / Migration
      </p>
      <h1 class="font-display text-4xl font-semibold tracking-[-0.04em] text-foreground">
        Import from Trello
      </h1>
      <p class="mt-1.5 text-[15px] text-text-muted">
        Upload your Trello board JSON export to recreate it in DevFathom.
      </p>
    </div>

    <div class="flex items-center gap-2" aria-label="Import progress">
      <template v-for="(item, index) in steps" :key="item">
        <div
          v-if="index"
          class="h-px w-8"
          :class="isPast(index - 1) || step === item ? 'bg-primary' : 'bg-border-default'"
        />
        <div
          class="grid h-7 w-7 place-items-center rounded-full text-xs font-semibold transition-colors"
          :class="
            step === item
              ? 'bg-primary text-white'
              : isPast(index)
                ? 'bg-emerald-500 text-white'
                : 'bg-secondary text-text-muted'
          "
        >
          <CheckCircle2 v-if="isPast(index)" :size="16" /><span v-else>{{ index + 1 }}</span>
        </div>
      </template>
    </div>

    <div
      v-if="error"
      class="flex items-start gap-3 rounded-xl border border-red-500/20 bg-red-500/5 px-4 py-3"
    >
      <AlertCircle :size="20" class="mt-0.5 shrink-0 text-red-500" />
      <p class="m-0 text-sm text-red-500">{{ error }}</p>
    </div>

    <div
      v-if="step === 'upload'"
      class="flex flex-col items-center justify-center rounded-2xl border-2 border-dashed border-border-default bg-card px-8 py-20 transition-colors hover:border-primary/30 hover:bg-primary/[0.02]"
      @dragover.prevent
      @drop="handleDrop"
    >
      <span class="mb-4 grid h-14 w-14 place-items-center rounded-2xl bg-primary/10"
        ><Upload :size="28" class="text-primary"
      /></span>
      <h3 class="m-0 text-lg font-semibold text-foreground">Drop your Trello JSON here</h3>
      <p class="mt-2 max-w-sm text-center text-sm text-text-muted">
        Export from Trello: Menu → More → Print and Export → Export as JSON
      </p>
      <label
        class="mt-6 cursor-pointer rounded-xl bg-primary px-6 py-2.5 text-sm font-semibold text-white transition-all hover:brightness-90 active:scale-[.98]"
        >Choose File<input
          type="file"
          accept=".json,application/json"
          class="hidden"
          @change="readFile(($event.target as HTMLInputElement).files?.[0])"
      /></label>
    </div>

    <div v-else-if="step === 'preview' && trelloData" class="space-y-6">
      <article class="rounded-[4px] border border-border-subtle bg-card p-6">
        <div class="mb-4 flex items-center gap-3">
          <span class="grid h-10 w-10 place-items-center rounded-xl bg-primary/10"
            ><FileJson :size="20" class="text-primary"
          /></span>
          <div>
            <h3 class="m-0 text-base font-semibold text-foreground">{{ trelloData.name }}</h3>
            <p v-if="trelloData.desc" class="m-0 text-xs text-text-muted">{{ trelloData.desc }}</p>
          </div>
        </div>
        <div class="grid grid-cols-2 gap-4 sm:grid-cols-4">
          <div
            v-for="stat in [
              { icon: Columns3, label: 'Lists', value: counts?.openLists || 0 },
              { icon: StickyNote, label: 'Cards', value: counts?.openCards || 0 },
              { icon: Tag, label: 'Labels', value: counts?.labels || 0 },
              { icon: Users, label: 'Members', value: counts?.members || 0 },
            ]"
            :key="stat.label"
            class="flex items-center gap-2 rounded-xl bg-secondary p-3"
          >
            <component :is="stat.icon" :size="16" class="text-text-muted" />
            <div>
              <b class="block text-lg leading-none text-foreground">{{ stat.value }}</b
              ><small class="text-[11px] text-text-muted">{{ stat.label }}</small>
            </div>
          </div>
        </div>
      </article>

      <div>
        <label class="mb-2 block text-sm font-medium text-foreground">Import to Project</label>
        <div class="mb-3 inline-flex rounded-xl border border-border-default bg-card p-1">
          <button
            v-for="mode in ['existing', 'new'] as const"
            :key="mode"
            class="rounded-lg border-0 px-4 py-1.5 text-sm font-medium"
            :class="
              targetMode === mode
                ? 'bg-primary text-white'
                : 'bg-transparent text-text-muted hover:text-foreground'
            "
            @click="targetMode = mode"
          >
            {{ mode === 'existing' ? 'Existing project' : 'New project' }}
          </button>
        </div>
        <select v-if="targetMode === 'existing'" v-model="selectedProjectId" class="studio-input">
          <option value="">Select a project...</option>
          <option v-for="project in projects" :key="project.id" :value="project.id">
            {{ project.name }}
          </option>
        </select>
        <template v-else
          ><input v-model="newProjectName" class="studio-input" :placeholder="trelloData.name" />
          <p class="mt-1.5 text-xs text-text-muted">
            A new project is created with you as its lead. Leave blank to use the board name “{{
              trelloData.name
            }}”.
          </p></template
        >
      </div>

      <div v-if="members.length">
        <label class="mb-3 block text-sm font-medium text-foreground">Map Trello Members</label>
        <div class="space-y-2">
          <div
            v-for="member in members"
            :key="member.id"
            class="flex items-center gap-3 rounded-xl border border-border-subtle bg-card p-3"
          >
            <div class="min-w-0 flex-1">
              <p class="m-0 truncate text-sm font-medium text-foreground">
                {{ member.fullName || member.username }}
              </p>
              <p class="m-0 text-xs text-text-muted">@{{ member.username }}</p>
            </div>
            <span class="text-xs text-text-muted">→</span
            ><select
              v-model="memberMapping[member.id]"
              class="w-full rounded-lg border border-border-default bg-secondary px-3 py-1.5 text-sm text-foreground sm:w-44"
            >
              <option value="">Unassigned</option>
              <option v-for="person in teamMembers" :key="person.id" :value="person.id">
                {{ person.name }}
              </option>
            </select>
          </div>
        </div>
      </div>

      <label
        v-if="counts?.archivedCards"
        class="flex cursor-pointer items-center gap-3 rounded-xl border border-border-subtle bg-card p-4"
        ><input v-model="includeArchived" type="checkbox" class="h-4 w-4 accent-primary" /><span
          ><b class="block text-sm font-medium text-foreground">Include archived cards</b
          ><small class="text-xs text-text-muted"
            >{{ counts.archivedCards }} archived cards will be added to an “Archived” column</small
          ></span
        ></label
      >
      <button
        class="flex w-full items-center justify-center rounded-xl border-0 bg-primary px-6 py-3 text-sm font-semibold text-white transition-all hover:brightness-90 active:scale-[.98] disabled:pointer-events-none disabled:opacity-40"
        :disabled="!canImport"
        @click="importBoard"
      >
        Import Board
      </button>
    </div>

    <div v-else-if="step === 'importing'" class="flex flex-col items-center justify-center py-20">
      <Loader2 :size="40" class="mb-4 animate-spin text-primary" />
      <h3 class="m-0 text-lg font-semibold text-foreground">Importing your board...</h3>
      <p class="mt-2 text-sm text-text-muted">
        Creating columns, tasks, labels, and comments. This may take a moment.
      </p>
    </div>

    <div
      v-else-if="step === 'done' && importResult"
      class="flex flex-col items-center justify-center py-16 text-center"
    >
      <span class="mb-5 grid h-16 w-16 place-items-center rounded-2xl bg-emerald-500/10"
        ><CheckCircle2 :size="32" class="text-emerald-500"
      /></span>
      <h3 class="m-0 text-xl font-bold text-foreground">Import Complete</h3>
      <p class="mt-2 max-w-sm text-sm text-text-muted">
        <b class="text-foreground">“{{ importResult.boardName }}”</b> has been imported with
        {{ importResult.columnsCreated }} columns, {{ importResult.tasksCreated }} tasks, and
        {{ importResult.labelsCreated }} labels.
      </p>
      <div
        v-if="importResult.skippedCount"
        class="mt-4 w-full max-w-sm rounded-xl border border-amber-500/30 bg-amber-500/10 p-3 text-left"
      >
        <p class="m-0 text-xs font-semibold text-amber-600">
          {{ importResult.skippedCount }} cards skipped
        </p>
        <ul class="mt-1 space-y-0.5 pl-4">
          <li
            v-for="(item, index) in (importResult.skipped || []).slice(0, 8)"
            :key="index"
            class="text-[11px] text-text-muted"
          >
            <span class="text-foreground">{{ item.name || 'Untitled' }}</span> — {{ item.reason }}
          </li>
        </ul>
      </div>
      <button
        class="mt-8 rounded-xl border-0 bg-primary px-8 py-3 text-sm font-semibold text-white hover:brightness-90"
        @click="router.push('/projects')"
      >
        Go to Projects
      </button>
    </div>
  </section>
</template>

<style scoped>
.import-hero {
  border: 1px solid var(--border-default);
  border-radius: 28px;
  padding: clamp(22px, 4vw, 34px);
  background: var(--surface-card);
  box-shadow: var(--shadow-xs);
}
</style>

<style scoped>
.studio-input {
  width: 100%;
  min-height: 42px;
  border: 1px solid var(--border-default);
  border-radius: 12px;
  padding: 9px 14px;
  color: var(--foreground);
  background: var(--surface-card);
  outline: 0;
}
.studio-input:focus {
  border-color: var(--primary);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--primary) 18%, transparent);
}
</style>
