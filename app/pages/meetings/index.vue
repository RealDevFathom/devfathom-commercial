<script setup lang="ts">
import {
  Calendar,
  Check,
  ChevronDown,
  Clock,
  MapPin,
  Pencil,
  Plus,
  Radio,
  RefreshCw,
  Trash2,
  Users,
  Video,
} from 'lucide-vue-next';
import type { Meeting } from '~/types/collaboration';

useHead({ title: 'Meetings · DevFathom Hub' });
const api = useMeetings();
const { user } = useAuth();
const meetings = ref<Meeting[]>([]);
const upcoming = ref<Meeting[]>([]);
const loading = ref(true);
const error = ref('');
const formOpen = ref(false);
const attendanceOpen = ref<string | null>(null);
const clock = ref(Date.now());
let clockTimer: ReturnType<typeof setInterval> | undefined;
const recurrenceLabels = {
  daily: 'Daily',
  weekly: 'Weekly',
  biweekly: 'Bi-weekly',
  monthly: 'Monthly',
} as const;

async function load() {
  loading.value = true;
  error.value = '';
  try {
    [upcoming.value, meetings.value] = await Promise.all([api.upcoming(), api.list()]);
  } catch (caught: any) {
    error.value = caught?.data?.detail || 'The meeting register is unavailable.';
  } finally {
    loading.value = false;
  }
}
await load();

onMounted(() => {
  clock.value = Date.now();
  clockTimer = setInterval(() => (clock.value = Date.now()), 1000);
});
onBeforeUnmount(() => {
  if (clockTimer) clearInterval(clockTimer);
});

const nextMeeting = computed(
  () => upcoming.value.find((meeting) => new Date(meeting.endTime).getTime() > clock.value) || null
);
const nextCountdown = computed(() =>
  nextMeeting.value ? getMeetingCountdown(nextMeeting.value, clock.value) : null
);

const pastMeetings = computed(() =>
  meetings.value
    .filter((meeting) => !meeting.recurrence && new Date(meeting.startTime).getTime() < Date.now())
    .slice(0, 10)
);

function dateLabel(value: string) {
  const date = new Date(value);
  const today = new Date();
  const tomorrow = new Date();
  tomorrow.setDate(today.getDate() + 1);
  if (date.toDateString() === today.toDateString()) return 'Today';
  if (date.toDateString() === tomorrow.toDateString()) return 'Tomorrow';
  return new Intl.DateTimeFormat('en', { weekday: 'short', month: 'short', day: 'numeric' }).format(
    date
  );
}

function time(value: string) {
  return new Intl.DateTimeFormat('en', { hour: 'numeric', minute: '2-digit' }).format(
    new Date(value)
  );
}

function joinedCount(meeting: Meeting) {
  return meeting.attendees.filter((attendee) => attendee.joinedAt).length;
}

function canJoin(meeting: Meeting) {
  return (
    meeting.attendees.some((attendee) => attendee.user.id === user.value?.id) &&
    new Date(meeting.endTime).getTime() > clock.value
  );
}

function isLive(meeting: Meeting) {
  return getMeetingPhase(meeting, clock.value) === 'live';
}

function joinedByMe(meeting: Meeting) {
  return meeting.attendees.some(
    (attendee) => attendee.user.id === user.value?.id && attendee.joinedAt
  );
}

async function joinExternal(meeting: Meeting) {
  let opened: Window | null = null;
  if (meeting.location) {
    const href = meeting.location.startsWith('http')
      ? meeting.location
      : `https://${meeting.location}`;
    opened = window.open(href, '_blank', 'noopener,noreferrer');
  }
  await api.join(meeting.id).catch(() => undefined);
  await load();
  opened?.focus();
}

async function removeMeeting(meeting: Meeting) {
  if (!confirm(`Delete “${meeting.title}”?`)) return;
  await api.remove(meeting.id);
  await load();
}
</script>

