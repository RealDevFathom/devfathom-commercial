<script setup lang="ts">
import { ArrowLeft, CalendarClock, MapPin, Repeat2, Users, Video } from 'lucide-vue-next';
import type { Meeting } from '~/types/collaboration';
const route = useRoute();
const api = useMeetings();
const id = computed(() => String(route.params.id));
const meeting = ref<Meeting | null>(null);
const attendance = ref<{
  heldOccurrences: number;
  attendees: { user: { id: string; name: string }; attended: number; rate: number }[];
} | null>(null);
const loading = ref(true);
const error = ref('');
async function load() {
  loading.value = true;
  error.value = '';
  try {
    meeting.value = await api.get(id.value);
    attendance.value = await api.attendance(id.value);
    useHead({ title: `${meeting.value.title} · Meetings` });
  } catch (caught: any) {
    error.value = caught?.data?.detail || 'This meeting could not be opened.';
  } finally {
    loading.value = false;
  }
}
await load();
const date = (v: string) =>
  new Intl.DateTimeFormat('en', { dateStyle: 'full', timeStyle: 'short' }).format(new Date(v));
</script>
<template>
  <section class="meeting-detail animate-fade-in">
    <NuxtLink class="back" to="/meetings"><ArrowLeft :size="14" /> Back to Meetings</NuxtLink
    ><DeliveryFieldState
      v-if="loading || error"
      :loading="loading"
      :error="error"
      action="Try again"
      @action="load"
    /><template v-else-if="meeting">
      <header class="meeting-head">
        <div>
          <h1>{{ meeting.title }}</h1>
          <p v-if="meeting.description">{{ meeting.description }}</p>
        </div>
        <NuxtLink class="join-call" :to="`/meetings/${meeting.id}/call`"
          ><Video :size="16" /> Join call</NuxtLink
        >
      </header>
      <section class="appointment">
        <dl>
          <div>
            <CalendarClock :size="16" /><span
              ><small>When</small
              ><strong>{{ date(meeting.startTime) }} – {{ date(meeting.endTime) }}</strong></span
            >
          </div>
          <div>
            <MapPin :size="16" /><span
              ><small>Where</small><strong>{{ meeting.location || '—' }}</strong></span
            >
          </div>
          <div>
            <Repeat2 :size="16" /><span
              ><small>Recurrence</small
              ><strong>{{ meeting.recurrence || 'One-time' }}</strong></span
            >
          </div>
        </dl>
      </section>
      <section class="attendance">
        <header>
          <Users :size="16" />
          <h2>Attendance</h2>
          <span v-if="attendance"
            >· {{ attendance.heldOccurrences }} occurrence{{
              attendance.heldOccurrences === 1 ? '' : 's'
            }}
            held</span
          >
        </header>
        <div class="attendance-card">
          <article v-for="entry in attendance?.attendees" :key="entry.user.id">
            <i>{{ entry.user.name.slice(0, 2).toUpperCase() }}</i>
            <div>
              <strong>{{ entry.user.name }}</strong
              ><small
                >Attended {{ entry.attended }} of {{ attendance?.heldOccurrences || 0 }}</small
              >
            </div>
            <div class="rate">
              <b>{{ Math.round(entry.rate) }}%</b
              ><progress
                :value="entry.rate"
                max="100"
                :aria-label="`${entry.user.name} attendance rate`"
              />
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
.back {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 16px;
  color: var(--muted);
  font-size: 11px;
}
.meeting-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 20px;
  padding: 28px;
  background: var(--forest-950);
  color: white;
}
.meeting-head span,
.appointment > span,
.attendance header span {
  color: var(--clay-500);
  font:
    9px 'IBM Plex Mono',
    monospace;
  text-transform: uppercase;
  letter-spacing: 0.12em;
}
.meeting-head h1 {
  margin: 3px 0;
  font-size: clamp(30px, 4vw, 46px);
}
.meeting-head p {
  max-width: 650px;
  margin: 0;
  color: #c6cec3;
  font-size: 12px;
}
.meeting-head > div:last-child {
  display: flex;
  gap: 8px;
}
.meeting-grid {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 330px;
  background: var(--paper);
  border: 1px solid var(--border);
  border-top: 0;
}
.meeting-grid > main {
  padding: 26px;
  border-right: 1px solid var(--border);
}
.appointment {
  padding: 22px;
  background: var(--linen);
  border: 1px solid var(--border);
}
dl {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  margin: 17px 0 0;
}
dl div {
  padding: 0 18px;
  border-right: 1px solid var(--border);
}
dl div:first-child {
  padding-left: 0;
}
dl div:last-child {
  border: 0;
}
dt {
  display: flex;
  align-items: center;
  gap: 7px;
  color: var(--muted);
  font-size: 10px;
}
dd {
  margin: 8px 0 0;
  font:
    600 16px 'Newsreader',
    serif;
  text-transform: capitalize;
}
dd small {
  display: block;
  margin-top: 4px;
  color: var(--muted);
  font:
    10px 'IBM Plex Sans',
    sans-serif;
}
.attendance {
  margin-top: 22px;
  border: 1px solid var(--border);
}
.attendance header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 16px;
  border-bottom: 1px solid var(--border);
}
.attendance h2 {
  margin: 3px 0 0;
  font-size: 22px;
}
.attendance header b {
  color: var(--muted);
  font:
    9px 'IBM Plex Mono',
    monospace;
  text-transform: uppercase;
}
.attendance article {
  display: grid;
  grid-template-columns: 1fr 90px minmax(100px, 1fr) 42px;
  gap: 12px;
  align-items: center;
  padding: 13px 16px;
  border-bottom: 1px solid var(--border);
  font-size: 11px;
}
.attendance article span {
  color: var(--muted);
}
progress {
  width: 100%;
  height: 5px;
  accent-color: var(--forest-800);
}
.meeting-grid > aside > header {
  display: flex;
  align-items: center;
  gap: 8px;
  height: 51px;
  padding: 0 18px;
  border-bottom: 1px solid var(--border);
  font:
    9px 'IBM Plex Mono',
    monospace;
  text-transform: uppercase;
}
.meeting-grid > aside > article {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 13px 16px;
  border-bottom: 1px solid var(--border);
}
.meeting-grid > aside i {
  display: grid;
  place-items: center;
  width: 34px;
  height: 34px;
  color: white;
  background: var(--forest-800);
  border-radius: 50%;
  font:
    9px 'IBM Plex Mono',
    monospace;
}
.meeting-grid > aside article div {
  flex: 1;
}
.meeting-grid > aside strong,
.meeting-grid > aside small {
  display: block;
  font-size: 11px;
}
.meeting-grid > aside small,
.meeting-grid > aside article > span {
  color: var(--muted);
  font-size: 9px;
}
.danger {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 18px;
  padding: 10px;
  color: var(--clay-600);
  background: transparent;
  border: 1px solid var(--clay-100);
  cursor: pointer;
}
@media (max-width: 900px) {
  .meeting-head {
    align-items: stretch;
    flex-direction: column;
  }
  .meeting-grid {
    grid-template-columns: 1fr;
  }
  .meeting-grid > main {
    border: 0;
    border-bottom: 1px solid var(--border);
  }
  dl {
    grid-template-columns: 1fr;
    gap: 14px;
  }
  dl div {
    padding: 0 0 14px;
    border: 0;
    border-bottom: 1px solid var(--border);
  }
  .attendance article {
    grid-template-columns: 1fr 70px 42px;
  }
  .attendance progress {
    display: none;
  }
}
/* Production Studio meeting detail */
.back {
  color: var(--text-muted);
  font-size: 13px;
  font-weight: 600;
}
.meeting-head {
  margin-bottom: 18px;
  border: 1px solid var(--border-subtle);
  border-radius: 24px;
  padding: 24px;
  background: var(--surface-card);
  box-shadow: var(--shadow-xs);
}
.meeting-head span {
  color: var(--accent-brand);
  font: 600 9px var(--font-mono);
}
.meeting-head h1 {
  color: var(--foreground);
  font-size: clamp(32px, 5vw, 52px);
  font-weight: 650;
  line-height: 1;
}
.meeting-head p {
  color: var(--text-muted);
  font-size: 14px;
}
.meeting-grid > main,
.meeting-grid > aside {
  overflow: hidden;
  border: 1px solid var(--border-subtle);
  border-radius: 22px;
  background: var(--surface-card);
  box-shadow: var(--shadow-xs);
}
.appointment,
.attendance {
  border-color: var(--border-subtle);
  background: var(--surface-card);
}
.appointment > span,
.attendance header span {
  color: var(--accent-brand);
  font: 600 9px var(--font-mono);
}
.attendance h2 {
  color: var(--foreground);
  font-size: 18px;
  font-weight: 650;
}
.meeting-grid > aside > header {
  border-color: var(--border-subtle);
  background: var(--surface-sunken);
}
.meeting-grid > aside > article,
.attendance article {
  border-color: var(--border-subtle);
}
.meeting-grid > aside i {
  border-radius: 50%;
  color: var(--primary-foreground);
  background: var(--foreground);
  font-family: var(--font-mono);
}
/* Source-parity overrides */
.meeting-detail {
  max-width: 768px;
  margin: 0 auto;
}
.back {
  margin-bottom: 16px;
}
.meeting-head {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: 20px;
  margin: 0;
  padding: 0;
  background: transparent;
  border: 0;
  border-radius: 0;
  box-shadow: none;
}
.meeting-head h1 {
  margin: 0;
  font-family: var(--font-display);
  font-size: 24px;
  line-height: 1.2;
}
.meeting-head p {
  margin: 6px 0 0;
  font-size: 15px;
}
.join-call {
  display: inline-flex;
  min-height: 40px;
  flex: none;
  align-items: center;
  gap: 7px;
  padding: 0 20px;
  color: white;
  background: var(--primary);
  border-radius: 12px;
  font-size: 14px;
  font-weight: 650;
}
.join-call:hover {
  filter: brightness(0.92);
}
.appointment {
  margin-top: 24px;
  padding: 24px;
  border: 1px solid var(--border-subtle);
  border-radius: 12px;
}
.appointment dl {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 16px;
  margin: 0;
}
.appointment dl > div {
  display: flex;
  min-width: 0;
  align-items: flex-start;
  gap: 10px;
  padding: 0;
  color: var(--text-muted);
  border: 0;
}
.appointment dl > div > svg {
  flex: none;
  margin-top: 2px;
}
.appointment dl span {
  min-width: 0;
}
.appointment dl small,
.appointment dl strong {
  display: block;
}
.appointment dl small {
  color: var(--text-muted);
  font-size: 11px;
  font-weight: 500;
  text-transform: uppercase;
  letter-spacing: 0.05em;
}
.appointment dl strong {
  margin-top: 2px;
  overflow: hidden;
  color: var(--foreground);
  font-size: 13px;
  font-weight: 500;
  text-overflow: ellipsis;
}
.attendance {
  margin-top: 24px;
  border: 0;
}
.attendance > header {
  display: flex;
  justify-content: flex-start;
  gap: 8px;
  padding: 0 0 12px;
  color: var(--text-muted);
  border: 0;
}
.attendance > header h2 {
  margin: 0;
  color: var(--foreground);
  font-size: 16px;
}
.attendance > header span {
  color: var(--text-muted);
  font: 400 12px var(--font-sans);
  letter-spacing: 0;
  text-transform: none;
}
.attendance-card {
  overflow: hidden;
  background: var(--surface-card);
  border: 1px solid var(--border-subtle);
  border-radius: 12px;
}
.attendance article {
  display: flex;
  gap: 12px;
  padding: 14px 16px;
  font-size: 13px;
}
.attendance article > i {
  display: grid;
  width: 36px;
  height: 36px;
  flex: none;
  place-items: center;
  color: var(--foreground);
  background: var(--secondary);
  border-radius: 50%;
  font: 600 10px var(--font-sans);
}
.attendance article > div:nth-child(2) {
  min-width: 0;
  flex: 1;
}
.attendance article strong,
.attendance article small {
  display: block;
}
.attendance article small {
  margin-top: 2px;
  color: var(--text-muted);
  font-size: 12px;
}
.rate {
  width: 128px;
  flex: none;
}
.rate b {
  display: block;
  margin-bottom: 4px;
  font-size: 12px;
}
.rate progress {
  display: block;
  height: 6px;
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
  .appointment dl {
    grid-template-columns: 1fr;
  }
  .appointment dl > div {
    padding-bottom: 12px;
    border-bottom: 1px solid var(--border-subtle);
  }
  .appointment dl > div:last-child {
    padding-bottom: 0;
    border: 0;
  }
  .rate {
    width: 88px;
  }
}
</style>
