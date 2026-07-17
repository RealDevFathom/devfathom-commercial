<script setup lang="ts">
import {
  CalendarClock,
  CalendarDays,
  CalendarOff,
  CalendarPlus,
  Check,
  DoorOpen,
  Palmtree,
  PartyPopper,
  Plus,
  UserPlus,
  Users,
  X,
} from 'lucide-vue-next';
import type { LeaveBalance, LeaveRequest, Resignation, TeamMember } from '~/types/firm';

useHead({ title: 'HR · DevFathom Hub' });

const api = useFirm();
const { user } = useAuth();
const admin = computed(() => user.value?.role === 'ADMIN');
const manager = computed(() => ['ADMIN', 'HR'].includes(user.value?.role || ''));
const tab = ref<'overview' | 'leave' | 'balances' | 'calendar' | 'resignations'>('overview');
const leaveFilter = ref<'ALL' | 'PENDING' | 'APPROVED' | 'REJECTED'>('ALL');
const leave = ref<LeaveRequest[]>([]);
const balances = ref<LeaveBalance[]>([]);
const resignations = ref<Resignation[]>([]);
const team = ref<TeamMember[]>([]);
const loading = ref(true);
const error = ref('');
const leaveOpen = ref(false);
const resignOpen = ref(false);
const balanceOpen = ref(false);
const leaveDraft = reactive({ type: 'VACATION', start_date: '', end_date: '', reason: '' });
const resignation = reactive({ reason: '', proposed_last_day: '' });
const balanceDraft = reactive({
  user_id: '',
  year: new Date().getFullYear(),
  type: 'VACATION',
  entitled_days: 0,
});

async function load() {
  loading.value = true;
  error.value = '';
  try {
    const [leaveResult, balanceResult, resignationResult] = await Promise.all([
      api.leave(!manager.value),
      api.balances(),
      api.resignations(!manager.value),
    ]);
    leave.value = leaveResult;
    balances.value = balanceResult.types;
    resignations.value = resignationResult;
    if (manager.value && !team.value.length) team.value = await api.team();
  } catch (caught: any) {
    error.value = caught?.data?.detail || 'The HR register is unavailable.';
  } finally {
    loading.value = false;
  }
}

await load();

const date = (value: string) =>
  new Intl.DateTimeFormat('en', { dateStyle: 'medium' }).format(new Date(value));
const today = computed(() => new Date().toISOString().slice(0, 10));
const outToday = computed(
  () =>
    leave.value.filter(
      (item) =>
        item.status === 'APPROVED' &&
        item.startDate.slice(0, 10) <= today.value &&
        item.endDate.slice(0, 10) >= today.value
    ).length
);
const upcomingLeave = computed(() =>
  leave.value
    .filter((item) => item.status === 'APPROVED')
    .sort((a, b) => a.startDate.localeCompare(b.startDate))
);
const pendingLeave = computed(() => leave.value.filter((item) => item.status === 'PENDING'));
const filteredLeave = computed(() =>
  leave.value.filter((item) => leaveFilter.value === 'ALL' || item.status === leaveFilter.value)
);
const recentHires = computed(() => {
  const cutoff = Date.now() - 30 * 86_400_000;
  return team.value
    .filter((member) => member.startDate && new Date(member.startDate).getTime() >= cutoff)
    .sort((a, b) => String(b.startDate).localeCompare(String(a.startDate)));
});
const upcomingAnniversaries = computed(() => {
  const now = new Date();
  return team.value
    .flatMap((member) => {
      if (!member.startDate) return [];
      const started = new Date(member.startDate);
      let anniversary = new Date(now.getFullYear(), started.getMonth(), started.getDate());
      if (anniversary < new Date(now.getFullYear(), now.getMonth(), now.getDate())) {
        anniversary = new Date(now.getFullYear() + 1, started.getMonth(), started.getDate());
      }
      const days = Math.ceil((anniversary.getTime() - now.getTime()) / 86_400_000);
      if (days > 30) return [];
      return [{ member, anniversary, years: anniversary.getFullYear() - started.getFullYear() }];
    })
    .sort((a, b) => a.anniversary.getTime() - b.anniversary.getTime());
});
const initials = (name: string) =>
  name
    .split(' ')
    .map((part) => part[0])
    .join('')
    .slice(0, 2)
    .toUpperCase();

