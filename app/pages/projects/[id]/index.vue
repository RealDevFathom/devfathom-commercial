<script setup lang="ts">
import {
  ArrowLeft,
  ArrowRight,
  Building2,
  Calendar,
  CalendarCheck,
  CheckCircle2,
  Clock,
  Crown,
  ExternalLink,
  FilePlus2,
  FileText,
  FolderKanban,
  Pencil,
  Plus,
  Trash2,
  UserMinus,
  UserPlus,
  Users,
} from 'lucide-vue-next';
import type { NoteSummary } from '~/types/collaboration';
import type { Milestone, Project, ProjectFile, TimeRollup } from '~/types/delivery';
import type { TeamMember } from '~/types/firm';

type ProjectTab = 'overview' | 'board' | 'team' | 'milestones' | 'notes' | 'files';

const route = useRoute();
const router = useRouter();
const projectId = computed(() => String(route.params.id));
const delivery = useDelivery();
const notesApi = useNotes();
const firm = useFirm();
const project = ref<Project | null>(null);
const milestones = ref<Milestone[]>([]);
const files = ref<ProjectFile[]>([]);
const notes = ref<NoteSummary[]>([]);
const rollup = ref<TimeRollup | null>(null);
const loading = ref(true);
const error = ref('');
const editOpen = ref(false);
const deleteConfirm = ref(false);
const deleting = ref(false);
const panel = ref<'board' | 'milestone' | 'file' | null>(null);
const activeTab = ref<ProjectTab>('overview');
const saving = ref(false);
const creatingNote = ref(false);
const actionError = ref('');
const teamOpen = ref(false);
const team = ref<TeamMember[]>([]);
const memberDraft = ref('');
const boardForm = reactive({ name: '', description: '', template: 'kanban' });
const milestoneForm = reactive({ name: '', description: '', dueDate: '' });
const fileForm = reactive({ name: '', url: '', type: '', size: '' });
useHead(() => ({
  title: project.value
    ? `${project.value.name} · Projects · DevFathom Hub`
    : 'Project · DevFathom Hub',
}));

async function load() {
  loading.value = true;
  error.value = '';
  try {
    const [record, markerList, fileList, time, noteList] = await Promise.all([
      delivery.getProject(projectId.value),
      delivery.listMilestones(projectId.value),
      delivery.listFiles(projectId.value),
      delivery.getTimeRollup(projectId.value),
      notesApi.list({ projectId: projectId.value }).catch(() => []),
    ]);
    project.value = record;
    milestones.value = markerList;
    files.value = fileList;
    notes.value = noteList;
    rollup.value = time;
  } catch (caught: any) {
    error.value = caught?.data?.detail || caught?.message || 'This project could not be loaded.';
  } finally {
    loading.value = false;
  }
}
await load();

async function removeProject() {
  deleting.value = true;
  try {
    await delivery.removeProject(projectId.value);
    await router.push('/projects');
  } catch (caught: any) {
    actionError.value = caught?.data?.detail || 'The project could not be deleted.';
  } finally {
    deleting.value = false;
  }
}

async function createBoard() {
  saving.value = true;
  actionError.value = '';
  try {
    await delivery.createBoard({
      projectId: projectId.value,
      name: boardForm.name,
      description: boardForm.description || null,
      template: boardForm.template,
    });
    Object.assign(boardForm, { name: '', description: '', template: 'kanban' });
    panel.value = null;
    await load();
  } catch (caught: any) {
    actionError.value = caught?.data?.detail || 'The board could not be created.';
  } finally {
    saving.value = false;
  }
}

async function createMilestone() {
  saving.value = true;
  actionError.value = '';
  try {
    await delivery.createMilestone(projectId.value, {
      name: milestoneForm.name,
      description: milestoneForm.description || null,
      dueDate: new Date(`${milestoneForm.dueDate}T12:00:00Z`).toISOString(),
    });
    panel.value = null;
    Object.assign(milestoneForm, { name: '', description: '', dueDate: '' });
    milestones.value = await delivery.listMilestones(projectId.value);
  } catch (caught: any) {
    actionError.value = caught?.data?.detail || 'The milestone could not be created.';
  } finally {
    saving.value = false;
  }
}

async function toggleMilestone(item: Milestone) {
  await delivery.updateMilestone(item.id, {
    completedAt: item.completedAt ? null : new Date().toISOString(),
  });
  milestones.value = await delivery.listMilestones(projectId.value);
}

