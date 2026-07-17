<script setup lang="ts">
import { ArrowLeft } from 'lucide-vue-next';
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
    useHead({ title: `${boardRecord.name} · ${projectRecord.name} · DevFathom Hub` });
  } catch (caught: any) {
    error.value = caught?.data?.detail || 'The delivery board could not be loaded.';
  } finally {
    loading.value = false;
  }
}
await load();

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
      <header class="mb-3 shrink-0">
        <NuxtLink
          :to="`/projects/${projectId}`"
          class="mb-2 inline-flex items-center gap-1.5 text-sm text-text-muted transition-colors hover:text-foreground"
          ><ArrowLeft :size="16" />{{ project.name }}</NuxtLink
        >
        <h1 class="m-0 text-xl font-bold tracking-tight text-foreground">{{ board.name }}</h1>
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
</style>
