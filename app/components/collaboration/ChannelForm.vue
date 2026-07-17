<script setup lang="ts">
const props = defineProps<{ open: boolean }>();
const emit = defineEmits<{ close: []; saved: [channelId: string] }>();
const chat = useChat();
const name = ref('');
const description = ref('');
const topic = ref('');
const isPrivate = ref(true);
const saving = ref(false);
const error = ref('');
async function submit() {
  saving.value = true;
  error.value = '';
  try {
    const channel = await chat.createChannel({
      name: name.value,
      description: description.value || null,
      topic: topic.value || null,
      type: 'GROUP',
      isPrivate: isPrivate.value,
      memberIds: [],
    });
    emit('saved', channel.id);
    emit('close');
  } catch (caught: any) {
    error.value = caught?.data?.detail || 'The channel could not be opened.';
  } finally {
    saving.value = false;
  }
}
</script>
<template>
  <DeliveryFieldDialog
    :open="open"
    title="Open channel"
    description="Create a focused team dispatch line."
    @close="emit('close')"
    ><form @submit.prevent="submit">
      <label>Name<input v-model="name" required maxlength="80" /></label
      ><label>Topic<input v-model="topic" maxlength="160" /></label
      ><label>Description<textarea v-model="description" rows="3" maxlength="500" /></label
      ><label class="check"><input v-model="isPrivate" type="checkbox" /> Private channel</label>
      <p v-if="error" role="alert">{{ error }}</p>
      <div>
        <button type="button" class="button secondary" @click="emit('close')">Cancel</button
        ><button class="button" :disabled="saving">
          {{ saving ? 'Opening…' : 'Open channel' }}
        </button>
      </div>
    </form></DeliveryFieldDialog
  >
</template>
<style scoped>
form {
  display: grid;
  gap: 15px;
}
label {
  display: grid;
  gap: 6px;
  color: var(--text-muted);
  font-size: 11px;
  font-weight: 600;
}
input,
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
textarea:focus {
  border-color: var(--primary);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--primary) 12%, transparent);
}
.check {
  display: flex;
  grid-template-columns: auto 1fr;
  align-items: center;
}
.check input {
  width: 17px;
  height: 17px;
}
form div {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}
p {
  color: #dc2626;
  font-size: 12px;
}
</style>