async function createFile() {
  saving.value = true;
  actionError.value = '';
  try {
    await delivery.addFile(projectId.value, {
      name: fileForm.name,
      url: fileForm.url,
      type: fileForm.type || null,
      size: fileForm.size ? Number(fileForm.size) : null,
    });
    panel.value = null;
    Object.assign(fileForm, { name: '', url: '', type: '', size: '' });
    files.value = await delivery.listFiles(projectId.value);
  } catch (caught: any) {
    actionError.value = caught?.data?.detail || 'The file could not be attached.';
  } finally {
    saving.value = false;
  }
}

async function openTeamManager() {
  teamOpen.value = true;
  if (!team.value.length) {
    try {
      team.value = await firm.team();
    } catch (caught: any) {
      actionError.value = caught?.data?.detail || 'The team directory could not be loaded.';
    }
  }
}

async function addMember() {
  if (!memberDraft.value) return;
  await runProjectAction(() =>
    delivery.addProjectMember(projectId.value, memberDraft.value, 'MEMBER')
  );
  memberDraft.value = '';
  teamOpen.value = false;
}

async function setMemberRole(userId: string, role: 'LEAD' | 'MEMBER') {
  await runProjectAction(() => delivery.setProjectMemberRole(projectId.value, userId, role));
}

function onMemberRoleChange(userId: string, event: Event) {
  void setMemberRole(userId, (event.target as HTMLSelectElement).value as 'LEAD' | 'MEMBER');
}

async function removeMember(userId: string, name: string) {
  if (!confirm(`Remove ${name} from this project?`)) return;
  await runProjectAction(() => delivery.removeProjectMember(projectId.value, userId));
}

async function removeBoard(id: string, name: string) {
  if (!confirm(`Delete the “${name}” board and its tasks?`)) return;
  await runProjectAction(() => delivery.removeBoard(id));
}

async function removeMilestone(id: string, name: string) {
  if (!confirm(`Delete the “${name}” milestone?`)) return;
  await runProjectAction(() => delivery.removeMilestone(id));
}

async function removeFile(id: string, name: string) {
  if (!confirm(`Remove “${name}” from this project?`)) return;
  await runProjectAction(() => delivery.removeFile(id));
}

async function createProjectNote() {
  creatingNote.value = true;
  actionError.value = '';
  try {
    const created = await notesApi.create({
      title: `${project.value?.name || 'Project'} note`,
      contentJson: { type: 'doc', content: [] },
      visibility: 'PRIVATE',
      projectId: projectId.value,
    });
    await router.push(`/notes/${created.id}`);
  } catch (caught: any) {
    actionError.value = caught?.data?.detail || 'The project note could not be created.';
  } finally {
    creatingNote.value = false;
  }
}

async function runProjectAction(action: () => Promise<unknown>) {
  saving.value = true;
  actionError.value = '';
  try {
    await action();
    await load();
  } catch (caught: any) {
    actionError.value = caught?.data?.detail || 'The project change could not be saved.';
  } finally {
    saving.value = false;
  }
}

const formatDate = (value?: string | null) =>
  value
    ? new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric' }).format(
        new Date(value)
      )
    : '—';
const progress = computed(() => {
  if (!milestones.value.length) return null;
  const done = milestones.value.filter((item) => item.completedAt).length;
  return {
    done,
    total: milestones.value.length,
    pct: Math.round((done / milestones.value.length) * 100),
  };
});
const deadline = computed(() => {
  if (!project.value || ['COMPLETED', 'CANCELLED'].includes(project.value.status)) return null;
  const values = milestones.value
    .filter((item) => !item.completedAt)
    .map((item) => item.dueDate)
    .filter((value): value is string => Boolean(value))
    .map((value) => new Date(value))
    .sort((a, b) => a.getTime() - b.getTime());
  const value = values[0] || (project.value.endDate ? new Date(project.value.endDate) : null);
  if (!value) return null;
  const days = Math.ceil((value.getTime() - Date.now()) / 86_400_000);
  return {
    label:
      days < 0
        ? `${Math.abs(days)}d overdue`
        : days === 0
          ? 'Due today'
          : days <= 3
            ? `Due in ${days}d`
            : days <= 14
              ? `${days}d left`
              : formatDate(value.toISOString()),
    danger: days <= 3,
  };
});
const statusLabel = computed(
  () =>
    project.value?.status
      .replaceAll('_', ' ')
      .toLowerCase()
      .replace(/\b\w/g, (letter) => letter.toUpperCase()) || ''
);
const statusClass = computed(
  () =>
    ({
      ACTIVE: 'bg-emerald-500/10 text-emerald-600',
      IN_DEVELOPMENT: 'bg-blue-500/10 text-blue-600',
      ON_HOLD: 'bg-amber-500/10 text-amber-600',
      COMPLETED: 'bg-secondary text-text-muted',
      CANCELLED: 'bg-red-500/10 text-red-500',
    })[project.value?.status || 'ACTIVE']
);
const statusRail = computed(
  () =>
    ({
      ACTIVE: 'bg-emerald-500',
      IN_DEVELOPMENT: 'bg-blue-500',
      ON_HOLD: 'bg-amber-500',
      COMPLETED: 'bg-text-muted/40',
      CANCELLED: 'bg-red-500',
    })[project.value?.status || 'ACTIVE']
);
const teamCandidates = computed(() => {
  const current = new Set(project.value?.members.map((member) => member.user.id) || []);
  return team.value.filter((member) => !current.has(member.id));
});
</script>

