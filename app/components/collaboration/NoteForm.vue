<script setup lang="ts">
import type { NoteSummary, TiptapNode } from '~/types/collaboration';

const props = defineProps<{ open: boolean }>();
const emit = defineEmits<{ close: []; saved: [id: string] }>();
const notes = useNotes();
const title = ref('');
const visibility = ref<NoteSummary['visibility']>('PRIVATE');
const contentJson = ref<TiptapNode>({ type: 'doc', content: [{ type: 'paragraph', content: [] }] });
const saving = ref(false);
const error = ref('');

async function submit() {
  saving.value = true;
  error.value = '';
  try {
    const note = await notes.create({
      title: title.value,
      visibility: visibility.value,
      contentJson: contentJson.value,
    });
    emit('saved', note.id);
    emit('close');
  } catch (caught: any) {
    error.value = caught?.data?.detail || 'The note could not be filed.';
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <DeliveryFieldDialog
    :open="open"
    title="New field note"
    description="Start a durable shared record."
    wide
    @close="emit('close')"
  >
    <form class="note-form" @submit.prevent="submit">
      <label>Title<input v-model="title" required maxlength="180" autofocus /></label>
      <label
        >Visibility<select v-model="visibility">
          <option value="PRIVATE">Private</option>
          <option value="SHARED">Shared by invitation</option>
          <option value="TEAM">Whole team</option>
        </select></label
      >
      <CollaborationRichEditor v-model="contentJson" />
      <p v-if="error" class="form-error" role="alert">{{ error }}</p>
      <div class="actions">
        <button type="button" class="button secondary" @click="emit('close')">Cancel</button
        ><button class="button" :disabled="saving">{{ saving ? 'Filing…' : 'File note' }}</button>
      </div>
    </form>
  </DeliveryFieldDialog>
</template>

<style scoped>
.note-form {
  display: grid;
  gap: 16px;
}
label {
  display: grid;
  gap: 6px;
  color: var(--muted);
  font:
    500 9px 'IBM Plex Mono',
    monospace;
  letter-spacing: 0.1em;
  text-transform: uppercase;
}
input,
select {
  min-height: 42px;
  padding: 0 12px;
  color: var(--text);
  background: var(--paper);
  border: 1px solid var(--border);
}
.actions {
  display: flex;
  justify-content: flex-end;
  gap: 9px;
}
.form-error {
  color: var(--clay-600);
  font-size: 12px;
}
</style>
