<script setup lang="ts">
import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  Clock,
  MessageSquare,
  Minus,
  Target,
  Timer,
  TrendingUp,
  TrendingDown,
  Trophy,
  Users,
  Zap,
} from 'lucide-vue-next';
import type { TeamMemberStats, TeamStatsOverview } from '~/types/firm';

useHead({ title: 'Team Insights · DevFathom Hub' });

const api = useFirm();
const { user } = useAuth();
const allowed = computed(() => user.value?.role === 'ADMIN');
const stats = ref<TeamStatsOverview | null>(null);
const loading = ref(allowed.value);
const error = ref('');
const showAllAlerts = ref(false);

async function load() {
  if (!allowed.value) return;
  loading.value = true;
  error.value = '';
  try {
    stats.value = await api.teamStats();
  } catch (caught: any) {
    error.value = caught?.data?.detail || 'Unable to load team stats.';
  } finally {
    loading.value = false;
  }
}

await load();

const weekDeltaPct = computed(() => {
  if (!stats.value || stats.value.totals.teamCompletedLastWeek === 0) return null;
  const delta = stats.value.totals.teamCompletedThisWeek - stats.value.totals.teamCompletedLastWeek;
  return Math.round((delta / stats.value.totals.teamCompletedLastWeek) * 100);
});
const visibleAlerts = computed(() =>
  showAllAlerts.value ? stats.value?.alerts || [] : (stats.value?.alerts || []).slice(0, 8)
);
const velocityMax = computed(() =>
  Math.max(1, ...(stats.value?.velocity.map((item) => item.count) || [1]))
);
const velocityPoints = computed(() => {
  const values = stats.value?.velocity || [];
  return values
    .map((item, index) => {
      const x = values.length > 1 ? (index / (values.length - 1)) * 680 : 0;
      const y = 170 - (item.count / velocityMax.value) * 140;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');
});
const velocityArea = computed(() =>
  velocityPoints.value ? `M 0 180 L ${velocityPoints.value.replaceAll(',', ' ')} L 680 180 Z` : ''
);
const workloadMax = computed(() =>
  Math.max(1, ...(stats.value?.members.map((item) => item.openTasks) || [1]))
);
const initials = (name: string) =>
  name
    .split(' ')
    .map((part) => part[0])
    .join('')
    .slice(0, 2)
    .toUpperCase();
const sparkline = (member: TeamMemberStats) => {
  const max = Math.max(1, ...member.tasksDoneSparkline);
  return member.tasksDoneSparkline
    .map((value, index) => `${(index / 6) * 100},${30 - (value / max) * 24}`)
    .join(' ');
};
const collaboration = (member: TeamMemberStats) => member.notesAuthored + member.commentsThisWeek;
const leaderboards = computed(() =>
  stats.value
    ? [
        {
          title: 'Top completer',
          subtitle: 'this week',
          icon: Trophy,
          members: stats.value.leaderboards.topCompleter,
          field: 'completedThisWeek',
          suffix: ' done',
        },
        {
          title: 'Best punctuality',
          subtitle: 'meetings on time',
          icon: Timer,
          members: stats.value.leaderboards.bestPunctuality,
          field: 'onTimePercent',
          suffix: '%',
        },
        {
          title: 'Fastest cycle',
          subtitle: 'avg time to Done',
          icon: Zap,
          members: stats.value.leaderboards.fastestCycle,
          field: 'avgCycleTimeDays',
          suffix: 'd',
        },
        {
          title: 'Most collaborative',
          subtitle: 'notes + comments',
          icon: MessageSquare,
          members: stats.value.leaderboards.mostCollaborative,
          field: 'collab',
          suffix: '',
        },
      ]
    : []
);
const valueFor = (member: TeamMemberStats, field: string) =>
  field === 'collab' ? collaboration(member) : member[field as keyof TeamMemberStats];
</script>

<template>
  <section class="animate-fade-in space-y-6">
    <div>
      <h1 class="font-display text-2xl font-bold tracking-tight text-foreground">Team Insights</h1>
      <p class="mt-1.5 text-[15px] text-text-muted">
        How the team is performing this week. Workload, velocity, and pulse in one place.
      </p>
    </div>

    <DeliveryFieldState
      v-if="!allowed"
      error="Team stats overview is admin-only. See your personal stats on your profile."
    />
    <DeliveryFieldState
      v-else-if="loading || error"
      :loading="loading"
      :error="error"
      action="Try again"
      @action="load"
    />

    <template v-else-if="stats">
      <div class="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <article class="rounded-xl bg-card px-5 py-9 ring-1 ring-foreground/10">
          <div class="flex items-start justify-between gap-3">
            <div>
              <p class="text-[13px] font-medium text-text-muted">Completed this week</p>
              <strong
                class="mt-1 block text-3xl font-bold tracking-tight tabular-nums text-foreground"
                >{{ stats.totals.teamCompletedThisWeek }}</strong
              >
              <div v-if="weekDeltaPct !== null" class="mt-1 flex items-center gap-1 text-xs">
                <TrendingUp v-if="weekDeltaPct > 0" :size="12" class="text-emerald-500" />
                <TrendingDown v-else-if="weekDeltaPct < 0" :size="12" class="text-amber-500" />
                <Minus v-else :size="12" class="text-text-muted" />
                <span
                  v-if="weekDeltaPct !== 0"
                  class="font-medium"
                  :class="weekDeltaPct > 0 ? 'text-emerald-500' : 'text-amber-500'"
                  >{{ weekDeltaPct > 0 ? '+' : '' }}{{ weekDeltaPct }}%</span
                >
                <span class="text-text-muted">{{
                  weekDeltaPct === 0 ? 'no change' : 'vs last week'
                }}</span>
              </div>
            </div>
            <span
              class="flex size-10 shrink-0 items-center justify-center rounded-xl bg-emerald-500/10 text-emerald-500"
              ><CheckCircle2 :size="20"
            /></span>
          </div>
        </article>
        <article class="rounded-xl bg-card px-5 py-9 ring-1 ring-foreground/10">
          <div class="flex items-start justify-between gap-3">
            <div>
              <p class="text-[13px] font-medium text-text-muted">Open tasks</p>
              <strong
                class="mt-1 block text-3xl font-bold tracking-tight tabular-nums text-foreground"
                >{{ stats.totals.teamOpenTasks }}</strong
              >
              <p class="mt-1 text-[11px] text-text-muted">
                {{ stats.totals.teamMembers - stats.totals.membersWithNoTasks }}/{{
                  stats.totals.teamMembers
                }}
                with active work
              </p>
            </div>
            <span
              class="flex size-10 shrink-0 items-center justify-center rounded-xl bg-blue-500/10 text-blue-500"
              ><Activity :size="20"
            /></span>
          </div>
        </article>
        <article class="rounded-xl bg-card px-5 py-9 ring-1 ring-foreground/10">
          <div class="flex items-start justify-between gap-3">
            <div>
              <p class="text-[13px] font-medium text-text-muted">Overdue</p>
              <strong
                class="mt-1 block text-3xl font-bold tracking-tight tabular-nums text-foreground"
                >{{ stats.totals.teamOverdue }}</strong
              >
            </div>
            <span
              class="flex size-10 shrink-0 items-center justify-center rounded-xl"
              :class="
                stats.totals.teamOverdue > 0
                  ? 'bg-amber-500/10 text-amber-500'
                  : 'bg-muted text-text-muted'
              "
              ><Clock :size="20"
            /></span>
          </div>
        </article>
        <article class="rounded-xl bg-card px-5 py-9 ring-1 ring-foreground/10">
          <div class="flex items-start justify-between gap-3">
            <div>
              <p class="text-[13px] font-medium text-text-muted">Team size</p>
              <strong
                class="mt-1 block text-3xl font-bold tracking-tight tabular-nums text-foreground"
                >{{ stats.totals.teamMembers }}</strong
              >
              <p class="mt-1 text-[11px] text-text-muted">
                {{
                  stats.totals.membersWithNoTasks
                    ? stats.totals.membersWithNoTasks + ' idle'
                    : 'everyone has work'
                }}
              </p>
            </div>
            <span
              class="flex size-10 shrink-0 items-center justify-center rounded-xl bg-violet-500/10 text-violet-500"
              ><Users :size="20"
            /></span>
          </div>
        </article>
      </div>

      <section
        v-if="stats.alerts.length"
        class="overflow-hidden rounded-xl bg-amber-500/[0.02] py-4 ring-1 ring-amber-500/20"
      >
        <header
          class="flex items-center gap-2 border-b border-amber-500/10 px-5 py-4 text-xs font-semibold uppercase tracking-wider text-amber-700"
        >
          <AlertTriangle :size="15" /> Heads-up · {{ stats.alerts.length }}
          {{ stats.alerts.length === 1 ? 'thing needs' : 'things need' }} attention
        </header>
        <div class="divide-y divide-amber-500/10 px-5">
          <div
            v-for="alert in visibleAlerts"
            :key="`${alert.userId}-${alert.kind}`"
            class="flex items-start gap-3 py-3 text-sm"
          >
            <span
              class="mt-1 size-2 rounded-full"
              :class="
                alert.severity === 'high'
                  ? 'bg-red-500'
                  : alert.severity === 'medium'
                    ? 'bg-amber-500'
                    : 'bg-yellow-400'
              "
            />
            <p>
              <strong>{{ alert.name }}</strong> {{ alert.message }}
            </p>
          </div>
        </div>
        <button
          v-if="stats.alerts.length > 8"
          class="w-full border-t border-amber-500/10 py-3 text-sm font-semibold text-amber-700"
          @click="showAllAlerts = !showAllAlerts"
        >
          {{ showAllAlerts ? 'Show less' : `Show ${stats.alerts.length - 8} more` }}
        </button>
      </section>

      <section class="rounded-xl bg-card p-5 ring-1 ring-foreground/10 sm:p-6">
        <header class="mb-6">
          <h2 class="flex items-center gap-2 text-[15px] font-semibold">
            <span class="grid size-7 place-items-center rounded-lg bg-emerald-50 text-emerald-600"
              ><TrendingUp :size="15"
            /></span>
            Team velocity · last 30 days
          </h2>
          <p class="mt-1 pl-9 text-xs text-[var(--text-muted)]">
            Tasks moved to Done per day across the whole team
          </p>
        </header>
        <div class="relative h-52 overflow-hidden rounded-2xl bg-[var(--surface-sunken)] p-4">
          <div
            class="absolute inset-x-4 top-1/4 border-t border-dashed border-[var(--border-default)]"
          />
          <div
            class="absolute inset-x-4 top-1/2 border-t border-dashed border-[var(--border-default)]"
          />
          <div
            class="absolute inset-x-4 top-3/4 border-t border-dashed border-[var(--border-default)]"
          />
          <svg
            viewBox="0 0 680 180"
            preserveAspectRatio="none"
            class="relative h-full w-full"
            role="img"
            aria-label="Team velocity for the last 30 days"
          >
            <defs>
              <linearGradient id="velocity-fill" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0" stop-color="#10b981" stop-opacity=".22" />
                <stop offset="1" stop-color="#10b981" stop-opacity="0" />
              </linearGradient>
            </defs>
            <path :d="velocityArea" fill="url(#velocity-fill)" />
            <polyline
              :points="velocityPoints"
              fill="none"
              stroke="#059669"
              stroke-width="3"
              stroke-linecap="round"
              stroke-linejoin="round"
              vector-effect="non-scaling-stroke"
            />
          </svg>
        </div>
        <div class="mt-3 flex justify-between font-mono text-[10px] text-[var(--text-muted)]">
          <span>{{ stats.velocity[0]?.date }}</span
          ><span>{{ stats.velocity[14]?.date }}</span
          ><span>{{ stats.velocity.at(-1)?.date }}</span>
        </div>
      </section>

      <div class="grid gap-5 lg:grid-cols-5">
        <section class="rounded-xl bg-card p-5 ring-1 ring-foreground/10 sm:p-6 lg:col-span-3">
          <header class="mb-6">
            <h2 class="flex items-center gap-2 text-[15px] font-semibold">
              <span class="grid size-7 place-items-center rounded-lg bg-blue-50 text-blue-600"
                ><Target :size="15"
              /></span>
              Workload distribution
            </h2>
            <p class="mt-1 pl-9 text-xs text-[var(--text-muted)]">
              Open tasks per member · imbalances are easy to spot here
            </p>
          </header>
          <div class="space-y-4">
            <div
              v-for="member in stats.members"
              :key="member.userId"
              class="grid grid-cols-[minmax(90px,150px)_minmax(0,1fr)_30px] items-center gap-3"
            >
              <span class="truncate text-sm font-medium">{{ member.name }}</span>
              <div class="h-8 overflow-hidden rounded-lg bg-[var(--surface-sunken)]">
                <div
                  class="h-full rounded-lg bg-[var(--foreground)] transition-[width]"
                  :style="{
                    width: `${Math.max(member.openTasks ? 6 : 0, (member.openTasks / workloadMax) * 100)}%`,
                  }"
                />
              </div>
              <strong class="font-mono text-xs">{{ member.openTasks }}</strong>
            </div>
          </div>
        </section>

        <div class="space-y-4 lg:col-span-2">
          <section
            v-for="board in leaderboards"
            :key="board.title"
            class="rounded-xl bg-card p-4 ring-1 ring-foreground/10"
          >
            <header class="mb-3 flex items-center gap-3">
              <span class="grid size-8 place-items-center rounded-xl bg-[var(--surface-sunken)]"
                ><component :is="board.icon" :size="15"
              /></span>
              <div>
                <h3 class="text-sm font-semibold">{{ board.title }}</h3>
                <p class="text-[11px] text-[var(--text-muted)]">{{ board.subtitle }}</p>
              </div>
            </header>
            <div v-if="board.members.length" class="space-y-2">
              <div
                v-for="(member, index) in board.members"
                :key="member.userId"
                class="grid grid-cols-[20px_30px_minmax(0,1fr)_auto] items-center gap-2 rounded-xl bg-[var(--surface-sunken)] px-3 py-2"
              >
                <span class="font-mono text-[10px] text-[var(--text-muted)]">{{ index + 1 }}</span
                ><span
                  class="grid size-7 place-items-center rounded-full bg-[var(--foreground)] text-[9px] font-semibold text-[var(--primary-foreground)]"
                  >{{ initials(member.name) }}</span
                ><span class="truncate text-xs font-medium">{{ member.name }}</span
                ><strong class="font-mono text-[11px]"
                  >{{ valueFor(member, board.field) }}{{ board.suffix }}</strong
                >
              </div>
            </div>
            <p v-else class="py-2 text-xs text-[var(--text-muted)]">Not enough data yet.</p>
          </section>
        </div>
      </div>

      <section>
        <h2 class="mb-3 text-xs font-semibold uppercase tracking-wider text-[var(--text-muted)]">
          Individual stats
        </h2>
        <div class="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          <article
            v-for="member in stats.members"
            :key="member.userId"
            class="rounded-xl bg-card p-5 ring-1 ring-foreground/10"
          >
            <header class="flex items-center gap-3">
              <span
                class="grid size-11 place-items-center overflow-hidden rounded-full bg-[var(--foreground)] text-xs font-semibold text-[var(--primary-foreground)]"
                ><img
                  v-if="member.avatar"
                  :src="member.avatar"
                  :alt="member.name"
                  class="h-full w-full object-cover"
                />
                <template v-else>{{ initials(member.name) }}</template></span
              >
              <div class="min-w-0">
                <NuxtLink
                  :to="`/team/${member.userId}`"
                  class="truncate text-sm font-semibold hover:underline"
                  >{{ member.name }}</NuxtLink
                >
                <p class="truncate text-xs text-[var(--text-muted)]">
                  {{ member.title || 'Team member' }}
                </p>
              </div>
            </header>
            <svg
              viewBox="0 0 100 32"
              preserveAspectRatio="none"
              class="mt-5 h-10 w-full"
              aria-hidden="true"
            >
              <polyline
                :points="sparkline(member)"
                fill="none"
                stroke="var(--accent-brand)"
                stroke-width="2"
                stroke-linecap="round"
                stroke-linejoin="round"
                vector-effect="non-scaling-stroke"
              />
            </svg>
            <div
              class="mt-4 grid grid-cols-3 gap-2 border-t border-[var(--border-subtle)] pt-4 text-center"
            >
              <div>
                <strong class="block font-mono text-sm">{{ member.openTasks }}</strong
                ><span class="text-[10px] text-[var(--text-muted)]">Open</span>
              </div>
              <div>
                <strong class="block font-mono text-sm">{{ member.completedThisWeek }}</strong
                ><span class="text-[10px] text-[var(--text-muted)]">Done</span>
              </div>
              <div>
                <strong class="block font-mono text-sm"
                  >{{ member.onTimePercent ?? '—'
                  }}{{
                    member.onTimePercent !== null && member.onTimePercent !== undefined ? '%' : ''
                  }}</strong
                ><span class="text-[10px] text-[var(--text-muted)]">On time</span>
              </div>
            </div>
          </article>
        </div>
      </section>
    </template>
  </section>
</template>