<template>
  <section class="core-route animate-fade-in space-y-6">
    <DeliveryFieldState
      v-if="loading || error"
      :loading="loading"
      :error="error"
      action="Try again"
      @action="load"
    />
    <template v-else-if="project">
      <NuxtLink
        to="/projects"
        class="inline-flex items-center gap-1.5 rounded text-sm text-text-muted transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
        ><ArrowLeft :size="16" /> Back to Projects</NuxtLink
      >
      <article class="route-hero relative overflow-hidden border border-border-subtle bg-card">
        <span class="absolute inset-y-0 left-0 w-1" :class="statusRail" aria-hidden="true" />
        <div class="px-5 pl-6">
          <div class="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
            <div class="min-w-0">
              <div class="flex flex-wrap items-center gap-3">
                <h1
                  class="font-display text-[clamp(2.2rem,4vw,3.4rem)] font-semibold leading-none tracking-[-0.055em] text-foreground"
                >
                  {{ project.name }}
                </h1>
                <span
                  class="rounded-full px-2.5 py-1 text-[11px] font-medium"
                  :class="statusClass"
                  >{{ statusLabel }}</span
                >
              </div>
              <p
                v-if="project.client"
                class="mt-2 inline-flex items-center gap-1.5 text-sm text-text-muted"
              >
                <Building2 :size="16" />{{ project.client.name
                }}<a
                  v-if="project.client.website"
                  :href="project.client.website"
                  target="_blank"
                  rel="noreferrer"
                  class="inline-flex items-center rounded text-primary hover:underline"
                  ><ExternalLink :size="14"
                /></a>
              </p>
              <span
                v-else
                class="mt-2 inline-flex rounded bg-secondary px-1.5 py-0.5 text-[11px] font-medium text-text-muted"
                >Internal Product</span
              >
            </div>
            <div class="flex shrink-0 items-center gap-2">
              <button
                class="flex items-center gap-1.5 rounded-xl border border-border bg-card px-3.5 py-2 text-xs font-medium text-foreground transition-colors hover:bg-secondary"
                @click="editOpen = true"
              >
                <Pencil :size="14" /> Edit</button
              ><template v-if="deleteConfirm"
                ><button
                  class="rounded-xl bg-red-500 px-3.5 py-2 text-xs font-semibold text-white transition-colors hover:bg-red-600 disabled:opacity-50"
                  :disabled="deleting"
                  @click="removeProject"
                >
                  {{ deleting ? 'Deleting...' : 'Confirm Delete' }}</button
                ><button
                  class="rounded-xl px-2 py-2 text-xs text-text-muted hover:text-foreground"
                  @click="deleteConfirm = false"
                >
                  Cancel
                </button></template
              ><button
                v-else
                class="flex items-center rounded-xl border border-border bg-card px-3.5 py-2 text-xs font-medium text-text-muted transition-colors hover:border-red-500/20 hover:bg-red-500/10 hover:text-red-500"
                aria-label="Delete project"
                @click="deleteConfirm = true"
              >
                <Trash2 :size="15" />
              </button>
            </div>
          </div>
          <div
            class="mt-5 flex flex-wrap items-center gap-x-5 gap-y-2.5 border-t border-border-subtle pt-4"
          >
            <div v-if="progress" class="flex items-center gap-2">
              <span class="text-[11px] font-medium uppercase tracking-wider text-text-muted"
                >Milestones</span
              ><span class="h-1.5 w-24 overflow-hidden rounded-full bg-secondary"
                ><i class="block h-full bg-primary" :style="{ width: `${progress.pct}%` }" /></span
              ><b class="text-xs tabular-nums"
                >{{ progress.done }}/{{ progress.total }} · {{ progress.pct }}%</b
              >
            </div>
            <span
              v-if="deadline"
              class="flex items-center gap-1.5 text-xs font-medium tabular-nums"
              :class="deadline.danger ? 'text-red-500' : 'text-text-muted'"
              ><Clock :size="14" />{{ deadline.label }}</span
            >
            <span class="flex items-center gap-1.5 text-xs text-text-muted"
              ><Users :size="14" />{{ project.members.length }} member{{
                project.members.length === 1 ? '' : 's'
              }}</span
            >
            <span
              v-if="project.startDate || project.endDate"
              class="flex items-center gap-1.5 text-xs text-text-muted tabular-nums"
              ><Calendar :size="14" />{{ formatDate(project.startDate) }} –
              {{ formatDate(project.endDate) }}</span
            >
          </div>
        </div>
      </article>

      <p
        v-if="actionError"
        class="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-500"
      >
        {{ actionError }}
      </p>

      <div class="overflow-x-auto">
        <nav class="studio-tabs" aria-label="Project sections">
          <button
            v-for="tab in [
              'overview',
              'board',
              'team',
              'milestones',
              'notes',
              'files',
            ] as ProjectTab[]"
            :key="tab"
            class="capitalize"
            :class="{ active: activeTab === tab }"
            @click="activeTab = tab"
          >
            {{ tab }}
          </button>
        </nav>
      </div>

      <div v-if="activeTab === 'overview'" class="grid grid-cols-1 gap-5 lg:grid-cols-3">
        <article class="studio-section-card route-card space-y-5 lg:col-span-2">
          <h2>Overview</h2>
          <p v-if="project.description" class="text-sm leading-relaxed text-text-muted">
            {{ project.description }}
          </p>
          <p v-else class="text-sm italic text-text-faint">No description provided yet.</p>
          <div v-if="project.techStack.length">
            <p class="mb-2 text-xs font-medium uppercase tracking-wider text-text-muted">
              Tech Stack
            </p>
            <div class="flex flex-wrap gap-1.5">
              <span
                v-for="tech in project.techStack"
                :key="tech"
                class="rounded-md bg-secondary px-2 py-0.5 text-[11px] font-medium text-text-muted"
                >{{ tech }}</span
              >
            </div>
          </div>
          <div class="grid grid-cols-2 gap-4 border-t border-border-subtle pt-4 sm:grid-cols-3">
            <div>
              <small>Type</small
              ><b>{{ project.type === 'CLIENT' ? 'Client Project' : 'Internal Product' }}</b>
            </div>
            <div v-if="project.client">
              <small>Client</small><b>{{ project.client.name }}</b>
            </div>
            <div v-if="project.startDate">
              <small>Started</small><b>{{ formatDate(project.startDate) }}</b>
            </div>
            <div v-if="project.endDate">
              <small>Deadline</small><b>{{ formatDate(project.endDate) }}</b>
            </div>
            <div v-if="project.budget != null">
              <small>Budget</small><b>${{ Number(project.budget).toLocaleString() }}</b>
            </div>
            <div>
              <small>Milestones</small><b>{{ milestones.length }}</b>
            </div>
          </div>
        </article>
        <div class="space-y-5">
          <article class="studio-section-card route-card space-y-3">
            <div class="flex items-center justify-between">
              <h2>Team</h2>
              <span class="rounded-full bg-secondary px-2 py-0.5 text-[11px] text-text-muted">{{
                project.members.length
              }}</span>
            </div>
            <p v-if="!project.members.length" class="text-sm text-text-muted">
              No members assigned yet.
            </p>
            <div v-else class="space-y-2.5">
              <div
                v-for="member in project.members.slice(0, 6)"
                :key="member.user.id"
                class="flex items-center gap-2.5"
              >
                <span
                  class="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-secondary text-[10px] font-medium"
                  >{{ member.user.name[0] }}</span
                >
                <div class="min-w-0 flex-1">
                  <b class="block truncate text-sm">{{ member.user.name }}</b
                  ><small class="block truncate text-xs text-text-muted">{{
                    member.user.title
                  }}</small>
                </div>
                <Crown v-if="member.role === 'LEAD'" :size="14" class="text-primary" />
              </div>
            </div>
          </article>
          <div class="grid grid-cols-2 gap-3">
            <article class="stat-tile">
              <span><FolderKanban :size="20" /></span>
              <div>
                <b>{{ project.boards?.length || 0 }}</b
                ><small>Boards</small>
              </div>
            </article>
            <article class="stat-tile">
              <span><Calendar :size="20" /></span>
              <div>
                <b>{{ milestones.length }}</b
                ><small>Milestones</small>
              </div>
            </article>
          </div>
        </div>
      </div>

      <section v-else-if="activeTab === 'board'" class="space-y-4">
        <div class="flex items-center justify-between">
          <div>
            <h2 class="section-title">Boards</h2>
            <p class="section-copy">Organize delivery work into stages and tasks.</p>
          </div>
          <button class="studio-primary-button" @click="panel = 'board'">
            <Plus :size="15" /> New Board
          </button>
        </div>
        <div v-if="project.boards?.length" class="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          <article v-for="board in project.boards" :key="board.id" class="board-preview group">
            <div class="flex items-start justify-between gap-3">
              <NuxtLink :to="`/projects/${project.id}/board/${board.id}`" class="min-w-0 flex-1">
                <h3>{{ board.name }}</h3>
                <p>
                  {{ board.columns.length }} columns ·
                  {{ board.columns.reduce((sum, column) => sum + (column._count?.tasks || 0), 0) }}
                  tasks
                </p>
              </NuxtLink>
              <div class="flex items-center gap-1">
                <button
                  type="button"
                  class="route-icon-button danger"
                  :aria-label="`Delete ${board.name}`"
                  @click="removeBoard(board.id, board.name)"
                >
                  <Trash2 :size="14" />
                </button>
                <NuxtLink
                  :to="`/projects/${project.id}/board/${board.id}`"
                  class="route-icon-button"
                  :aria-label="`Open ${board.name}`"
                >
                  <ArrowRight :size="16" />
                </NuxtLink>
              </div>
            </div>
            <div class="mini-board">
              <span v-for="column in board.columns.slice(0, 4)" :key="column.id"
                ><b>{{ column.name }}</b
                ><i v-for="task in Math.min(column._count?.tasks || 0, 3)" :key="task"
              /></span>
            </div>
          </article>
        </div>
        <DeliveryFieldState
          v-else
          empty="No boards yet."
          action="Create board"
          @action="panel = 'board'"
        />
      </section>

      <section v-else-if="activeTab === 'team'" class="studio-section-card route-card">
        <div class="mb-5 flex items-center justify-between">
          <div>
            <h2>Project Team</h2>
            <p class="section-copy">People assigned to this project.</p>
          </div>
          <button class="studio-primary-button" @click="openTeamManager">
            <UserPlus :size="15" /> Add Member
          </button>
        </div>
        <div class="divide-y divide-border-subtle">
          <div
            v-for="member in project.members"
            :key="member.id"
            class="flex items-center gap-3 py-3"
          >
            <span
              class="grid h-9 w-9 place-items-center rounded-full bg-secondary text-xs font-semibold"
              >{{ member.user.name[0] }}</span
            >
            <div class="min-w-0 flex-1">
              <b class="block truncate text-sm">{{ member.user.name }}</b
              ><small class="text-xs text-text-muted">{{
                member.user.title || 'Team member'
              }}</small>
            </div>
            <select
              :value="member.role"
              class="route-compact-select"
              :aria-label="`Role for ${member.user.name}`"
              @change="onMemberRoleChange(member.user.id, $event)"
            >
              <option value="MEMBER">Member</option>
              <option value="LEAD">Lead</option>
            </select>
            <button
              type="button"
              class="route-icon-button danger"
              :aria-label="`Remove ${member.user.name}`"
              @click="removeMember(member.user.id, member.user.name)"
            >
              <UserMinus :size="15" />
            </button>
          </div>
        </div>
        <DeliveryFieldState v-if="!project.members.length" empty="No project members yet." />
      </section>

      <section v-else-if="activeTab === 'milestones'" class="studio-section-card route-card">
        <div class="mb-5 flex items-center justify-between">
          <div>
            <h2>Milestones</h2>
            <p class="section-copy">Track key delivery dates and outcomes.</p>
          </div>
          <button class="studio-primary-button" @click="panel = 'milestone'">
            <Plus :size="15" /> Add Milestone
          </button>
        </div>
        <div class="divide-y divide-border-subtle">
          <div v-for="item in milestones" :key="item.id" class="milestone-row">
            <button
              type="button"
              class="milestone-main"
              :aria-label="item.completedAt ? `Reopen ${item.name}` : `Complete ${item.name}`"
              @click="toggleMilestone(item)"
            >
              <span class="milestone-check" :class="{ done: item.completedAt }"
                ><CheckCircle2 :size="17" /></span
              ><span class="min-w-0 flex-1"
                ><b>{{ item.name }}</b
                ><small>{{ item.description || 'No description' }}</small></span
              ><time>{{ formatDate(item.dueDate) }}</time>
            </button>
            <button
              type="button"
              class="route-icon-button danger"
              :aria-label="`Delete ${item.name}`"
              @click="removeMilestone(item.id, item.name)"
            >
              <Trash2 :size="14" />
            </button>
          </div>
        </div>
        <DeliveryFieldState v-if="!milestones.length" empty="No milestones yet." />
      </section>

      <section v-else-if="activeTab === 'notes'" class="studio-section-card route-card">
        <div class="mb-5 flex items-center justify-between">
          <div>
            <h2>Notes</h2>
            <p class="section-copy">Project decisions, briefs, and working documents.</p>
          </div>
          <button class="studio-primary-button" :disabled="creatingNote" @click="createProjectNote">
            <Plus :size="15" /> {{ creatingNote ? 'Creating…' : 'New Note' }}
          </button>
        </div>
        <div class="grid gap-3 sm:grid-cols-2">
          <NuxtLink v-for="note in notes" :key="note.id" :to="`/notes/${note.id}`" class="note-card"
            ><FileText :size="18" /><span
              ><b>{{ note.title }}</b
              ><small>{{ note.contentText || 'No preview available.' }}</small></span
            ><ArrowRight :size="15"
          /></NuxtLink>
        </div>
        <DeliveryFieldState v-if="!notes.length" empty="No project notes yet." />
      </section>

      <section v-else class="studio-section-card route-card">
        <div class="mb-5 flex items-center justify-between">
          <div>
            <h2>Files</h2>
            <p class="section-copy">Project documents and external references.</p>
          </div>
          <button class="studio-primary-button" @click="panel = 'file'">
            <FilePlus2 :size="15" /> Upload File
          </button>
        </div>
        <div class="divide-y divide-border-subtle">
          <div v-for="item in files" :key="item.id" class="file-row">
            <FileText :size="18" /><a
              :href="item.url"
              target="_blank"
              rel="noreferrer"
              class="min-w-0"
              ><b>{{ item.name }}</b
              ><small>{{ item.type || 'File' }} · {{ formatDate(item.createdAt) }}</small></a
            >
            <div class="flex items-center gap-1">
              <a
                :href="item.url"
                target="_blank"
                rel="noreferrer"
                class="route-icon-button"
                :aria-label="`Open ${item.name}`"
                ><ExternalLink :size="15"
              /></a>
              <button
                type="button"
                class="route-icon-button danger"
                :aria-label="`Remove ${item.name}`"
                @click="removeFile(item.id, item.name)"
              >
                <Trash2 :size="14" />
              </button>
            </div>
          </div>
        </div>
        <DeliveryFieldState v-if="!files.length" empty="No files uploaded yet." />
      </section>

      <DeliveryProjectForm
        :open="editOpen"
        :project="project"
        @close="editOpen = false"
        @saved="load"
      />
      <DeliveryFieldDialog
        :open="!!panel"
        :title="
          panel === 'board' ? 'New Board' : panel === 'milestone' ? 'Add Milestone' : 'Upload File'
        "
        @close="panel = null"
      >
        <p v-if="actionError" class="action-error">{{ actionError }}</p>
        <form v-if="panel === 'board'" class="stack-form" @submit.prevent="createBoard">
          <label>Board name<input v-model="boardForm.name" required /></label
          ><label>Description<textarea v-model="boardForm.description" rows="3" /></label
          ><label
            >Template<select v-model="boardForm.template">
              <option value="kanban">Kanban</option>
              <option value="scrum">Scrum</option>
              <option value="simple">Simple</option>
              <option value="bugtracker">Bug tracker</option>
            </select></label
          ><button class="studio-primary-button" :disabled="saving">Create Board</button>
        </form>
        <form
          v-else-if="panel === 'milestone'"
          class="stack-form"
          @submit.prevent="createMilestone"
        >
          <label>Name<input v-model="milestoneForm.name" required /></label
          ><label>Due date<input v-model="milestoneForm.dueDate" type="date" required /></label
          ><label>Description<textarea v-model="milestoneForm.description" rows="3" /></label
          ><button class="studio-primary-button" :disabled="saving">Add Milestone</button>
        </form>
        <form v-else class="stack-form" @submit.prevent="createFile">
          <label>Display name<input v-model="fileForm.name" required /></label
          ><label>File URL<input v-model="fileForm.url" type="url" required /></label
          ><label>Type<input v-model="fileForm.type" placeholder="PDF, brief, design" /></label
          ><button class="studio-primary-button" :disabled="saving">Upload File</button>
        </form>
      </DeliveryFieldDialog>
      <DeliveryFieldDialog
        :open="teamOpen"
        title="Add project member"
        description="Choose a teammate. You can promote them to lead after adding."
        @close="teamOpen = false"
      >
        <form class="stack-form" @submit.prevent="addMember">
          <label
            >Team member<select v-model="memberDraft" required>
              <option value="" disabled>Select a teammate</option>
              <option v-for="member in teamCandidates" :key="member.id" :value="member.id">
                {{ member.name }} · {{ member.title || member.department }}
              </option>
            </select></label
          >
          <p v-if="!teamCandidates.length" class="section-copy">
            Everyone in the team directory is already assigned.
          </p>
          <button class="studio-primary-button" :disabled="saving || !memberDraft">
            <UserPlus :size="15" /> Add Member
          </button>
        </form>
      </DeliveryFieldDialog>
    </template>
  </section>
