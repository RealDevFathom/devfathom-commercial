<script setup lang="ts">
import { ArrowLeft, CalendarClock, MapPin, Radio, Repeat2, Users, Video } from 'lucide-vue-next';
import type { Meeting } from '~/types/collaboration';

interface AttendanceReport {
  heldOccurrences: number;
  attendees: {
    user: { id: string; name: string; avatar?: string | null };
    attended: number;
    rate: number;
    lastJoinedAt?: string | null;
  }[];
}

const route = useRoute();
const api = useMeetings();
const { user } = useAuth();
const id = computed(() => String(route.params.id));
const meeting = ref<Meeting | null>(null);
const attendance = ref<AttendanceReport | null>(null);
const loading = ref(true);
const error = ref('');
const clock = ref(Date.now());
let clockTimer: ReturnType<typeof setInterval> | undefined;

async function load() {
  loading.value = true;
  error.value = '';
  try {
    meeting.value = await api.get(id.value);
    attendance.value = await api.attendance(id.value).catch(() => null);
    useHead({ title: `${meeting.value.title} · Meetings` });
  } catch (caught: any) {
    error.value = caught?.data?.detail || 'This meeting could not be opened.';
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

const countdown = computed(() =>
  meeting.value ? getMeetingCountdown(meeting.value, clock.value) : null
);
const canJoin = computed(
  () =>
    Boolean(meeting.value?.attendees.some((attendee) => attendee.user.id === user.value?.id)) &&
    countdown.value?.phase !== 'ended'
);
const dateTime = (value: string) =>
  new Intl.DateTimeFormat('en', { dateStyle: 'medium', timeStyle: 'short' }).format(
    new Date(value)
  );
const lastJoined = (value?: string | null) =>
  value
    ? new Intl.DateTimeFormat('en', {
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
      }).format(new Date(value))
    : '';
const initials = (name: string) =>
  name
    .split(' ')
    .map((part) => part[0])
    .join('')
    .toUpperCase()
    .slice(0, 2);
</script>

<template>
  <section class="meeting-detail animate-fade-in">
    <NuxtLink class="back" to="/meetings"><ArrowLeft :size="15" /> Back to Meetings</NuxtLink>
    <DeliveryFieldState
      v-if="loading || error"
      :loading="loading"
      :error="error"
      action="Try again"
      @action="load"
    />

    <template v-else-if="meeting">
      <header class="meeting-head">
        <div class="title-copy">
          <div
            v-if="countdown && countdown.phase !== 'ended'"
            class="meeting-state"
            :class="{ live: countdown.phase === 'live' }"
          >
            <Radio v-if="countdown.phase === 'live'" :size="13" />
            <CalendarClock v-else :size="13" />
            <span>{{ countdown.phase === 'live' ? 'Live now' : 'Upcoming' }}</span>
            <b data-allow-mismatch="text"
              >{{ countdown.hours }}:{{ countdown.minutes }}:{{ countdown.seconds }}</b
            >
          </div>
          <h1>{{ meeting.title }}</h1>
          <p v-if="meeting.description">{{ meeting.description }}</p>
        </div>
        <NuxtLink v-if="canJoin" class="join-call" :to="`/meetings/${meeting.id}/call`">
          <Video :size="16" /> {{ countdown?.phase === 'live' ? 'Join now' : 'Join call' }}
        </NuxtLink>
      </header>

      <section class="appointment" aria-label="Meeting details">
        <dl>
          <div>
            <CalendarClock :size="17" />
            <span
              ><small>When</small
              ><strong
                >{{ dateTime(meeting.startTime) }} – {{ dateTime(meeting.endTime) }}</strong
              ></span
            >
          </div>
          <div>
            <MapPin :size="17" />
            <span
              ><small>Where</small
              ><strong>{{ meeting.location || 'No location set' }}</strong></span
            >
          </div>
          <div>
            <Repeat2 :size="17" />
            <span
              ><small>Recurrence</small
              ><strong>{{ meeting.recurrence || 'One-time' }}</strong></span
            >
          </div>
        </dl>
      </section>

      <section class="attendance">
        <header>
          <Users :size="17" />
          <h2>Attendance</h2>
          <span v-if="attendance">
            · {{ attendance.heldOccurrences }} occurrence{{
              attendance.heldOccurrences === 1 ? '' : 's'
            }}
            held
          </span>
        </header>
        <div class="attendance-card">
          <article v-for="entry in attendance?.attendees" :key="entry.user.id">
            <span class="avatar">
              <img v-if="entry.user.avatar" :src="entry.user.avatar" :alt="entry.user.name" />
              <template v-else>{{ initials(entry.user.name) }}</template>
            </span>
            <div class="person">
              <strong>{{ entry.user.name }}</strong>
              <small>
                Attended {{ entry.attended }} of {{ attendance?.heldOccurrences || 0 }}
                <template v-if="entry.lastJoinedAt">
                  · last {{ lastJoined(entry.lastJoinedAt) }}</template
                >
              </small>
            </div>
            <div class="rate">
              <b :class="entry.rate >= 75 ? 'good' : entry.rate >= 40 ? 'medium' : 'low'">
                {{ Math.round(entry.rate) }}%
              </b>
              <span><i :style="{ width: `${Math.min(100, entry.rate)}%` }" /></span>
            </div>
          </article>
          <p v-if="!attendance?.attendees.length" class="empty-attendance">
            No attendance has been recorded yet. Joins are logged when members open the call.
          </p>
        </div>
      </section>
    </template>
  </section>
</template>

<style scoped>
.meeting-detail {
  width: 100%;
  max-width: 768px;
  margin: 0 auto;
}
.back {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 20px;
  color: var(--text-muted);
  font-size: 13px;
  font-weight: 600;
}
.back:hover {
  color: var(--foreground);
}
.meeting-head {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: 24px;
}
.title-copy {
  min-width: 0;
}
.meeting-state {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 8px;
  color: var(--accent-brand);
  font-size: 10px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.1em;
}
.meeting-state b {
  color: var(--foreground);
  font-family: var(--font-mono);
  font-variant-numeric: tabular-nums;
}
.meeting-state.live {
  color: #059669;
}
.meeting-head h1 {
  margin: 0;
  color: var(--foreground);
  font-family: var(--font-display);
  font-size: clamp(28px, 5vw, 42px);
  font-weight: 700;
  line-height: 1.08;
  letter-spacing: -0.03em;
}
.meeting-head p {
  max-width: 620px;
  margin: 8px 0 0;
  color: var(--text-muted);
  font-size: 14px;
  line-height: 1.55;
}
.join-call {
  display: inline-flex;
  min-height: 40px;
  flex: none;
  align-items: center;
  gap: 7px;
  padding: 0 18px;
  color: white;
  background: var(--primary);
  border-radius: 12px;
  font-size: 13px;
  font-weight: 650;
}
.join-call:hover {
  background: var(--primary-hover);
}
.appointment {
  margin-top: 26px;
  padding: 22px;
  background: var(--surface-card);
  border: 1px solid var(--border-subtle);
  border-radius: 14px;
  box-shadow: var(--shadow-xs);
}
.appointment dl {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 18px;
  margin: 0;
}
.appointment dl > div {
  display: flex;
  min-width: 0;
  align-items: flex-start;
  gap: 10px;
  color: var(--text-muted);
}
.appointment dl > div > svg {
  flex: none;
  margin-top: 2px;
}
.appointment span {
  min-width: 0;
}
.appointment small,
.appointment strong {
  display: block;
}
.appointment small {
  color: var(--text-muted);
  font-size: 10px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.07em;
}
.appointment strong {
  margin-top: 4px;
  overflow: hidden;
  color: var(--foreground);
  font-size: 12px;
  font-weight: 550;
  line-height: 1.45;
  text-overflow: ellipsis;
}
.attendance {
  margin-top: 26px;
}
.attendance > header {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 12px;
  color: var(--text-muted);
}
.attendance h2 {
  margin: 0;
  color: var(--foreground);
  font-size: 16px;
  font-weight: 650;
}
.attendance header span {
  color: var(--text-muted);
  font-size: 12px;
}
.attendance-card {
  overflow: hidden;
  background: var(--surface-card);
  border: 1px solid var(--border-subtle);
  border-radius: 14px;
  box-shadow: var(--shadow-xs);
}
.attendance article {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 14px 16px;
  border-bottom: 1px solid var(--border-subtle);
}
.attendance article:last-child {
  border-bottom: 0;
}
.avatar {
  display: grid;
  width: 36px;
  height: 36px;
  flex: none;
  overflow: hidden;
  place-items: center;
  color: var(--foreground);
  background: var(--secondary);
  border-radius: 50%;
  font-size: 10px;
  font-weight: 650;
}
.avatar img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}
.person {
  min-width: 0;
  flex: 1;
}
.person strong,
.person small {
  display: block;
}
.person strong {
  overflow: hidden;
  color: var(--foreground);
  font-size: 13px;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.person small {
  margin-top: 2px;
  color: var(--text-muted);
  font-size: 11px;
}
.rate {
  width: 128px;
  flex: none;
}
.rate b {
  display: block;
  margin-bottom: 5px;
  font-size: 11px;
}
.rate > span {
  display: block;
  height: 6px;
  overflow: hidden;
  background: var(--secondary);
  border-radius: 999px;
}
.rate i {
  display: block;
  height: 100%;
  background: currentColor;
  border-radius: inherit;
}
.rate .good {
  color: #10b981;
}
.rate .medium {
  color: #f59e0b;
}
.rate .low {
  color: #ef4444;
}
.empty-attendance {
  margin: 0;
  padding: 24px;
  color: var(--text-muted);
  font-size: 13px;
}
@media (max-width: 700px) {
  .meeting-head {
    align-items: flex-start;
    flex-direction: column;
  }
  .join-call {
    width: 100%;
    justify-content: center;
  }
  .appointment dl {
    grid-template-columns: 1fr;
  }
  .appointment dl > div {
    padding-bottom: 14px;
    border-bottom: 1px solid var(--border-subtle);
  }
  .appointment dl > div:last-child {
    padding-bottom: 0;
    border-bottom: 0;
  }
  .rate {
    width: 86px;
  }
  .person small {
    max-width: 180px;
  }
}
</style>
