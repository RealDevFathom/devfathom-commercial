<script setup lang="ts">
import { ArrowLeft, Pencil, Save, X } from 'lucide-vue-next';
import type { Board, Project } from '~/types/delivery';

const route = useRoute();
const router = useRouter();
const delivery = useDelivery();
const projectId = String(route.params.id);
const boardId = String(route.params.boardId);
const board = ref<Board | null>(null);
const project = ref<Project | null>(null);
const loading = ref(true);
const error = ref('');
const editing = ref(false);
const saving = ref(false);
const boardForm = reactive({ name: '', description: '' });
useHead(() => ({
  title:
    board.value && project.value
      ? `${board.value.name} · ${project.value.name} · DevFathom Hub`
      : 'Project board · DevFathom Hub',
}));

async function load() {
  loading.value = true;
  error.value = '';
  try {
    const [boardRecord, projectRecord] = await Promise.all([
      delivery.getBoard(boardId),
      delivery.getProject(projectId),
    ]);
    board.value = boardRecord;
    project.value = projectRecord;
    Object.assign(boardForm, {
      name: boardRecord.name,
      description: boardRecord.description || '',
    });
  } catch (caught: any) {
    error.value = caught?.data?.detail || 'The delivery board could not be loaded.';
  } finally {
    loading.value = false;
  }
}
await load();

async function saveBoard() {
  if (!boardForm.name.trim()) return;
  saving.value = true;
  error.value = '';
  try {
    await delivery.updateBoard(boardId, {
      name: boardForm.name.trim(),
      description: boardForm.description.trim() || null,
    });
    editing.value = false;
    await load();
  } catch (caught: any) {
    error.value = caught?.data?.detail || 'The board details could not be saved.';
  } finally {
    saving.value = false;
  }
}

function taskOpened(id: string | null) {
  router.replace({
    query: id
      ? { ...route.query, task: id }
      : Object.fromEntries(Object.entries(route.query).filter(([key]) => key !== 'task')),
  });
}
</script>

<template>
  <section class="board-page animate-fade-in">
    <DeliveryFieldState
      v-if="loading || error"
      :loading="loading"
      :error="error"
      action="Try again"
      @action="load"
    />
    <template v-else-if="board && project">
      <header class="board-hero mb-4 shrink-0">
        <NuxtLink
          :to="`/projects/${projectId}`"
          class="mb-2 inline-flex items-center gap-1.5 text-sm text-text-muted transition-colors hover:text-foreground"
          ><ArrowLeft :size="16" />{{ project.name }}</NuxtLink
        >
        <div class="flex items-end justify-between gap-4">
          <div class="min-w-0">
            <template v-if="editing">
              <input v-model="boardForm.name" class="board-title-input" aria-label="Board name" />
              <textarea
                v-model="boardForm.description"
                class="board-description-input"
                rows="2"
                placeholder="Board description"
              />
            </template>
            <template v-else>
              <h1 class="m-0 text-3xl font-semibold tracking-[-0.035em] text-foreground">
                {{ board.name }}
              </h1>
              <p v-if="board.description" class="mt-1 text-sm text-text-muted">
                {{ board.description }}
              </p>
            </template>
          </div>
          <div class="flex shrink-0 items-center gap-2">
            <template v-if="editing">
              <button class="studio-outline-button" @click="editing = false">
                <X :size="14" /> Cancel
              </button>
              <button class="studio-primary-button" :disabled="saving" @click="saveBoard">
                <Save :size="14" /> {{ saving ? 'Saving…' : 'Save' }}
              </button>
            </template>
            <button v-else class="studio-outline-button" @click="editing = true">
              <Pencil :size="14" /> Board details
            </button>
          </div>
        </div>
      </header>
      <DeliveryKanbanBoard
        class="min-h-0 flex-1"
        :board="board"
        :members="project.members"
        :initial-task-id="typeof route.query.task === 'string' ? route.query.task : null"
        @refresh="load"
        @task-opened="taskOpened"
      />
    </template>
  </section>
</template>

<style scoped>
.board-page {
  display: flex;
  height: calc(100vh - 8rem);
  min-height: 0;
  flex-direction: column;
}
.board-hero {
  border: 1px solid var(--border-default);
  border-radius: 24px;
  padding: 18px 20px;
  background: var(--surface-card);
  box-shadow: var(--shadow-xs);
}
.board-title-input,
.board-description-input {
  width: min(640px, 100%);
  border: 1px solid var(--border-default);
  border-radius: 10px;
  padding: 8px 10px;
  color: var(--foreground);
  background: var(--surface-sunken);
  outline: none;
}
.board-title-input {
  font-size: 20px;
  font-weight: 650;
}
.board-description-input {
  display: block;
  margin-top: 8px;
  resize: vertical;
  font-size: 12px;
}
@media (max-width: 640px) {
  .board-page {
    height: calc(100vh - 6rem);
  }
  .board-hero > div {
    align-items: stretch;
    flex-direction: column;
  }
}
</style>
