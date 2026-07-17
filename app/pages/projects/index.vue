<script setup lang="ts">
import {
  ArrowUpDown,
  ArrowUpRight,
  Building2,
  Clock,
  FolderKanban,
  Layers,
  LayoutGrid,
  List,
  Plus,
  Search,
  Upload,
} from 'lucide-vue-next';
import type { Project } from '~/types/delivery';

type ViewMode = 'grid' | 'list';
type FilterStatus = 'ALL' | Project['status'];
type FilterType = 'ALL' | Project['type'];
type SortKey = 'recent' | 'name' | 'progress' | 'deadline';

useHead({ title: 'Projects · DevFathom Hub' });
const delivery = useDelivery();
const projects = ref<Project[]>([]);
const loading = ref(true);
const error = ref('');
const formOpen = ref(false);
const view = ref<ViewMode>('grid');
const search = ref('');
const statusFilter = ref<FilterStatus>('ALL');
const typeFilter = ref<FilterType>('ALL');
const sort = ref<SortKey>('recent');
const grouped = ref(false);

const statusOrder: Project['status'][] = [
  'ACTIVE',
  'IN_DEVELOPMENT',
  'ON_HOLD',
  'COMPLETED',
  'CANCELLED',
];

const statusConfig: Record<string, { label: string; dot: string; rail: string; badge: string }> = {
  ACTIVE: {
    label: 'Active',
    dot: 'bg-emerald-500',
    rail: 'bg-emerald-500',
    badge: 'bg-emerald-500/10 text-emerald-600',
  },
  IN_DEVELOPMENT: {
    label: 'In Development',
    dot: 'bg-blue-500',
    rail: 'bg-blue-500',
    badge: 'bg-blue-500/10 text-blue-600',
  },
  ON_HOLD: {
    label: 'On Hold',
    dot: 'bg-amber-500',
    rail: 'bg-amber-500',
    badge: 'bg-amber-500/10 text-amber-600',
  },
  COMPLETED: {
    label: 'Completed',
    dot: 'bg-text-muted',
    rail: 'bg-text-muted/40',
    badge: 'bg-muted text-text-muted',
  },
  CANCELLED: {
    label: 'Cancelled',
    dot: 'bg-red-400',
    rail: 'bg-red-500',
    badge: 'bg-red-500/10 text-red-500',
  },
};
const statusPill: Record<string, string> = {
  ALL: 'All',
  ACTIVE: 'Active',
  IN_DEVELOPMENT: 'Dev',
  ON_HOLD: 'Hold',
  COMPLETED: 'Done',
};

async function load() {
  loading.value = true;
  error.value = '';
  try {
    projects.value = await delivery.listProjects();
  } catch (caught: any) {
    error.value = caught?.data?.detail || 'The project index is unavailable.';
  } finally {
    loading.value = false;
  }
}
await load();

function progress(project: Project) {
  const milestones = project.milestones || [];
  if (!milestones.length) return null;
  const done = milestones.filter((milestone) => Boolean(milestone.completedAt)).length;
  return { done, total: milestones.length, pct: Math.round((done / milestones.length) * 100) };
}

function deadline(project: Project) {
  if (['COMPLETED', 'CANCELLED'].includes(project.status)) return null;
  const dates = (project.milestones || [])
    .filter((item) => !item.completedAt)
    .map((item) => item.dueDate)
    .filter((value): value is string => Boolean(value))
    .map((value) => new Date(value));
  return (
    dates.sort((a, b) => a.getTime() - b.getTime())[0] ||
    (project.endDate ? new Date(project.endDate) : null)
  );
}

function deadlineLabel(project: Project) {
  const value = deadline(project);
  if (!value) return null;
  const days = Math.ceil((value.getTime() - Date.now()) / 86_400_000);
  if (days < 0) return { label: `${Math.abs(days)}d overdue`, tone: 'text-red-500' };
  if (days === 0) return { label: 'Due today', tone: 'text-red-500' };
  if (days <= 3) return { label: `Due in ${days}d`, tone: 'text-red-500' };
  if (days <= 14) return { label: `${days}d left`, tone: 'text-amber-500' };
  return {
    label: new Intl.DateTimeFormat('en', { month: 'short', day: 'numeric' }).format(value),
    tone: 'text-text-muted',
  };
}

