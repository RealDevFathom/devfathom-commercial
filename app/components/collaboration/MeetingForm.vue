<script setup lang="ts">
import type { Meeting, Person } from '~/types/collaboration';
const props = defineProps<{ open: boolean; meeting?: Meeting | null }>();
const emit = defineEmits<{ close: []; saved: [id: string] }>();
const api = useMeetings();
const collaboration = useCollaboration();
const title = ref('');
const description = ref('');
const location = ref('');
const startTime = ref('');
const endTime = ref('');
const recurrence = ref('');
const attendees = ref<Person[]>([]);
const people = ref<Person[]>([]);
const peopleQuery = ref('');
const saving = ref(false);
const error = ref('');
watch(
  () => props.open,
  (open) => {
    if (!open) return;
    const m = props.meeting;
    title.value = m?.title || '';
    description.value = m?.description || '';
    location.value = m?.location || '';
    startTime.value = m?.startTime ? new Date(m.startTime).toISOString().slice(0, 16) : '';
    endTime.value = m?.endTime ? new Date(m.endTime).toISOString().slice(0, 16) : '';
    recurrence.value = m?.recurrence || '';
    attendees.value = m?.attendees.map((a) => a.user) || [];
  },
  { immediate: true }
);
async function findPeople() {
  if (peopleQuery.value.trim().length < 2) return;
  people.value = (await collaboration.search(peopleQuery.value)).team;
}
function add(person: Person) {
  if (!attendees.value.some((p) => p.id === person.id)) attendees.value.push(person);
  peopleQuery.value = '';
  people.value = [];
}
async function submit() {
  saving.value = true;
  error.value = '';
  try {
    const body = {
      title: title.value,
      description: description.value || null,
      location: location.value || null,
      startTime: new Date(startTime.value).toISOString(),
      endTime: new Date(endTime.value).toISOString(),
      recurrence: recurrence.value || null,
      attendeeIds: attendees.value.map((a) => a.id),
    };
    const meeting = props.meeting
      ? await api.update(props.meeting.id, body)
      : await api.create(body);
    emit('saved', meeting.id);
    emit('close');
  } catch (caught: any) {
    error.value = caught?.data?.detail || 'The meeting could not be scheduled.';
  } finally {
    saving.value = false;
  }
}
</script>
<template>
  <DeliveryFieldDialog
    :open="open"
    :title="meeting ? 'Revise meeting' : 'Schedule meeting'"
    description="Record the time, place, recurrence, and attendees."
    @close="emit('close')"
    ><form @submit.prevent="submit">
      <label>Title<input v-model="title" required /></label
      ><label>Description<textarea v-model="description" rows="3" /></label>
      <div class="two">
        <label>Starts<input v-model="startTime" type="datetime-local" required /></label
        ><label>Ends<input v-model="endTime" type="datetime-local" required /></label>
      </div>
      <div class="two">
        <label>Location<input v-model="location" /></label
        ><label
          >Recurrence<select v-model="recurrence">
            <option value="">Does not repeat</option>
            <option value="daily">Daily</option>
            <option value="weekly">Weekly</option>
            <option value="biweekly">Every two weeks</option>
            <option value="monthly">Monthly</option>
          </select></label
        >
      </div>
      <label>Add attendee<input v-model="peopleQuery" @input="findPeople" /></label
      ><button
        v-for="person in people"
        :key="person.id"
        type="button"
        class="person"
        @click="add(person)"
      >
        {{ person.name }} · {{ person.title || 'Team' }}
      </button>
      <div class="chips">
        <button
          v-for="person in attendees"
          :key="person.id"
          type="button"
          @click="attendees = attendees.filter((p) => p.id !== person.id)"
        >
          {{ person.name }} ×
        </button>
      </div>
      <p v-if="error" role="alert">{{ error }}</p>
      <div class="actions">
        <button type="button" class="button secondary" @click="emit('close')">Cancel</button
        ><button class="button" :disabled="saving">
          {{ saving ? 'Scheduling…' : 'Save meeting' }}
        </button>
      </div>
    </form></DeliveryFieldDialog
  >
</template>
<style scoped>
form {
  display: grid;
  gap: 14px;
}
label {
  display: grid;
  gap: 6px;
  color: var(--text-muted);
  font-size: 11px;
  font-weight: 600;
}
input,
select,
textarea {
  min-height: 40px;
  padding: 9px 11px;
  color: var(--foreground);
  background: var(--background);
  border: 1px solid var(--border);
  border-radius: 9px;
  outline: 0;
}
input:focus,
select:focus,
textarea:focus {
  border-color: var(--primary);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--primary) 12%, transparent);
}
.two {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 10px;
}
.person {
  text-align: left;
  padding: 9px 10px;
  color: var(--foreground);
  background: var(--secondary);
  border: 1px solid var(--border-subtle);
  border-radius: 8px;
  cursor: pointer;
}
.chips {
  display: flex;
  flex-wrap: wrap;
  gap: 5px;
}
.chips button {
  padding: 5px 8px;
  color: var(--primary);
  background: color-mix(in srgb, var(--primary) 8%, var(--card));
  border: 1px solid color-mix(in srgb, var(--primary) 22%, var(--border));
  border-radius: 15px;
  font-size: 10px;
  cursor: pointer;
}
.actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}
p {
  color: #dc2626;
  font-size: 12px;
}
@media (max-width: 580px) {
  .two {
    grid-template-columns: 1fr;
  }
}
</style>
