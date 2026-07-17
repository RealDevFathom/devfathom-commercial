<script setup lang="ts">
import type { Client } from '~/types/crm';
const props = defineProps<{ open: boolean; client?: Client | null }>();
const emit = defineEmits<{ close: []; saved: [Client] }>();
const crm = useCrm();
const saving = ref(false);
const error = ref('');
const form = reactive({
  name: '',
  website: '',
  industry: '',
  location: '',
  timezone: '',
  notes: '',
  status: 'ACTIVE',
});
watch(
  () => [props.open, props.client] as const,
  () =>
    Object.assign(form, {
      name: props.client?.name || '',
      website: props.client?.website || '',
      industry: props.client?.industry || '',
      location: props.client?.location || '',
      timezone: props.client?.timezone || '',
      notes: props.client?.notes || '',
      status: props.client?.status || 'ACTIVE',
    }),
  { immediate: true }
);
async function save() {
  saving.value = true;
  error.value = '';
  try {
    const body = {
      ...form,
      website: form.website || null,
      industry: form.industry || null,
      location: form.location || null,
      timezone: form.timezone || null,
      notes: form.notes || null,
    };
    const result = props.client
      ? await crm.updateClient(props.client.id, body)
      : await crm.createClient({ ...body, contacts: [] });
    emit('saved', result);
    emit('close');
  } catch (caught: any) {
    error.value = caught?.data?.detail || 'The client record could not be saved.';
  } finally {
    saving.value = false;
  }
}
</script>
<template>
  <DeliveryFieldDialog
    :open="open"
    :title="client ? 'Revise client record' : 'Open a client record'"
    @close="emit('close')"
    ><form class="form" @submit.prevent="save">
      <label>Client name<input v-model="form.name" required /></label
      ><label>Website<input v-model="form.website" type="url" /></label>
      <div>
        <label>Industry<input v-model="form.industry" /></label
        ><label>Location<input v-model="form.location" /></label>
      </div>
      <div>
        <label>Timezone<input v-model="form.timezone" placeholder="Asia/Karachi" /></label
        ><label
          >Status<select v-model="form.status">
            <option>ACTIVE</option>
            <option>PROSPECT</option>
            <option>INACTIVE</option>
          </select></label
        >
      </div>
      <label>Relationship notes<textarea v-model="form.notes" rows="4" /></label>
      <p v-if="error">{{ error }}</p>
      <footer>
        <button type="button" class="button secondary" @click="emit('close')">Cancel</button
        ><button class="button" :disabled="saving">{{ saving ? 'Saving…' : 'Save client' }}</button>
      </footer>
    </form></DeliveryFieldDialog
  >
</template>
<style scoped>
.form {
  display: grid;
  gap: 14px;
}
.form > div {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 12px;
}
label {
  display: grid;
  gap: 6px;
  font-size: 10px;
  font-weight: 600;
}
input,
textarea,
select {
  padding: 10px;
  color: var(--text);
  background: var(--linen);
  border: 1px solid var(--border);
}
p {
  color: var(--clay-600);
  font-size: 11px;
}
footer {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}
@media (max-width: 540px) {
  .form > div {
    grid-template-columns: 1fr;
  }
}
</style>