const filtered = computed(() => {
  const query = search.value.trim().toLowerCase();
  const rows = projects.value.filter((project) => {
    if (
      query &&
      !`${project.name} ${project.client?.name || ''} ${project.techStack.join(' ')}`
        .toLowerCase()
        .includes(query)
    )
      return false;
    if (statusFilter.value !== 'ALL' && project.status !== statusFilter.value) return false;
    if (typeFilter.value !== 'ALL' && project.type !== typeFilter.value) return false;
    return true;
  });
  const ordered = [...rows];
  if (sort.value === 'name') return ordered.sort((a, b) => a.name.localeCompare(b.name));
  if (sort.value === 'progress')
    return ordered.sort((a, b) => (progress(b)?.pct ?? -1) - (progress(a)?.pct ?? -1));
  if (sort.value === 'deadline')
    return ordered.sort(
      (a, b) =>
        (deadline(a)?.getTime() ?? Number.POSITIVE_INFINITY) -
        (deadline(b)?.getTime() ?? Number.POSITIVE_INFINITY)
    );
  return ordered;
});

const counts = computed(() => ({
  total: projects.value.length,
  active: projects.value.filter((project) => project.status === 'ACTIVE').length,
  dev: projects.value.filter((project) => project.status === 'IN_DEVELOPMENT').length,
  hold: projects.value.filter((project) => project.status === 'ON_HOLD').length,
  done: projects.value.filter((project) => project.status === 'COMPLETED').length,
}));

const statChips = computed<Array<{ label: string; value: number; dot?: string }>>(() => [
  { label: 'Total', value: counts.value.total },
  { label: 'Active', value: counts.value.active, dot: 'bg-emerald-500' },
  { label: 'In Dev', value: counts.value.dev, dot: 'bg-blue-500' },
  { label: 'On Hold', value: counts.value.hold, dot: 'bg-amber-500' },
  { label: 'Completed', value: counts.value.done, dot: 'bg-text-muted' },
]);

const groups = computed(() =>
  statusOrder
    .map((status) => ({
      status,
      items: filtered.value.filter((project) => project.status === status),
    }))
    .filter((group) => group.items.length)
);
</script>