<template>
  <section class="animate-fade-in space-y-6">
    <header class="flex items-end justify-between gap-4">
      <div>
        <h1 class="font-display text-2xl font-bold tracking-tight text-foreground">Meetings</h1>
        <p class="mt-1.5 text-[15px] text-text-muted">
          {{ upcoming.length }} upcoming · Schedule and manage your meetings.
        </p>
      </div>
      <button
        class="flex items-center gap-2 rounded-xl bg-primary px-4 py-2.5 text-sm font-semibold text-white transition-all hover:bg-[#0C2E2C] active:scale-[0.98]"
        @click="formOpen = true"
      >
        <Plus :size="16" /> Schedule Meeting
      </button>
    </header>

    <CollaborationMeetingForm :open="formOpen" @close="formOpen = false" @saved="load" />
    <DeliveryFieldState
      v-if="loading || error"
      :loading="loading"
      :error="error"
      action="Try again"
      @action="load"
    />

    <template v-else>
      <article
        v-if="nextMeeting && nextCountdown"
        class="overflow-hidden rounded-2xl border bg-card shadow-[var(--shadow-xs)]"
        :class="nextCountdown.phase === 'live' ? 'border-emerald-500/35' : 'border-border-subtle'"
      >
        <div class="flex flex-col gap-5 p-5 sm:flex-row sm:items-center sm:p-6">
          <div
            class="grid h-12 w-12 shrink-0 place-items-center rounded-xl"
            :class="
              nextCountdown.phase === 'live'
                ? 'bg-emerald-500/10 text-emerald-600'
                : 'bg-primary/10 text-primary'
            "
          >
            <Radio v-if="nextCountdown.phase === 'live'" :size="21" />
            <Video v-else :size="21" />
          </div>
          <div class="min-w-0 flex-1">
            <div class="flex flex-wrap items-center gap-2">
              <span
                class="text-[11px] font-semibold uppercase tracking-[0.12em]"
                :class="nextCountdown.phase === 'live' ? 'text-emerald-600' : 'text-accent-brand'"
              >
                {{ nextCountdown.phase === 'live' ? 'Live now' : 'Up next' }}
              </span>
              <span class="text-xs text-text-muted">· {{ dateLabel(nextMeeting.startTime) }}</span>
            </div>
            <NuxtLink
              :to="`/meetings/${nextMeeting.id}`"
              class="mt-1 block truncate text-lg font-semibold text-foreground hover:text-accent-brand"
            >
              {{ nextMeeting.title }}
            </NuxtLink>
            <p class="mt-1 truncate text-xs text-text-muted">
              {{ time(nextMeeting.startTime) }} – {{ time(nextMeeting.endTime) }}
              <template v-if="nextMeeting.location"> · {{ nextMeeting.location }}</template>
            </p>
          </div>
          <div class="flex items-center justify-between gap-4 sm:justify-end">
            <div class="shrink-0 text-right" aria-live="polite">
              <p class="text-[10px] font-medium uppercase tracking-wider text-text-muted">
                {{ nextCountdown.phase === 'live' ? 'Live for' : 'Starts in' }}
              </p>
              <p
                class="mt-1 font-mono text-xl font-semibold tabular-nums text-foreground"
                data-allow-mismatch="text"
              >
                {{ nextCountdown.hours }}:{{ nextCountdown.minutes }}:{{ nextCountdown.seconds }}
              </p>
            </div>
            <NuxtLink
              v-if="canJoin(nextMeeting)"
              :to="`/meetings/${nextMeeting.id}/call`"
              class="inline-flex min-h-10 items-center gap-1.5 rounded-xl px-4 text-sm font-semibold text-white"
              :class="
                nextCountdown.phase === 'live'
                  ? 'bg-emerald-600 hover:bg-emerald-700'
                  : 'bg-primary hover:bg-[#0C2E2C]'
              "
            >
              <Video :size="15" /> {{ nextCountdown.phase === 'live' ? 'Join now' : 'Join call' }}
            </NuxtLink>
          </div>
        </div>
      </article>

      <section>
        <h2 class="mb-3 flex items-center gap-2 text-[15px] font-semibold text-foreground">
          <span class="grid h-6 w-6 place-items-center rounded-md bg-primary/10"
            ><Calendar :size="14" class="text-primary" /></span
          >Upcoming
        </h2>
        <div
          v-if="!upcoming.length"
          class="flex flex-col items-center justify-center rounded-2xl border border-dashed border-border py-16"
        >
          <Video :size="40" class="text-text-faint/20" />
          <p class="mt-3 text-sm text-text-muted">No upcoming meetings</p>
          <button
            class="mt-3 text-xs font-medium text-accent-brand hover:underline"
            @click="formOpen = true"
          >
            Schedule one
          </button>
        </div>
        <div v-else class="space-y-3">
          <article
            v-for="meeting in upcoming"
            :key="meeting.id"
            class="group rounded-xl border border-border-subtle bg-card transition-colors hover:border-border-strong"
          >
            <div class="flex items-center gap-4 p-4">
              <div class="w-20 shrink-0 text-center">
                <p class="text-xs font-medium text-accent-brand">
                  {{ dateLabel(meeting.startTime) }}
                </p>
                <strong class="block text-lg font-bold leading-tight text-foreground">{{
                  time(meeting.startTime).split(' ')[0]
                }}</strong
                ><small class="text-[10px] text-text-muted"
                  >{{ time(meeting.startTime).split(' ')[1] }} – {{ time(meeting.endTime) }}</small
                >
              </div>
              <div class="h-10 w-px bg-border-subtle" />
              <div class="min-w-0 flex-1">
                <div class="flex items-center gap-2">
                  <NuxtLink
                    :to="`/meetings/${meeting.id}`"
                    class="truncate text-sm font-semibold text-foreground hover:underline"
                    >{{ meeting.title }}</NuxtLink
                  ><span
                    v-if="meeting.recurrence"
                    class="flex shrink-0 items-center gap-0.5 rounded-md bg-violet-500/10 px-1.5 py-0.5 text-[10px] font-medium text-violet-500"
                    ><RefreshCw :size="10" />{{ recurrenceLabels[meeting.recurrence] }}</span
                  >
                </div>
                <div class="mt-1 flex items-center gap-3 text-xs text-text-muted">
                  <span v-if="meeting.location" class="flex items-center gap-1"
                    ><MapPin :size="12" />{{ meeting.location }}</span
                  ><button
                    class="flex items-center gap-1 hover:text-foreground"
                    @click="attendanceOpen = attendanceOpen === meeting.id ? null : meeting.id"
                  >
                    <Users :size="12" />{{
                      new Date(meeting.startTime).getTime() <= Date.now()
                        ? `${joinedCount(meeting)}/${meeting.attendees.length} joined`
                        : `${meeting.attendees.length} invited`
                    }}
                    <ChevronDown
                      :size="12"
                      class="transition-transform"
                      :class="{ 'rotate-180': attendanceOpen === meeting.id }"
                    />
                  </button>
                </div>
                <p v-if="meeting.description" class="mt-1 truncate text-xs text-text-muted">
                  {{ meeting.description }}
                </p>
              </div>
              <div class="hidden -space-x-1.5 sm:flex">
                <span
                  v-for="attendee in meeting.attendees.slice(0, 4)"
                  :key="attendee.user.id"
                  class="relative grid h-7 w-7 place-items-center rounded-full border-2 bg-secondary text-[9px] font-medium"
                  :class="attendee.joinedAt ? 'border-emerald-500' : 'border-card'"
                  ><img
                    v-if="attendee.user.avatar"
                    :src="attendee.user.avatar"
                    :alt="attendee.user.name"
                    class="h-full w-full rounded-full object-cover" /><template v-else>{{
                    attendee.user.name[0]
                  }}</template
                  ><i
                    v-if="attendee.joinedAt"
                    class="absolute -bottom-0.5 -right-0.5 grid h-3 w-3 place-items-center rounded-full bg-emerald-500 ring-2 ring-card"
                    ><Check :size="8" class="text-white" /></i></span
                ><span
                  v-if="meeting.attendees.length > 4"
                  class="grid h-7 w-7 place-items-center rounded-full border-2 border-card bg-secondary text-[9px] font-semibold text-text-muted"
                  >+{{ meeting.attendees.length - 4 }}</span
                >
              </div>
              <NuxtLink
                v-if="canJoin(meeting)"
                :to="`/meetings/${meeting.id}/call`"
                class="hidden items-center gap-1.5 rounded-xl border border-border bg-card px-3.5 py-2 text-xs font-semibold text-foreground hover:bg-secondary sm:flex"
                ><Video :size="14" /> {{ isLive(meeting) ? 'Join now' : 'Join call' }}</NuxtLink
              >
              <button
                v-if="canJoin(meeting) && meeting.location"
                type="button"
                class="hidden items-center gap-1.5 rounded-xl px-3.5 py-2 text-xs font-semibold transition-colors sm:flex"
                :class="
                  joinedByMe(meeting)
                    ? 'border border-emerald-500/30 bg-emerald-500/10 text-emerald-600 hover:bg-emerald-500/15'
                    : isLive(meeting)
                      ? 'bg-emerald-600 text-white hover:bg-emerald-700'
                      : 'bg-primary text-white hover:bg-[#0C2E2C]'
                "
                @click="joinExternal(meeting)"
              >
                <Check v-if="joinedByMe(meeting)" :size="14" />
                <Video v-else :size="14" />
                {{
                  joinedByMe(meeting) ? 'Joined · Rejoin' : isLive(meeting) ? 'Join now' : 'Join'
                }}
              </button>
              <div class="flex items-center gap-0.5">
                <NuxtLink
                  :to="`/meetings/${meeting.id}`"
                  class="grid h-8 w-8 place-items-center rounded-lg text-text-muted transition-all hover:!bg-secondary hover:!text-foreground sm:text-text-muted/0 sm:group-hover:text-text-muted"
                  title="Edit"
                >
                  <Pencil :size="14" />
                </NuxtLink>
                <button
                  class="grid h-8 w-8 place-items-center rounded-lg text-text-muted transition-all hover:!bg-red-500/10 hover:!text-red-500 sm:text-text-muted/0 sm:group-hover:text-text-muted"
                  title="Delete"
                  @click="removeMeeting(meeting)"
                >
                  <Trash2 :size="15" />
                </button>
              </div>
            </div>
            <div
              v-if="canJoin(meeting)"
              class="flex items-center gap-2 border-t border-border-subtle p-3 sm:hidden"
            >
              <NuxtLink
                :to="`/meetings/${meeting.id}/call`"
                class="inline-flex min-h-9 flex-1 items-center justify-center gap-1.5 rounded-lg border border-border bg-card text-xs font-semibold text-foreground"
              >
                <Video :size="14" /> {{ isLive(meeting) ? 'Join now' : 'Join call' }}
              </NuxtLink>
              <button
                v-if="meeting.location"
                type="button"
                class="inline-flex min-h-9 flex-1 items-center justify-center gap-1.5 rounded-lg px-3 text-xs font-semibold"
                :class="
                  joinedByMe(meeting)
                    ? 'border border-emerald-500/30 bg-emerald-500/10 text-emerald-600'
                    : isLive(meeting)
                      ? 'bg-emerald-600 text-white'
                      : 'bg-primary text-white'
                "
                @click="joinExternal(meeting)"
              >
                <Check v-if="joinedByMe(meeting)" :size="14" />
                <Video v-else :size="14" />
                {{
                  joinedByMe(meeting)
                    ? 'Rejoin link'
                    : isLive(meeting)
                      ? 'Join link now'
                      : 'Join link'
                }}
              </button>
            </div>
            <div
              v-if="attendanceOpen === meeting.id"
              class="border-t border-border-subtle px-4 pb-4 pt-3"
            >
              <p class="mb-2 text-[10px] font-semibold uppercase tracking-wider text-text-muted">
                Attendance · {{ joinedCount(meeting) }} of {{ meeting.attendees.length }} joined
              </p>
              <div class="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
                <div
                  v-for="attendee in meeting.attendees"
                  :key="attendee.user.id"
                  class="flex items-center gap-2.5 rounded-lg border px-2.5 py-1.5"
                  :class="
                    attendee.joinedAt
                      ? 'border-emerald-500/20 bg-emerald-500/5'
                      : 'border-border-subtle bg-background/50'
                  "
                >
                  <span
                    class="grid h-6 w-6 place-items-center rounded-full bg-secondary text-[9px]"
                    >{{ attendee.user.name[0] }}</span
                  ><span class="flex-1 truncate text-xs font-medium text-foreground">{{
                    attendee.user.name
                  }}</span
                  ><small class="text-[10px] text-text-muted">{{
                    attendee.joinedAt ? `joined ${time(attendee.joinedAt)}` : 'invited'
                  }}</small>
                </div>
              </div>
            </div>
          </article>
        </div>
      </section>

      <section v-if="pastMeetings.length">
        <h2 class="mb-3 flex items-center gap-2 text-[15px] font-semibold text-text-muted">
          <span class="grid h-6 w-6 place-items-center rounded-md bg-secondary"
            ><Clock :size="14" /></span
          >Past
        </h2>
        <div class="space-y-2">
          <NuxtLink
            v-for="meeting in pastMeetings"
            :key="meeting.id"
            :to="`/meetings/${meeting.id}`"
            class="flex items-center gap-4 rounded-xl border border-border-subtle bg-card p-4 opacity-60 hover:opacity-100"
            ><div class="w-20 shrink-0 text-center">
              <p class="text-xs text-text-muted">{{ dateLabel(meeting.startTime) }}</p>
              <strong class="text-lg text-foreground">{{
                time(meeting.startTime).split(' ')[0]
              }}</strong>
            </div>
            <div class="h-10 w-px bg-border-subtle" />
            <div class="min-w-0 flex-1">
              <h3 class="truncate text-sm font-semibold text-text-muted">{{ meeting.title }}</h3>
              <p class="mt-1 text-xs text-text-muted">
                {{ joinedCount(meeting) }}/{{ meeting.attendees.length }} joined
              </p>
            </div></NuxtLink
          >
        </div>
      </section>
    </template>
  </section>
</template>