</template>

<style scoped>
.core-route {
  --route-accent: var(--accent-brand);
}
.route-hero {
  border-radius: 28px;
  padding: 24px 0;
  box-shadow: var(--shadow-xs);
}
.route-card {
  padding: 24px;
}
.route-card h2 {
  margin: 0;
  font-size: 15px;
  font-weight: 650;
}
.route-card small {
  color: var(--text-muted);
}
.route-card > div.grid > div b {
  display: block;
  margin-top: 3px;
  font-size: 13px;
}
.route-icon-button {
  display: inline-grid;
  width: 34px;
  height: 34px;
  place-items: center;
  border: 1px solid var(--border-subtle);
  border-radius: 10px;
  color: var(--text-muted);
  background: var(--surface-card);
  cursor: pointer;
  transition: 160ms ease;
}
.route-icon-button:hover {
  border-color: var(--border-strong);
  color: var(--foreground);
  background: var(--surface-sunken);
}
.route-icon-button.danger:hover {
  border-color: color-mix(in srgb, #ef4444 35%, var(--border-subtle));
  color: #ef4444;
  background: color-mix(in srgb, #ef4444 8%, var(--surface-card));
}
.route-compact-select {
  min-height: 34px;
  border: 1px solid var(--border-default);
  border-radius: 10px;
  padding: 0 28px 0 10px;
  color: var(--foreground);
  background: var(--surface-card);
  font-size: 11px;
  font-weight: 600;
}
.detail-header {
  display: flex;
  align-items: flex-start;
  gap: 20px;
  padding-bottom: 20px;
}
.detail-header h1 {
  margin: 0;
  color: var(--text-strong);
  font-size: clamp(2.1rem, 4vw, 3.15rem);
  font-weight: 650;
  line-height: 0.98;
  letter-spacing: -0.045em;
}
.studio-danger-button,
.studio-danger-icon,
.studio-ghost-button {
  min-height: 40px;
  border-radius: 12px;
  padding: 0 14px;
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
}
.studio-danger-button,
.studio-danger-icon {
  border: 1px solid #ef4444;
  color: white;
  background: #ef4444;
}
.studio-danger-icon {
  display: grid;
  width: 40px;
  place-items: center;
  padding: 0;
}
.studio-ghost-button {
  border: 0;
  color: var(--text-muted);
  background: transparent;
}
.detail-tabs {
  display: inline-flex;
  max-width: 100%;
  overflow-x: auto;
  border-radius: 12px;
  padding: 4px;
  background: var(--surface-sunken);
}
.detail-tabs button {
  min-height: 34px;
  border: 0;
  border-radius: 9px;
  padding: 0 13px;
  color: var(--text-muted);
  background: transparent;
  font-size: 12px;
  font-weight: 600;
  text-transform: capitalize;
  cursor: pointer;
}
.detail-tabs button.active {
  color: var(--foreground);
  background: var(--surface-card);
  box-shadow: var(--shadow-xs);
}
.stat-tile {
  display: flex;
  align-items: center;
  gap: 12px;
  border: 1px solid var(--border-subtle);
  border-radius: 12px;
  padding: 16px;
  background: var(--surface-card);
}
.stat-tile > span {
  display: grid;
  width: 36px;
  height: 36px;
  flex: 0 0 36px;
  place-items: center;
  border-radius: 8px;
  color: var(--primary);
  background: color-mix(in srgb, var(--primary) 10%, transparent);
}
.stat-tile b,
.stat-tile small {
  display: block;
}
.stat-tile b {
  color: var(--foreground);
  font-size: 20px;
  line-height: 1;
}
.stat-tile small {
  margin-top: 3px;
  color: var(--text-muted);
  font-size: 12px;
}
.section-title {
  margin: 0;
  color: var(--foreground);
  font-size: 18px;
  font-weight: 650;
}
.section-copy {
  margin: 3px 0 0;
  color: var(--text-muted);
  font-size: 13px;
}
.board-preview {
  display: block;
  border: 1px solid var(--border-subtle);
  border-radius: 16px;
  padding: 16px;
  background: var(--surface-card);
  transition: 0.2s ease;
}
.board-preview:hover {
  transform: translateY(-2px);
  border-color: var(--border-default);
  box-shadow: var(--shadow-md);
}
.board-preview h3 {
  margin: 0;
  font-size: 14px;
  font-weight: 650;
}
.board-preview p {
  margin: 3px 0 0;
  color: var(--text-muted);
  font-size: 11px;
}
.mini-board {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 5px;
  margin-top: 14px;
  border-radius: 10px;
  padding: 8px;
  background: var(--surface-sunken);
}
.mini-board > span {
  min-width: 0;
}
.mini-board b {
  display: block;
  overflow: hidden;
  margin-bottom: 5px;
  color: var(--text-muted);
  font-size: 7px;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.mini-board i {
  display: block;
  height: 9px;
  margin-top: 3px;
  border-radius: 3px;
  background: var(--surface-card);
  box-shadow: 0 0 0 1px var(--border-subtle);
}
.milestone-row {
  display: flex;
  width: 100%;
  align-items: center;
  gap: 12px;
  padding: 13px 2px;
  color: var(--foreground);
  background: transparent;
  text-align: left;
}
.milestone-main {
  display: flex;
  min-width: 0;
  flex: 1;
  align-items: center;
  gap: 12px;
  border: 0;
  padding: 0;
  color: inherit;
  background: transparent;
  text-align: left;
  cursor: pointer;
}
.milestone-check {
  color: var(--text-faint);
}
.milestone-check.done {
  color: #10b981;
}
.milestone-row b,
.milestone-row small {
  display: block;
}
.milestone-row b {
  font-size: 13px;
}
.milestone-row small {
  margin-top: 2px;
  font-size: 11px;
}
.milestone-row time {
  color: var(--text-muted);
  font-size: 11px;
}
.note-card,
.file-row {
  display: grid;
  grid-template-columns: 20px minmax(0, 1fr) auto;
  align-items: center;
  gap: 10px;
  color: var(--foreground);
}
.note-card {
  border: 1px solid var(--border-subtle);
  border-radius: 12px;
  padding: 13px;
}
.file-row {
  padding: 13px 2px;
}
.note-card b,
.note-card small,
.file-row b,
.file-row small {
  display: block;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.note-card b,
.file-row b {
  font-size: 13px;
}
.note-card small,
.file-row small {
  margin-top: 2px;
  font-size: 11px;
}
.stack-form {
  display: grid;
  gap: 14px;
}
.stack-form label {
  display: grid;
  gap: 6px;
  color: var(--foreground);
  font-size: 12px;
  font-weight: 600;
}
.stack-form input,
.stack-form textarea,
.stack-form select {
  min-height: 42px;
  border: 1px solid var(--border-default);
  border-radius: 12px;
  padding: 9px 12px;
  color: var(--foreground);
  background: var(--surface-card);
}
.stack-form button {
  justify-self: end;
}
.action-error {
  color: #dc2626;
  font-size: 12px;
}
@media (max-width: 700px) {
  .route-hero {
    border-radius: 22px;
  }
  .route-card {
    padding: 18px;
  }
  .detail-header {
    flex-wrap: wrap;
  }
  .detail-header > .flex {
    width: 100%;
  }
  .milestone-row time {
    display: none;
  }
}
</style>