<template>
  <section class="core-route animate-fade-in space-y-6">
    <PageHeader
      eyebrow="Delivery"
      title="Projects"
      description="Delivery across every client engagement and internal build."
    >
      <NuxtLink to="/projects/import" class="studio-outline-button"
        ><Upload :size="16" /> Import from Trello</NuxtLink
      >
      <button class="studio-primary-button" @click="formOpen = true">
        <Plus :size="16" /> New Project
      </button>
    </PageHeader>

    <div class="route-metrics flex flex-wrap items-center gap-2">
      <div
        v-for="chip in statChips"
        :key="chip.label"
        class="inline-flex min-h-8 items-center gap-1.5 rounded-[3px] border border-border-default bg-card px-2.5 py-1"
      >
        <span v-if="chip.dot" class="h-1.5 w-1.5 rounded-full" :class="chip.dot" />
        <strong class="text-sm font-semibold tabular-nums text-foreground">{{ chip.value }}</strong
        ><span class="text-xs text-text-muted">{{ chip.label }}</span>
      </div>
    </div>

    <div class="route-command-panel flex flex-col gap-3 lg:flex-row lg:items-center">
      <div class="relative w-full lg:max-w-xs">
        <Search :size="16" class="absolute left-3 top-1/2 -translate-y-1/2 text-text-muted" /><input
          v-model="search"
          placeholder="Search name, client, tech…"
          class="h-10 w-full rounded-xl border border-border bg-card pl-9 pr-4 text-sm text-foreground outline-none focus:border-primary focus:ring-2 focus:ring-primary/20"
        />
      </div>
      <div class="flex flex-1 flex-wrap items-center gap-1.5">
        <button
          v-for="status in ['ALL', 'ACTIVE', 'IN_DEVELOPMENT', 'ON_HOLD', 'COMPLETED'] as const"
          :key="status"
          class="rounded-lg px-3 py-1.5 text-xs font-medium transition-colors"
          :class="
            statusFilter === status
              ? 'bg-foreground text-background'
              : 'text-text-muted hover:bg-secondary hover:text-foreground'
          "
          @click="statusFilter = status"
        >
          {{ statusPill[status] }}
        </button>
        <span class="mx-1 hidden h-4 w-px bg-border sm:block" />
        <button
          v-for="type in ['ALL', 'CLIENT', 'INTERNAL'] as const"
          :key="type"
          class="rounded-lg px-3 py-1.5 text-xs font-medium transition-colors"
          :class="
            typeFilter === type
              ? 'bg-foreground text-background'
              : 'text-text-muted hover:bg-secondary hover:text-foreground'
          "
          @click="typeFilter = type"
        >
          {{ type === 'ALL' ? 'All types' : type.charAt(0) + type.slice(1).toLowerCase() }}
        </button>
      </div>
      <div class="flex items-center gap-2">
        <label class="relative"
          ><ArrowUpDown
            :size="14"
            class="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-text-muted"
          /><select
            v-model="sort"
            aria-label="Sort projects"
            class="h-10 appearance-none rounded-xl border border-border bg-card pl-8 pr-7 text-sm font-medium text-foreground outline-none"
          >
            <option value="recent">Recent</option>
            <option value="name">Name</option>
            <option value="progress">Progress</option>
            <option value="deadline">Deadline</option>
          </select></label
        >
        <button
          class="flex h-10 items-center gap-1.5 rounded-xl border px-3 text-sm font-medium"
          :class="
            grouped
              ? 'border-primary/30 bg-primary/10 text-primary'
              : 'border-border bg-card text-text-muted'
          "
          @click="grouped = !grouped"
        >
          <Layers :size="16" /><span class="hidden sm:inline">Group</span>
        </button>
        <div class="flex h-10 items-center rounded-xl border border-border bg-card p-0.5">
          <button
            class="grid h-8 w-8 place-items-center rounded-lg"
            :class="view === 'grid' ? 'bg-secondary text-foreground' : 'text-text-muted'"
            aria-label="Grid view"
            @click="view = 'grid'"
          >
            <LayoutGrid :size="16" /></button
          ><button
            class="grid h-8 w-8 place-items-center rounded-lg"
            :class="view === 'list' ? 'bg-secondary text-foreground' : 'text-text-muted'"
            aria-label="List view"
            @click="view = 'list'"
          >
            <List :size="16" />
          </button>
        </div>
      </div>
    </div>

    <DeliveryFieldState
      v-if="loading || error"
      :loading="loading"
      :error="error"
      action="Try again"
      @action="load"
    />
    <DeliveryFieldState
      v-else-if="!filtered.length"
      empty="No projects match this view."
      action="New project"
      @action="formOpen = true"
    />

    <template v-else>
      <div v-if="grouped" class="space-y-8">
        <section v-for="group in groups" :key="group.status" class="space-y-3">
          <h2 class="flex items-center gap-2 text-sm font-semibold text-foreground">
            <span class="h-2 w-2 rounded-full" :class="statusConfig[group.status]?.dot" />{{
              statusConfig[group.status]?.label
            }}<span class="rounded-full bg-secondary px-2 py-0.5 text-[11px] text-text-muted">{{
              group.items.length
            }}</span>
          </h2>
          <div class="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
            <NuxtLink
              v-for="project in group.items"
              :key="project.id"
              :to="`/projects/${project.id}`"
              class="production-grid-card project-card group relative min-h-40 overflow-hidden bg-card transition-all hover:-translate-y-0.5 hover:shadow-lg"
            >
              <span
                class="absolute inset-y-0 left-0 w-1"
                :class="statusConfig[project.status]?.rail"
              />
              <div class="flex items-start justify-between gap-3">
                <div class="min-w-0">
                  <h3
                    class="truncate text-base font-semibold text-foreground group-hover:text-accent-brand"
                  >
                    {{ project.name }}
                  </h3>
                  <p class="mt-1 truncate text-xs text-text-muted">
                    {{ project.client?.name || 'Internal product' }}
                  </p>
                </div>
                <span
                  class="shrink-0 rounded-full px-2.5 py-1 text-[11px] font-medium"
                  :class="statusConfig[project.status]?.badge"
                  >{{ statusConfig[project.status]?.label }}</span
                >
              </div>
              <p
                v-if="project.description"
                class="mt-3 line-clamp-2 text-sm leading-relaxed text-text-muted"
              >
                {{ project.description }}
              </p>
              <div
                class="mt-5 flex items-center justify-between border-t border-border-subtle pt-3"
              >
                <span class="text-xs text-text-muted">{{ project._count?.boards || 0 }} boards</span
                ><ArrowUpRight :size="16" class="text-text-faint group-hover:text-accent-brand" />
              </div>
            </NuxtLink>
          </div>
        </section>
      </div>

      <div v-else-if="view === 'grid'" class="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
        <NuxtLink
          v-for="project in filtered"
          :key="project.id"
          :to="`/projects/${project.id}`"
          class="group block rounded-[24px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
        >
          <article
            class="production-grid-card project-card relative h-full overflow-hidden bg-card transition-all hover:-translate-y-0.5 hover:shadow-lg"
          >
            <span
              class="absolute inset-y-0 left-0 w-1"
              :class="statusConfig[project.status]?.rail"
            />
            <div class="flex items-start justify-between gap-3">
              <div class="min-w-0">
                <h3
                  class="truncate text-base font-semibold text-foreground group-hover:text-accent-brand"
                >
                  {{ project.name }}
                </h3>
                <div class="mt-1 flex items-center gap-1.5 text-xs text-text-muted">
                  <span
                    v-if="project.type === 'INTERNAL'"
                    class="rounded bg-secondary px-1.5 py-0.5 text-[10px] font-medium"
                    >Internal</span
                  ><template v-else
                    ><Building2 :size="14" /><span class="truncate">{{
                      project.client?.name || 'Client'
                    }}</span></template
                  >
                </div>
              </div>
              <span
                class="shrink-0 rounded-full px-2.5 py-1 text-[11px] font-medium"
                :class="statusConfig[project.status]?.badge"
                >{{ statusConfig[project.status]?.label }}</span
              >
            </div>
            <p
              v-if="project.description"
              class="mt-3 line-clamp-2 text-sm leading-relaxed text-text-muted"
            >
              {{ project.description }}
            </p>
            <div v-if="progress(project)" class="mt-4">
              <div class="mb-1.5 flex items-center justify-between text-[11px]">
                <span class="font-medium text-text-muted">Milestones</span
                ><strong class="text-foreground"
                  >{{ progress(project)?.done }}/{{ progress(project)?.total }} ·
                  {{ progress(project)?.pct }}%</strong
                >
              </div>
              <div class="h-1.5 overflow-hidden rounded-full bg-muted">
                <div
                  class="h-full rounded-full bg-accent-brand"
                  :style="{ width: `${progress(project)?.pct}%` }"
                />
              </div>
            </div>
            <div v-if="project.techStack.length" class="mt-4 flex flex-wrap gap-1.5">
              <span
                v-for="tech in project.techStack.slice(0, 4)"
                :key="tech"
                class="rounded-md bg-secondary px-2 py-0.5 text-[11px] font-medium text-text-muted"
                >{{ tech }}</span
              ><span
                v-if="project.techStack.length > 4"
                class="rounded-md bg-secondary px-2 py-0.5 text-[11px] text-text-muted"
                >+{{ project.techStack.length - 4 }}</span
              >
            </div>
            <div class="mt-4 flex items-center justify-between border-t border-border-subtle pt-3">
              <div class="flex -space-x-2">
                <span
                  v-for="member in project.members.slice(0, 5)"
                  :key="member.user.id"
                  class="grid h-7 w-7 place-items-center rounded-full border-2 border-card bg-secondary text-[10px] font-medium"
                  >{{ member.user.name[0] }}</span
                ><span
                  v-if="project.members.length > 5"
                  class="grid h-7 w-7 place-items-center rounded-full border-2 border-card bg-secondary text-[10px] font-semibold text-text-muted"
                  >+{{ project.members.length - 5 }}</span
                ><span v-if="!project.members.length" class="text-xs text-text-muted"
                  >Unassigned</span
                >
              </div>
              <div class="flex items-center gap-3 text-xs text-text-muted">
                <span
                  v-if="deadlineLabel(project)"
                  class="flex items-center gap-1 font-medium"
                  :class="deadlineLabel(project)?.tone"
                  ><Clock :size="14" />{{ deadlineLabel(project)?.label }}</span
                ><span v-if="project._count?.boards" class="flex items-center gap-1"
                  ><FolderKanban :size="14" />{{ project._count.boards }}</span
                ><ArrowUpRight
                  :size="16"
                  class="opacity-0 group-hover:text-accent-brand group-hover:opacity-100"
                />
              </div>
            </div>
          </article>
        </NuxtLink>
      </div>

      <div v-else class="space-y-1.5">
        <div
          class="hidden items-center gap-4 px-5 pb-1 text-[11px] font-medium uppercase tracking-wide text-text-muted md:flex"
        >
          <span class="flex-1">Project</span><span class="w-40">Progress</span
          ><span class="hidden w-20 text-right lg:block">Team</span
          ><span class="hidden w-24 text-right lg:block">Due</span
          ><span class="w-28 text-right">Status</span><span class="w-4" />
        </div>
        <NuxtLink
          v-for="project in filtered"
          :key="project.id"
          :to="`/projects/${project.id}`"
          class="group relative flex items-center gap-4 overflow-hidden rounded-lg border border-border-default bg-card p-4 pl-5 hover:bg-accent/40"
          ><span
            class="absolute inset-y-0 left-0 w-1"
            :class="statusConfig[project.status]?.rail" />
          <div class="min-w-0 flex-1">
            <div class="flex items-center gap-2">
              <h3
                class="truncate text-sm font-semibold text-foreground group-hover:text-accent-brand"
              >
                {{ project.name }}
              </h3>
              <span
                v-if="project.type === 'INTERNAL'"
                class="shrink-0 rounded bg-secondary px-1.5 py-0.5 text-[10px] font-medium text-text-muted"
                >Internal</span
              >
            </div>
            <p class="mt-0.5 truncate text-xs text-text-muted">
              {{ project.client?.name || project.description || 'Internal product' }}
            </p>
          </div>
          <div class="hidden w-40 items-center gap-2 md:flex">
            <div
              v-if="progress(project)"
              class="h-1.5 flex-1 overflow-hidden rounded-full bg-muted"
            >
              <div
                class="h-full bg-accent-brand"
                :style="{ width: `${progress(project)?.pct}%` }"
              />
            </div>
            <span class="w-9 text-right text-[11px] font-semibold"
              >{{ progress(project)?.pct ?? '—' }}%</span
            >
          </div>
          <div class="hidden w-20 justify-end -space-x-1.5 lg:flex">
            <span
              v-for="member in project.members.slice(0, 3)"
              :key="member.user.id"
              class="grid h-6 w-6 place-items-center rounded-full border-2 border-card bg-secondary text-[9px]"
              >{{ member.user.name[0] }}</span
            ><span
              v-if="project.members.length > 3"
              class="grid h-6 w-6 place-items-center rounded-full border-2 border-card bg-secondary text-[9px] font-semibold text-text-muted"
              >+{{ project.members.length - 3 }}</span
            >
          </div>
          <span
            class="hidden w-24 text-right text-xs lg:block"
            :class="deadlineLabel(project)?.tone"
            >{{ deadlineLabel(project)?.label || '—' }}</span
          ><span
            class="w-28 rounded-full px-2.5 py-1 text-center text-[11px] font-medium"
            :class="statusConfig[project.status]?.badge"
            >{{ statusConfig[project.status]?.label }}</span
          ><ArrowUpRight :size="16" class="text-text-faint group-hover:text-accent-brand"
        /></NuxtLink>
      </div>
    </template>

    <DeliveryProjectForm :open="formOpen" @close="formOpen = false" @saved="load" />
  </section>
</template>

<style scoped>
.production-grid-card {
  padding: 36px 20px 36px 24px;
}
.route-metrics,
.route-command-panel {
  border: 1px solid var(--border-default);
  border-radius: 18px;
  padding: 12px;
  background: var(--surface-card);
}
.route-command-panel {
  padding: 14px;
}
.project-card {
  border: 1px solid var(--border-default);
  border-radius: 24px;
  box-shadow: var(--shadow-xs);
}
</style>