async function requestLeave() {
  await api.requestLeave({
    ...leaveDraft,
    start_date: new Date(leaveDraft.start_date).toISOString(),
    end_date: new Date(leaveDraft.end_date).toISOString(),
    reason: leaveDraft.reason || null,
  });
  leaveOpen.value = false;
  await load();
}

async function decideLeave(id: string, status: string) {
  await api.decideLeave(id, status);
  await load();
}

async function submitResignation() {
  await api.resign({
    reason: resignation.reason,
    proposed_last_day: new Date(resignation.proposed_last_day).toISOString(),
  });
  resignOpen.value = false;
  await load();
}

async function decideResignation(id: string, decision: string) {
  const review_note = prompt('Optional review note:') || null;
  await api.decideResignation(id, { decision, review_note });
  await load();
}

async function setBalance() {
  await api.setBalance(balanceDraft);
  balanceOpen.value = false;
  await load();
}
</script>

<template>
  <section class="animate-fade-in space-y-6">
    <div>
      <h1 class="font-display text-2xl font-bold tracking-tight text-foreground">HR</h1>
      <p class="mt-1.5 text-[15px] text-text-muted">Leave, headcount, and people operations.</p>
    </div>

    <nav
      class="inline-flex h-8 w-fit max-w-full items-center gap-0.5 overflow-x-auto rounded-lg bg-muted p-[3px] text-text-muted"
      aria-label="HR sections"
    >
      <button
        class="h-[26px] rounded-md px-1.5 py-0.5 text-sm font-medium"
        :class="tab === 'overview' ? 'bg-card text-foreground shadow-sm' : 'hover:text-foreground'"
        @click="tab = 'overview'"
      >
        Overview
      </button>
      <button
        class="h-[26px] rounded-md px-1.5 py-0.5 text-sm font-medium"
        :class="tab === 'leave' ? 'bg-card text-foreground shadow-sm' : 'hover:text-foreground'"
        @click="tab = 'leave'"
      >
        Leave
      </button>
      <button
        class="h-[26px] rounded-md px-1.5 py-0.5 text-sm font-medium"
        :class="tab === 'balances' ? 'bg-card text-foreground shadow-sm' : 'hover:text-foreground'"
        @click="tab = 'balances'"
      >
        Balances
      </button>
      <button
        class="h-[26px] rounded-md px-1.5 py-0.5 text-sm font-medium"
        :class="tab === 'calendar' ? 'bg-card text-foreground shadow-sm' : 'hover:text-foreground'"
        @click="tab = 'calendar'"
      >
        Calendar
      </button>
      <button
        class="h-[26px] rounded-md px-1.5 py-0.5 text-sm font-medium"
        :class="
          tab === 'resignations' ? 'bg-card text-foreground shadow-sm' : 'hover:text-foreground'
        "
        @click="tab = 'resignations'"
      >
        Resignations
      </button>
    </nav>

    <DeliveryFieldState
      v-if="loading || error"
      :loading="loading"
      :error="error"
      action="Try again"
      @action="load"
    />

    <template v-else>
      <DeliveryFieldState
        v-if="tab === 'overview' && !admin"
        empty="Overview is available to admins only."
      />
      <div v-else-if="tab === 'overview'" class="space-y-6">
        <div class="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <article
            v-for="item in [
              {
                label: 'Out today',
                value: outToday,
                hint: outToday ? `${outToday} on leave` : 'Nobody out',
                icon: CalendarOff,
                tone: 'amber',
              },
              {
                label: 'Pending approvals',
                value: pendingLeave.length,
                hint: pendingLeave.length ? 'Awaiting review' : 'All clear',
                icon: CalendarClock,
                tone: pendingLeave.length ? 'orange' : 'emerald',
              },
              {
                label: 'Recent hires',
                value: recentHires.length,
                hint: 'Last 30 days',
                icon: UserPlus,
                tone: 'blue',
              },
              {
                label: 'Active headcount',
                value: team.filter((member) => member.status !== 'INACTIVE').length,
                hint: '',
                icon: Users,
                tone: 'violet',
              },
            ]"
            :key="item.label"
            class="rounded-xl bg-card px-5 py-9 ring-1 ring-foreground/10"
          >
            <div class="flex items-center gap-2">
              <span
                class="flex size-7 items-center justify-center rounded-md"
                :class="{
                  'bg-amber-500/10 text-amber-500': item.tone === 'amber',
                  'bg-orange-500/10 text-orange-500': item.tone === 'orange',
                  'bg-emerald-500/10 text-emerald-500': item.tone === 'emerald',
                  'bg-blue-500/10 text-blue-500': item.tone === 'blue',
                  'bg-violet-500/10 text-violet-500': item.tone === 'violet',
                }"
                ><component :is="item.icon" :size="14"
              /></span>
              <p class="text-[11px] font-medium uppercase tracking-wider text-text-muted">
                {{ item.label }}
              </p>
            </div>
            <strong
              class="mt-2 block text-3xl font-bold tabular-nums"
              :class="{
                'text-amber-500': item.tone === 'amber',
                'text-orange-500': item.tone === 'orange',
                'text-emerald-500': item.tone === 'emerald',
                'text-blue-500': item.tone === 'blue',
                'text-violet-500': item.tone === 'violet',
              }"
              >{{ item.value }}</strong
            >
            <p v-if="item.hint" class="mt-1 text-[11px] text-text-muted">{{ item.hint }}</p>
          </article>
        </div>

        <div class="grid gap-5 lg:grid-cols-2">
          <section class="overflow-hidden rounded-xl bg-card py-4 ring-1 ring-foreground/10">
            <header class="flex items-center gap-2 px-4 pb-2">
              <span class="grid size-7 place-items-center rounded-lg bg-amber-500/10 text-amber-600"
                ><CalendarOff :size="15"
              /></span>
              <h2 class="text-[15px] font-semibold">Out today</h2>
            </header>
            <div class="divide-y divide-border-subtle px-4">
              <article
                v-for="item in leave.filter(
                  (entry) =>
                    entry.status === 'APPROVED' &&
                    entry.startDate.slice(0, 10) <= today &&
                    entry.endDate.slice(0, 10) >= today
                )"
                :key="item.id"
                class="flex items-center gap-3 py-3"
              >
                <span
                  class="grid size-9 place-items-center rounded-full bg-[var(--surface-sunken)] text-xs font-semibold"
                  >{{ initials(item.userName || 'Team member') }}</span
                >
                <div class="min-w-0 flex-1">
                  <strong class="block truncate text-sm">{{ item.userName }}</strong
                  ><small class="text-xs text-[var(--text-muted)]"
                    >Back {{ date(item.endDate) }}</small
                  >
                </div>
                <span class="studio-status-pill" data-tone="neutral">{{ item.type }}</span>
              </article>
              <DeliveryFieldState v-if="!outToday" empty="Everyone's in." />
            </div>
          </section>
          <section class="overflow-hidden rounded-xl bg-card py-4 ring-1 ring-foreground/10">
            <header class="flex items-center gap-2 px-4 pb-2">
              <span
                class="grid size-7 place-items-center rounded-lg bg-orange-500/10 text-orange-600"
                ><CalendarClock :size="15"
              /></span>
              <h2 class="text-[15px] font-semibold">Pending approvals</h2>
            </header>
            <div class="divide-y divide-border-subtle px-4">
              <article
                v-for="item in pendingLeave.slice(0, 5)"
                :key="item.id"
                class="flex items-center gap-3 py-3"
              >
                <span
                  class="grid size-9 place-items-center rounded-full bg-[var(--surface-sunken)] text-xs font-semibold"
                  >{{ initials(item.userName || 'Team member') }}</span
                >
                <div class="min-w-0 flex-1">
                  <strong class="block truncate text-sm">{{ item.userName }}</strong
                  ><small class="text-xs text-[var(--text-muted)]"
                    >{{ date(item.startDate) }} – {{ date(item.endDate) }}</small
                  >
                </div>
                <span class="studio-status-pill" data-tone="neutral">{{ item.type }}</span>
              </article>
              <DeliveryFieldState v-if="!pendingLeave.length" empty="Nothing pending." />
            </div>
          </section>
          <section class="overflow-hidden rounded-xl bg-card py-4 ring-1 ring-foreground/10">
            <header class="flex items-center gap-2 px-4 pb-2">
              <span class="grid size-7 place-items-center rounded-lg bg-blue-500/10 text-blue-600"
                ><UserPlus :size="15"
              /></span>
              <h2 class="text-[15px] font-semibold">Recent hires</h2>
            </header>
            <div class="divide-y divide-border-subtle px-4">
              <NuxtLink
                v-for="member in recentHires"
                :key="member.id"
                :to="`/team/${member.id}`"
                class="-mx-4 flex items-center gap-3 px-4 py-3 transition-colors hover:bg-secondary/30"
              >
                <span
                  class="grid size-9 place-items-center rounded-full bg-[var(--surface-sunken)] text-xs font-semibold"
                  >{{ initials(member.name) }}</span
                >
                <div class="min-w-0 flex-1">
                  <strong class="block truncate text-sm">{{ member.name }}</strong
                  ><small class="text-xs text-[var(--text-muted)]">{{ member.title }}</small>
                </div>
                <span class="studio-status-pill" data-tone="neutral">{{ member.department }}</span>
              </NuxtLink>
              <DeliveryFieldState
                v-if="!recentHires.length"
                empty="No hires in the last 30 days."
              />
            </div>
          </section>
          <section class="overflow-hidden rounded-xl bg-card py-4 ring-1 ring-foreground/10">
            <header class="flex items-center gap-2 px-4 pb-2">
              <span class="grid size-7 place-items-center rounded-lg bg-pink-500/10 text-pink-600"
                ><PartyPopper :size="15"
              /></span>
              <h2 class="text-[15px] font-semibold">Upcoming anniversaries</h2>
            </header>
            <div class="divide-y divide-border-subtle px-4">
              <NuxtLink
                v-for="item in upcomingAnniversaries"
                :key="item.member.id"
                :to="`/team/${item.member.id}`"
                class="-mx-4 flex items-center gap-3 px-4 py-3 transition-colors hover:bg-secondary/30"
              >
                <span
                  class="grid size-9 place-items-center rounded-full bg-[var(--surface-sunken)] text-xs font-semibold"
                  >{{ initials(item.member.name) }}</span
                >
                <div class="min-w-0 flex-1">
                  <strong class="block truncate text-sm">{{ item.member.name }}</strong
                  ><small class="text-xs text-[var(--text-muted)]">{{ item.member.title }}</small>
                </div>
                <span class="font-mono text-[10px] text-[var(--text-muted)]"
                  >{{ item.years }}y on {{ date(item.anniversary.toISOString()) }}</span
                >
              </NuxtLink>
              <DeliveryFieldState
                v-if="!upcomingAnniversaries.length"
                empty="Nothing in the next 30 days."
              />
            </div>
          </section>
        </div>
      </div>

      <div v-else-if="tab === 'leave'" class="space-y-6">
        <div class="flex flex-wrap items-center justify-between gap-3">
          <p class="text-sm text-text-muted">
            {{
              pendingLeave.length
                ? `${pendingLeave.length} pending request${pendingLeave.length === 1 ? '' : 's'}.`
                : 'All requests processed.'
            }}
          </p>
          <button class="studio-primary-button" @click="leaveOpen = true">
            <CalendarPlus :size="16" /> Request Leave
          </button>
        </div>
        <form
          v-if="leaveOpen"
          class="space-y-4 rounded-xl bg-card p-5 ring-1 ring-primary/20"
          @submit.prevent="requestLeave"
        >
          <div class="flex items-center justify-between">
            <h3 class="text-sm font-semibold text-foreground">New Leave Request</h3>
            <button
              type="button"
              class="text-text-muted hover:text-foreground"
              @click="leaveOpen = false"
            >
              ×
            </button>
          </div>
          <div class="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <label class="studio-field"
              >Type<select v-model="leaveDraft.type">
                <option>VACATION</option>
                <option>SICK</option>
                <option>REMOTE</option>
              </select></label
            ><label class="studio-field"
              >Start Date<input v-model="leaveDraft.start_date" type="date" required /></label
            ><label class="studio-field"
              >End Date<input v-model="leaveDraft.end_date" type="date" required
            /></label>
          </div>
          <label class="studio-field"
            >Reason (optional)<input v-model="leaveDraft.reason" placeholder="Brief reason..."
          /></label>
          <div class="flex justify-end gap-2">
            <button
              type="button"
              class="rounded-xl px-4 py-2 text-xs font-medium text-text-muted"
              @click="leaveOpen = false"
            >
              Cancel</button
            ><button class="studio-primary-button">Submit Request</button>
          </div>
        </form>
        <nav class="flex flex-wrap items-center gap-1.5" aria-label="Leave request filters">
          <button
            v-for="filter in ['ALL', 'PENDING', 'APPROVED', 'REJECTED'] as const"
            :key="filter"
            class="rounded-lg px-3 py-1.5 text-xs font-medium transition-colors"
            :class="
              leaveFilter === filter
                ? 'bg-foreground text-background'
                : 'text-text-muted hover:bg-secondary hover:text-foreground'
            "
            @click="leaveFilter = filter"
          >
            {{ filter === 'ALL' ? 'All' : filter.charAt(0) + filter.slice(1).toLowerCase() }}
          </button>
        </nav>
        <section class="overflow-hidden rounded-xl bg-card py-4 ring-1 ring-foreground/10">
          <div class="divide-y divide-border-subtle">
            <article
              v-for="item in filteredLeave"
              :key="item.id"
              class="flex items-center gap-4 px-6 py-4"
            >
              <span
                class="grid size-10 shrink-0 place-items-center rounded-full bg-secondary text-sm font-medium"
                >{{ initials(item.userName || 'My request') }}</span
              >
              <div class="min-w-0 flex-1">
                <strong class="text-sm font-semibold text-foreground">{{
                  item.userName || 'My request'
                }}</strong>
                <p class="truncate text-xs text-text-muted">
                  {{ date(item.startDate) }} – {{ date(item.endDate)
                  }}{{ item.reason ? ` · ${item.reason}` : '' }}
                </p>
              </div>
              <span
                class="shrink-0 rounded-full px-2.5 py-1 text-[11px] font-medium"
                :class="
                  item.type === 'VACATION'
                    ? 'bg-blue-500/10 text-blue-500'
                    : item.type === 'SICK'
                      ? 'bg-red-500/10 text-red-500'
                      : 'bg-violet-500/10 text-violet-500'
                "
                >{{ item.type.charAt(0) + item.type.slice(1).toLowerCase() }}</span
              >
              <span
                class="shrink-0 rounded-full px-2.5 py-1 text-[11px] font-medium"
                :class="
                  item.status === 'APPROVED'
                    ? 'bg-emerald-500/10 text-emerald-500'
                    : item.status === 'REJECTED'
                      ? 'bg-red-500/10 text-red-500'
                      : 'bg-amber-500/10 text-amber-500'
                "
                >{{ item.status.charAt(0) + item.status.slice(1).toLowerCase() }}</span
              >
              <div
                v-if="manager && item.status === 'PENDING'"
                class="flex shrink-0 items-center gap-1"
              >
                <template v-if="manager && item.status === 'PENDING'">
                  <button
                    class="flex size-8 items-center justify-center rounded-lg text-emerald-500 hover:bg-emerald-500/10"
                    aria-label="Approve"
                    @click="decideLeave(item.id, 'APPROVED')"
                  >
                    <Check :size="16" />
                  </button>
                  <button
                    class="flex size-8 items-center justify-center rounded-lg text-red-500 hover:bg-red-500/10"
                    aria-label="Reject"
                    @click="decideLeave(item.id, 'REJECTED')"
                  >
                    <X :size="16" />
                  </button>
                </template>
              </div>
            </article>
            <DeliveryFieldState v-if="!filteredLeave.length" empty="No leave requests" />
          </div>
        </section>
      </div>

      <section
        v-else-if="tab === 'balances'"
        class="overflow-hidden rounded-xl bg-card py-4 ring-1 ring-foreground/10"
      >
        <header
          class="flex flex-wrap items-center justify-between gap-4 border-b border-[var(--border-subtle)] p-5 sm:p-6"
        >
          <div>
            <h2 class="text-[15px] font-semibold">Leave balances</h2>
            <p class="mt-1 text-sm text-[var(--text-muted)]">
              Entitlement and usage for the current year.
            </p>
          </div>
          <button v-if="manager" class="studio-primary-button" @click="balanceOpen = true">
            <Plus :size="16" /> Set entitlement
          </button>
        </header>
        <div class="grid gap-4 p-5 sm:grid-cols-2 sm:p-6 xl:grid-cols-3">
          <article
            v-for="item in balances"
            :key="item.type"
            class="rounded-2xl border border-[var(--border-subtle)] p-5"
          >
            <div class="flex items-center justify-between">
              <span
                class="text-xs font-semibold uppercase tracking-wider text-[var(--text-muted)]"
                >{{ item.type }}</span
              ><Palmtree :size="17" />
            </div>
            <strong class="mt-6 block text-3xl font-semibold">{{ item.remaining }}</strong>
            <p class="mt-1 text-sm text-[var(--text-muted)]">
              days remaining · {{ item.usedDays }} of {{ item.entitledDays }} used
            </p>
            <progress
              class="studio-progress mt-4"
              :value="item.usedDays"
              :max="Math.max(item.entitledDays, 1)"
            />
          </article>
        </div>
      </section>

      <section
        v-else-if="tab === 'calendar'"
        class="overflow-hidden rounded-xl bg-card py-4 ring-1 ring-foreground/10"
      >
        <header class="border-b border-[var(--border-subtle)] p-5 sm:p-6">
          <h2 class="text-[15px] font-semibold">Leave calendar</h2>
          <p class="mt-1 text-sm text-[var(--text-muted)]">
            Approved leave in chronological order.
          </p>
        </header>
        <div class="divide-y divide-[var(--border-subtle)]">
          <article
            v-for="item in upcomingLeave"
            :key="item.id"
            class="grid gap-3 p-5 sm:grid-cols-[130px_minmax(0,1fr)_auto] sm:items-center sm:p-6"
          >
            <time class="font-mono text-xs text-[var(--text-muted)]">{{
              date(item.startDate)
            }}</time>
            <div>
              <strong class="text-sm font-semibold">{{ item.userName || 'My leave' }}</strong>
              <p class="mt-1 text-sm text-[var(--text-muted)]">
                {{ item.type }} through {{ date(item.endDate) }}
              </p>
            </div>
            <span class="studio-status-pill" data-tone="success">Approved</span>
          </article>
          <DeliveryFieldState
            v-if="!upcomingLeave.length"
            empty="No approved leave is scheduled."
          />
        </div>
      </section>

      <section v-else class="overflow-hidden rounded-xl bg-card py-4 ring-1 ring-foreground/10">
        <header
          class="flex flex-wrap items-center justify-between gap-4 border-b border-[var(--border-subtle)] p-5 sm:p-6"
        >
          <div>
            <h2 class="text-[15px] font-semibold">Resignations</h2>
            <p class="mt-1 text-sm text-[var(--text-muted)]">
              Formal employment departure requests.
            </p>
          </div>
          <button class="studio-outline-button" @click="resignOpen = true">
            <DoorOpen :size="16" /> Submit resignation
          </button>
        </header>
        <div class="divide-y divide-[var(--border-subtle)]">
          <article
            v-for="item in resignations"
            :key="item.id"
            class="grid gap-4 p-5 sm:grid-cols-[44px_minmax(0,1fr)_auto] sm:items-center sm:p-6"
          >
            <span class="grid size-11 place-items-center rounded-2xl bg-[var(--surface-sunken)]"
              ><DoorOpen :size="17"
            /></span>
            <div>
              <strong class="text-sm font-semibold">{{ item.userName || 'My resignation' }}</strong>
              <p class="mt-1 text-sm text-[var(--text-muted)]">
                Proposed last day · {{ date(item.proposedLastDay) }}
              </p>
              <p class="mt-2 text-sm">{{ item.reason }}</p>
            </div>
            <div class="flex items-center gap-2 sm:justify-end">
              <span
                class="studio-status-pill"
                :data-tone="
                  item.status === 'APPROVED'
                    ? 'success'
                    : item.status === 'DECLINED'
                      ? 'danger'
                      : 'neutral'
                "
                >{{ item.status }}</span
              >
              <template v-if="manager && item.status === 'PENDING'">
                <button
                  class="studio-icon-button"
                  aria-label="Approve"
                  @click="decideResignation(item.id, 'APPROVED')"
                >
                  <Check :size="16" />
                </button>
                <button
                  class="studio-icon-button"
                  aria-label="Decline"
                  @click="decideResignation(item.id, 'DECLINED')"
                >
                  <X :size="16" />
                </button>
              </template>
              <button
                v-else-if="!manager && item.status === 'PENDING'"
                class="studio-outline-button"
                @click="api.withdrawResignation(item.id).then(load)"
              >
                Withdraw
              </button>
            </div>
          </article>
          <DeliveryFieldState v-if="!resignations.length" empty="No resignations are filed." />
        </div>
      </section>
    </template>

    <DeliveryFieldDialog :open="false" title="Request leave" @close="leaveOpen = false">
      <form class="studio-form-grid" @submit.prevent="requestLeave">
        <label
          >Type<select v-model="leaveDraft.type">
            <option>VACATION</option>
            <option>SICK</option>
            <option>REMOTE</option>
          </select></label
        >
        <div class="grid gap-3 sm:grid-cols-2">
          <label>Starts<input v-model="leaveDraft.start_date" type="date" required /></label
          ><label>Ends<input v-model="leaveDraft.end_date" type="date" required /></label>
        </div>
        <label>Reason<textarea v-model="leaveDraft.reason" rows="4" /></label>
        <button class="studio-primary-button">Submit request</button>
      </form>
    </DeliveryFieldDialog>

    <DeliveryFieldDialog
      :open="resignOpen"
      title="Submit resignation"
      description="This begins a formal HR review and can be withdrawn while pending."
      @close="resignOpen = false"
    >
      <form class="studio-form-grid" @submit.prevent="submitResignation">
        <label
          >Reason<textarea v-model="resignation.reason" rows="5" minlength="10" required />
        </label>
        <label
          >Proposed last day<input v-model="resignation.proposed_last_day" type="date" required
        /></label>
        <button class="studio-primary-button">Submit resignation</button>
      </form>
    </DeliveryFieldDialog>

    <DeliveryFieldDialog
      :open="balanceOpen"
      title="Set leave entitlement"
      @close="balanceOpen = false"
    >
      <form class="studio-form-grid" @submit.prevent="setBalance">
        <label
          >Member<select v-model="balanceDraft.user_id" required>
            <option value="">Choose member</option>
            <option v-for="member in team" :key="member.id" :value="member.id">
              {{ member.name }}
            </option>
          </select></label
        >
        <div class="grid gap-3 sm:grid-cols-2">
          <label
            >Type<select v-model="balanceDraft.type">
              <option>VACATION</option>
              <option>SICK</option>
              <option>REMOTE</option>
            </select></label
          ><label
            >Days<input
              v-model.number="balanceDraft.entitled_days"
              type="number"
              min="0"
              max="366"
              required
          /></label>
        </div>
        <button class="studio-primary-button">Set entitlement</button>
      </form>
    </DeliveryFieldDialog>
  </section>
</template>
