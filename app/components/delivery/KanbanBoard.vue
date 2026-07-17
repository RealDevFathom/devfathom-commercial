<script setup lang="ts">
import {
  Calendar,
  Check,
  CheckSquare,
  ChevronLeft,
  ChevronRight,
  GripVertical,
  ListChecks,
  MessageSquare,
  Paperclip,
  Plus,
  RefreshCw,
  Search,
  Settings2,
  Tag,
  Trash2,
  UserPlus,
  X,
} from 'lucide-vue-next';
import type { Board, ProjectMember, Task } from '~/types/delivery';

const props = defineProps<{
  board: Board;
  members: ProjectMember[];
  initialTaskId?: string | null;
}>();
const emit = defineEmits<{ refresh: []; taskOpened: [string | null] }>();
const delivery = useDelivery();
const dragged = ref<Task | null>(null);
const selectedTaskId = ref<string | null>(props.initialTaskId || null);
const moving = ref(false);
const error = ref('');
const newTaskColumn = ref<string | null>(null);
const newTaskTitle = ref('');
const newColumnName = ref('');
const addingColumn = ref(false);
const editingColumnId = ref<string | null>(null);
const editingColumnName = ref('');
const deletingColumnId = ref<string | null>(null);
const ownerPickerColumnId = ref<string | null>(null);
const ownerDraft = ref<string[]>([]);
const searchQuery = ref('');
const filterPriority = ref('ALL');
const filterAssignee = ref('ALL');
const filterLabel = ref('ALL');
const selectionMode = ref(false);
const selected = ref<Set<string>>(new Set());
const bulkBusy = ref(false);
const bulkTarget = ref('');
const labelsOpen = ref(false);
const editingLabelId = ref<string | null>(null);
const labelForm = reactive({ name: '', color: '#ff684f' });
const wipDraft = reactive<Record<string, string>>({});

watch(
  () => props.initialTaskId,
  (value) => (selectedTaskId.value = value || null)
);

const allAssignees = computed(() => {
  const people = new Map<string, { id: string; name: string }>();
  for (const column of props.board.columns)
    for (const task of column.tasks)
      for (const entry of task.assignees)
        people.set(entry.user.id, { id: entry.user.id, name: entry.user.name });
  return [...people.values()];
});
const hasFilters = computed(() =>
  Boolean(
    searchQuery.value ||
    filterPriority.value !== 'ALL' ||
    filterAssignee.value !== 'ALL' ||
    filterLabel.value !== 'ALL'
  )
);
const filteredColumns = computed(() =>
  props.board.columns.map((column) => ({
    ...column,
    tasks: column.tasks.filter((task) => {
      if (searchQuery.value && !task.title.toLowerCase().includes(searchQuery.value.toLowerCase()))
        return false;
      if (filterPriority.value !== 'ALL' && task.priority !== filterPriority.value) return false;
      if (
        filterAssignee.value !== 'ALL' &&
        !task.assignees.some((entry) => entry.user.id === filterAssignee.value)
      )
        return false;
      if (
        filterLabel.value !== 'ALL' &&
        !task.labels.some((entry) => entry.label.id === filterLabel.value)
      )
        return false;
      return true;
    }),
  }))
);

function clearFilters() {
  searchQuery.value = '';
  filterPriority.value = 'ALL';
  filterAssignee.value = 'ALL';
  filterLabel.value = 'ALL';
}
function openTask(id: string) {
  if (selectionMode.value) return toggleSelect(id);
  selectedTaskId.value = id;
  emit('taskOpened', id);
}
function closeTask() {
  selectedTaskId.value = null;
  emit('taskOpened', null);
}
function toggleSelect(id: string) {
  const next = new Set(selected.value);
  next.has(id) ? next.delete(id) : next.add(id);
  selected.value = next;
}
function exitSelection() {
  selectionMode.value = false;
  selected.value = new Set();
}

async function drop(columnId: string, renderedOrder: number) {
  if (!dragged.value || moving.value) return;
  moving.value = true;
  error.value = '';
  try {
    const realColumn = props.board.columns.find((column) => column.id === columnId);
    const renderedColumn = filteredColumns.value.find((column) => column.id === columnId);
    const renderedAfterRemoval = (renderedColumn?.tasks || []).filter(
      (task) => task.id !== dragged.value?.id
    );
    const follow = renderedAfterRemoval[renderedOrder];
    const realOrder = follow
      ? Math.max(0, realColumn?.tasks.findIndex((task) => task.id === follow.id) || 0)
      : realColumn?.tasks.length || 0;
    await delivery.moveTask(dragged.value.id, columnId, realOrder);
    emit('refresh');
  } catch (caught: any) {
    error.value = caught?.data?.detail || 'The task could not be moved.';
  } finally {
    dragged.value = null;
    moving.value = false;
  }
}

async function createTask(columnId: string) {
  if (!newTaskTitle.value.trim()) return;
  try {
    await delivery.createTask({
      title: newTaskTitle.value.trim(),
      columnId,
      priority: 'MEDIUM',
      assigneeIds: [],
      labelIds: [],
    });
    newTaskTitle.value = '';
    newTaskColumn.value = null;
    emit('refresh');
  } catch (caught: any) {
    error.value = caught?.data?.detail || 'The task could not be added.';
  }
}
async function createColumn() {
  if (!newColumnName.value.trim()) return;
  try {
    await delivery.createColumn({ boardId: props.board.id, name: newColumnName.value.trim() });
    newColumnName.value = '';
    addingColumn.value = false;
    emit('refresh');
  } catch (caught: any) {
    error.value = caught?.data?.detail || 'The column could not be added.';
  }
}
function startRename(id: string, name: string) {
  editingColumnId.value = id;
  editingColumnName.value = name;
}
async function saveRename(id: string) {
  if (!editingColumnName.value.trim()) return;
  await delivery.updateColumn(id, { name: editingColumnName.value.trim() });
  editingColumnId.value = null;
  emit('refresh');
}
async function removeColumn(id: string) {
  await delivery.removeColumn(id);
  deletingColumnId.value = null;
  emit('refresh');
}
function openOwners(column: Board['columns'][number]) {
  ownerPickerColumnId.value = column.id;
  ownerDraft.value = column.defaultAssignees.map((entry) => entry.user.id);
}
function toggleOwner(id: string) {
  ownerDraft.value = ownerDraft.value.includes(id)
    ? ownerDraft.value.filter((value) => value !== id)
    : [...ownerDraft.value, id];
}
async function saveOwners(columnId: string) {
  await delivery.setColumnOwners(columnId, ownerDraft.value);
  ownerPickerColumnId.value = null;
  emit('refresh');
}
async function saveWip(columnId: string) {
  const value = wipDraft[columnId];
  await delivery.updateColumn(columnId, {
    wipLimit: value === '' || value == null ? null : Number(value),
  });
  emit('refresh');
}
async function moveColumn(index: number, offset: number) {
  const target = index + offset;
  if (target < 0 || target >= props.board.columns.length) return;
  const ids = props.board.columns.map((column) => column.id);
  [ids[index], ids[target]] = [ids[target]!, ids[index]!];
  await delivery.reorderColumns(props.board.id, ids);
  emit('refresh');
}
async function deleteSelected() {
  bulkBusy.value = true;
  try {
    await delivery.bulkDeleteTasks([...selected.value]);
    exitSelection();
    emit('refresh');
  } finally {
    bulkBusy.value = false;
  }
}
async function moveSelected() {
  if (!bulkTarget.value) return;
  bulkBusy.value = true;
  try {
    await delivery.bulkMoveTasks([...selected.value], bulkTarget.value);
    bulkTarget.value = '';
    exitSelection();
    emit('refresh');
  } finally {
    bulkBusy.value = false;
  }
}
function startLabelEdit(label?: Board['labels'][number]) {
  editingLabelId.value = label?.id || null;
  Object.assign(labelForm, { name: label?.name || '', color: label?.color || '#ff684f' });
}
async function saveLabel() {
  if (!labelForm.name.trim()) return;
  if (editingLabelId.value) {
    await delivery.updateLabel(editingLabelId.value, {
      name: labelForm.name.trim(),
      color: labelForm.color,
    });
  } else {
    await delivery.createLabel(props.board.id, labelForm.name.trim(), labelForm.color);
  }
  startLabelEdit();
  emit('refresh');
}
async function removeLabel(id: string) {
  await delivery.removeLabel(id);
  if (editingLabelId.value === id) startLabelEdit();
  emit('refresh');
}
function dueLabel(value: string) {
  return new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' }).format(
    new Date(value)
  );
}
function checklist(task: Task) {
  const total = task.checklists?.reduce((sum, item) => sum + item.items.length, 0) || 0;
  const done =
    task.checklists?.reduce(
      (sum, item) => sum + item.items.filter((child) => child.completed).length,
      0
    ) || 0;
  return { total, done };
}
const priorityClass: Record<string, string> = {
  URGENT: 'bg-red-500',
  HIGH: 'bg-primary',
  MEDIUM: 'bg-amber-500',
  LOW: 'bg-text-faint',
};
</script>

<template>
  <div class="flex min-h-0 flex-col">
    <p
      v-if="error"
      class="mb-3 rounded-xl border border-red-500/20 bg-red-500/5 px-4 py-3 text-sm text-red-500"
    >
      {{ error }}
    </p>

    <div class="mb-4 flex shrink-0 flex-wrap items-center gap-2">
      <div class="relative">
        <Search
          :size="14"
          class="absolute left-2.5 top-1/2 -translate-y-1/2 text-text-muted"
        /><input
          v-model="searchQuery"
          placeholder="Search tasks..."
          class="h-8 w-44 rounded-lg border border-border-default bg-card pl-8 pr-3 text-xs text-foreground outline-none focus:border-primary"
        />
      </div>
      <select
        v-model="filterPriority"
        class="filter-select"
        :class="{ active: filterPriority !== 'ALL' }"
      >
        <option value="ALL">All Priorities</option>
        <option value="URGENT">Urgent</option>
        <option value="HIGH">High</option>
        <option value="MEDIUM">Medium</option>
        <option value="LOW">Low</option>
      </select>
      <select
        v-model="filterAssignee"
        class="filter-select"
        :class="{ active: filterAssignee !== 'ALL' }"
      >
        <option value="ALL">All Assignees</option>
        <option v-for="person in allAssignees" :key="person.id" :value="person.id">
          {{ person.name }}
        </option>
      </select>
      <select
        v-if="board.labels.length"
        v-model="filterLabel"
        class="filter-select"
        :class="{ active: filterLabel !== 'ALL' }"
      >
        <option value="ALL">All Labels</option>
        <option v-for="label in board.labels" :key="label.id" :value="label.id">
          {{ label.name }}
        </option>
      </select>
      <button v-if="hasFilters" class="clear-filter" @click="clearFilters">
        <X :size="12" /> Clear
      </button>
      <button
        class="select-button"
        :class="{ active: selectionMode }"
        @click="selectionMode ? exitSelection() : (selectionMode = true)"
      >
        <ListChecks :size="14" />{{ selectionMode ? 'Done' : 'Select' }}
      </button>
      <button
        class="select-button label-button"
        :class="{ active: labelsOpen }"
        @click="labelsOpen = !labelsOpen"
      >
        <Settings2 :size="14" /> Labels
      </button>
      <button class="refresh" aria-label="Refresh board" @click="emit('refresh')">
        <RefreshCw :size="14" />
      </button>
    </div>

    <section v-if="labelsOpen" class="label-manager">
      <header>
        <div>
          <strong>Board labels</strong>
          <small>Reusable signals available to every task on this board.</small>
        </div>
        <button aria-label="Close label manager" @click="labelsOpen = false">
          <X :size="15" />
        </button>
      </header>
      <div class="label-manager-grid">
        <button
          v-for="label in board.labels"
          :key="label.id"
          class="label-row"
          @click="startLabelEdit(label)"
        >
          <i :style="{ background: label.color }" />
          <span>{{ label.name }}</span>
          <Trash2 :size="13" @click.stop="removeLabel(label.id)" />
        </button>
        <form class="label-form" @submit.prevent="saveLabel">
          <input v-model="labelForm.color" type="color" aria-label="Label color" />
          <input v-model="labelForm.name" placeholder="Label name" required />
          <button>{{ editingLabelId ? 'Save' : 'Add label' }}</button>
        </form>
      </div>
    </section>

    <section class="kanban" aria-label="Kanban board">
      <article
        v-for="(column, columnIndex) in filteredColumns"
        :key="column.id"
        class="column"
        @dragover.prevent
        @drop="drop(column.id, column.tasks.length)"
      >
        <header class="column-header group/column">
          <GripVertical :size="14" class="shrink-0 cursor-grab text-text-faint" />
          <form
            v-if="editingColumnId === column.id"
            class="rename"
            @submit.prevent="saveRename(column.id)"
          >
            <input v-model="editingColumnName" autofocus @keydown.esc="editingColumnId = null" />
          </form>
          <h2 v-else :title="column.name" @dblclick="startRename(column.id, column.name)">
            {{ column.name }}
          </h2>
          <span
            class="count"
            :class="{ over: column.wipLimit && column.tasks.length > column.wipLimit }"
            >{{
              column.wipLimit ? `${column.tasks.length}/${column.wipLimit}` : column.tasks.length
            }}</span
          >
          <div class="column-actions">
            <template v-if="deletingColumnId === column.id"
              ><button class="delete-confirm" @click="removeColumn(column.id)">
                Delete {{ column.tasks.length ? `${column.tasks.length} tasks` : '' }}</button
              ><button @click="deletingColumnId = null">No</button></template
            ><template v-else
              ><button
                title="Move column left"
                :disabled="columnIndex === 0"
                @click="moveColumn(columnIndex, -1)"
              >
                <ChevronLeft :size="14" /></button
              ><button
                title="Move column right"
                :disabled="columnIndex === filteredColumns.length - 1"
                @click="moveColumn(columnIndex, 1)"
              >
                <ChevronRight :size="14" /></button
              ><button title="Delete column" @click="deletingColumnId = column.id">
                <Trash2 :size="14" /></button
              ><button title="Add task" @click="newTaskColumn = column.id">
                <Plus :size="16" /></button
            ></template>
          </div>
        </header>

        <div class="owners">
          <button
            v-for="entry in column.defaultAssignees.slice(0, 4)"
            :key="entry.id"
            :title="entry.user.name"
            class="owner-avatar"
          >
            {{ entry.user.name[0] }}</button
          ><button class="owner-add" @click="openOwners(column)">
            <UserPlus :size="13" />{{ column.defaultAssignees.length ? 'Owners' : 'Set owners' }}
          </button>
          <label class="wip-control"
            >WIP<input
              v-model="wipDraft[column.id]"
              type="number"
              min="1"
              :placeholder="column.wipLimit ? String(column.wipLimit) : '∞'"
              :aria-label="`WIP limit for ${column.name}`"
              @change="saveWip(column.id)"
          /></label>
        </div>
        <div v-if="ownerPickerColumnId === column.id" class="owner-picker">
          <button
            v-for="member in members"
            :key="member.user.id"
            :class="{ selected: ownerDraft.includes(member.user.id) }"
            @click="toggleOwner(member.user.id)"
          >
            <Check :size="12" />{{ member.user.name }}
          </button>
          <footer>
            <button @click="ownerPickerColumnId = null">Cancel</button
            ><button class="save" @click="saveOwners(column.id)">Save</button>
          </footer>
        </div>

        <ol class="task-zone">
          <li
            v-for="(task, taskIndex) in column.tasks"
            :key="task.id"
            @dragover.prevent.stop
            @drop.stop="drop(column.id, taskIndex)"
          >
            <button
              class="task-card group/card"
              :class="{ selected: selected.has(task.id) }"
              draggable="true"
              @dragstart="dragged = task"
              @dragend="dragged = null"
              @click="openTask(task.id)"
            >
              <span
                v-if="selectionMode || selected.has(task.id)"
                class="task-check"
                :class="{ checked: selected.has(task.id) }"
                @click.stop="toggleSelect(task.id)"
                ><Check v-if="selected.has(task.id)" :size="12"
              /></span>
              <span v-if="task.labels.length" class="labels"
                ><i
                  v-for="entry in task.labels"
                  :key="entry.id"
                  :style="{ background: entry.label.color }"
                  :title="entry.label.name"
              /></span>
              <strong>{{ task.title }}</strong>
              <span class="task-footer"
                ><span class="task-signals"
                  ><i
                    class="priority-dot"
                    :class="priorityClass[task.priority]"
                    :title="task.priority"
                  /><span
                    v-if="task.dueDate"
                    :class="new Date(task.dueDate) < new Date() ? 'text-red-500' : ''"
                    ><Calendar :size="12" />{{ dueLabel(task.dueDate) }}</span
                  ><span
                    v-if="checklist(task).total"
                    :class="
                      checklist(task).done === checklist(task).total ? 'text-emerald-500' : ''
                    "
                    ><CheckSquare :size="12" />{{ checklist(task).done }}/{{
                      checklist(task).total
                    }}</span
                  ><span v-if="task._count?.comments"
                    ><MessageSquare :size="12" />{{ task._count.comments }}</span
                  ><span v-if="task._count?.attachments"
                    ><Paperclip :size="12" />{{ task._count.attachments }}</span
                  ></span
                ><span class="faces"
                  ><i
                    v-for="entry in task.assignees.slice(0, 3)"
                    :key="entry.id"
                    :title="entry.user.name"
                    >{{ entry.user.name[0] }}</i
                  ></span
                ></span
              >
            </button>
          </li>

          <li v-if="newTaskColumn === column.id">
            <form class="quick-add" @submit.prevent="createTask(column.id)">
              <input v-model="newTaskTitle" autofocus placeholder="Task title" />
              <div>
                <button type="button" @click="newTaskColumn = null">Cancel</button
                ><button class="save" type="submit">Add Task</button>
              </div>
            </form>
          </li>
          <li v-else>
            <button class="add-task" @click="newTaskColumn = column.id">
              <Plus :size="14" /> Add task
            </button>
          </li>
        </ol>
      </article>

      <article class="new-column">
        <form v-if="addingColumn" @submit.prevent="createColumn">
          <input
            v-model="newColumnName"
            autofocus
            placeholder="Column name..."
            @keydown.esc="addingColumn = false"
          />
          <div>
            <button type="button" @click="addingColumn = false"><X :size="15" /></button
            ><button class="save" type="submit">Add Column</button>
          </div>
        </form>
        <button v-else @click="addingColumn = true"><Plus :size="16" /> Add Column</button>
      </article>
    </section>

    <div v-if="selected.size" class="bulk-bar">
      <b>{{ selected.size }} selected</b><span />
      <select v-model="bulkTarget" aria-label="Move selected tasks to column">
        <option value="">Move to…</option>
        <option v-for="column in board.columns" :key="column.id" :value="column.id">
          {{ column.name }}
        </option>
      </select>
      <button :disabled="bulkBusy || !bulkTarget" @click="moveSelected">Move</button>
      <button class="danger" :disabled="bulkBusy" @click="deleteSelected">
        <Trash2 :size="14" />{{ bulkBusy ? 'Deleting…' : 'Delete' }}</button
      ><button aria-label="Clear selection" @click="exitSelection"><X :size="15" /></button>
    </div>

    <DeliveryTaskDetailDrawer
      :open="!!selectedTaskId"
      :task-id="selectedTaskId"
      :board="board"
      :members="members"
      @close="closeTask"
      @changed="emit('refresh')"
    />
  </div>
</template>

<style scoped>
.filter-select {
  height: 32px;
  border: 1px solid var(--border-default);
  border-radius: 8px;
  padding: 0 10px;
  color: var(--text-muted);
  background: var(--surface-card);
  font-size: 12px;
  font-weight: 600;
  outline: 0;
}
.filter-select.active {
  border-color: color-mix(in srgb, var(--primary) 30%, transparent);
  color: var(--primary);
}
.clear-filter,
.select-button,
.refresh {
  display: inline-flex;
  height: 32px;
  align-items: center;
  gap: 5px;
  border: 0;
  border-radius: 8px;
  padding: 0 10px;
  color: var(--text-muted);
  background: transparent;
  font-size: 11px;
  font-weight: 600;
  cursor: pointer;
}
.clear-filter {
  color: var(--primary);
}
.select-button {
  margin-left: auto;
  border: 1px solid var(--border-default);
}
.select-button.active {
  border-color: color-mix(in srgb, var(--primary) 30%, transparent);
  color: var(--primary);
  background: color-mix(in srgb, var(--primary) 10%, transparent);
}
.label-button {
  margin-left: 0;
}
.label-manager {
  margin-bottom: 14px;
  border: 1px solid var(--border-default);
  border-radius: 18px;
  padding: 14px;
  background: var(--surface-card);
  box-shadow: var(--shadow-xs);
}
.label-manager > header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
}
.label-manager strong,
.label-manager small {
  display: block;
}
.label-manager strong {
  font-size: 13px;
}
.label-manager small {
  margin-top: 2px;
  color: var(--text-muted);
  font-size: 10px;
}
.label-manager > header > button {
  border: 0;
  color: var(--text-muted);
  background: transparent;
}
.label-manager-grid {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 12px;
}
.label-row,
.label-form {
  display: inline-flex;
  min-height: 34px;
  align-items: center;
  gap: 7px;
  border: 1px solid var(--border-subtle);
  border-radius: 10px;
  padding: 0 9px;
  color: var(--foreground);
  background: var(--surface-sunken);
  font-size: 11px;
}
.label-row i {
  width: 9px;
  height: 9px;
  border-radius: 50%;
}
.label-row svg {
  color: var(--text-muted);
}
.label-form input[type='color'] {
  width: 22px;
  height: 22px;
  border: 0;
  padding: 0;
  background: transparent;
}
.label-form input:not([type='color']) {
  width: 130px;
  border: 0;
  color: var(--foreground);
  background: transparent;
  outline: 0;
}
.label-form button {
  border: 0;
  color: white;
  background: var(--primary);
  font-size: 10px;
}
.refresh {
  width: 32px;
  justify-content: center;
  border: 1px solid var(--border-default);
  padding: 0;
}
.kanban {
  display: flex;
  flex: 1;
  min-height: 0;
  align-items: flex-start;
  gap: 16px;
  overflow-x: auto;
  padding-bottom: 16px;
}
.column {
  display: flex;
  width: 288px;
  max-height: calc(100vh - 260px);
  flex: 0 0 288px;
  flex-direction: column;
  border: 1px solid var(--border-default);
  border-radius: 18px;
  padding: 10px;
  background: var(--surface-card);
  box-shadow: var(--shadow-xs);
}
.column-header {
  display: flex;
  min-height: 36px;
  align-items: center;
  gap: 7px;
  padding: 0 4px 10px;
}
.column-header h2 {
  min-width: 0;
  flex: 1;
  overflow: hidden;
  margin: 0;
  color: var(--foreground);
  font-size: 14px;
  font-weight: 650;
  text-overflow: ellipsis;
  white-space: nowrap;
  cursor: default;
}
.rename {
  min-width: 0;
  flex: 1;
}
.rename input {
  width: 100%;
  border: 0;
  border-bottom: 1px solid var(--primary);
  color: var(--foreground);
  background: transparent;
  font-size: 14px;
  font-weight: 650;
  outline: 0;
}
.count {
  display: grid;
  min-width: 20px;
  height: 20px;
  place-items: center;
  border-radius: 999px;
  padding: 0 6px;
  color: var(--text-muted);
  background: var(--surface-sunken);
  font-size: 11px;
  font-weight: 600;
}
.count.over {
  color: #ef4444;
  background: rgb(239 68 68 / 12%);
}
.column-actions {
  display: flex;
  align-items: center;
  gap: 2px;
}
.column-actions button {
  display: grid;
  min-width: 24px;
  height: 24px;
  place-items: center;
  border: 0;
  border-radius: 6px;
  padding: 0 5px;
  color: var(--text-faint);
  background: transparent;
  font-size: 10px;
  cursor: pointer;
}
.column-actions button:hover {
  color: var(--foreground);
  background: var(--surface-sunken);
}
.column-actions button:disabled {
  opacity: 0.25;
  cursor: not-allowed;
}
.column-actions .delete-confirm {
  color: white;
  background: #ef4444;
}
.owners {
  display: flex;
  min-height: 30px;
  align-items: center;
  padding: 0 8px 8px;
}
.owner-avatar {
  display: grid;
  width: 22px;
  height: 22px;
  place-items: center;
  margin-left: -4px;
  border: 2px solid var(--background);
  border-radius: 50%;
  color: var(--background);
  background: var(--foreground);
  font-size: 8px;
}
.owner-add {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  margin-left: 5px;
  border: 0;
  color: var(--text-muted);
  background: transparent;
  font-size: 9px;
  cursor: pointer;
}
.wip-control {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  margin-left: auto;
  color: var(--text-muted);
  font-size: 8px;
  font-weight: 700;
  letter-spacing: 0.04em;
}
.wip-control input {
  width: 34px;
  height: 24px;
  border: 1px solid var(--border-subtle);
  border-radius: 7px;
  color: var(--foreground);
  background: var(--surface-sunken);
  font-size: 9px;
  text-align: center;
  outline: 0;
}
.owner-picker {
  margin: 0 8px 8px;
  border: 1px solid var(--border-default);
  border-radius: 10px;
  padding: 6px;
  background: var(--surface-card);
}
.owner-picker > button {
  display: flex;
  width: 100%;
  align-items: center;
  gap: 6px;
  border: 0;
  border-radius: 6px;
  padding: 6px 7px;
  color: var(--text-muted);
  background: transparent;
  font-size: 11px;
  text-align: left;
}
.owner-picker > button.selected {
  color: var(--primary);
  background: color-mix(in srgb, var(--primary) 10%, transparent);
}
.owner-picker footer {
  display: flex;
  justify-content: flex-end;
  gap: 5px;
  border-top: 1px solid var(--border-subtle);
  margin-top: 5px;
  padding-top: 5px;
}
.owner-picker footer button {
  border: 0;
  border-radius: 6px;
  padding: 5px 8px;
  color: var(--text-muted);
  background: transparent;
  font-size: 10px;
}
.task-zone {
  flex: 1;
  min-height: 100px;
  overflow-y: auto;
  margin: 0;
  border-radius: 12px;
  padding: 8px;
  background: color-mix(in srgb, var(--surface-sunken) 55%, transparent);
  list-style: none;
}
.task-card {
  position: relative;
  width: 100%;
  margin-bottom: 8px;
  border: 1px solid var(--border-subtle);
  border-radius: 12px;
  padding: 13px;
  color: var(--foreground);
  background: var(--surface-card);
  box-shadow: var(--shadow-xs);
  text-align: left;
  cursor: pointer;
  transition: 0.18s ease;
}
.task-card:hover {
  border-color: var(--border-default);
  box-shadow: var(--shadow-sm);
}
.task-card.selected {
  border-color: var(--primary);
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--primary) 25%, transparent);
}
.task-card strong {
  display: block;
  padding-right: 14px;
  font-size: 13px;
  font-weight: 600;
  line-height: 1.35;
}
.task-check {
  position: absolute;
  top: 9px;
  right: 9px;
  display: grid;
  width: 20px;
  height: 20px;
  place-items: center;
  border: 1px solid var(--border-default);
  border-radius: 5px;
  color: transparent;
  background: var(--surface-card);
}
.task-check.checked {
  border-color: var(--primary);
  color: white;
  background: var(--primary);
}
.labels {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  margin-bottom: 8px;
}
.labels i {
  width: 32px;
  height: 6px;
  border-radius: 999px;
}
.task-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-top: 12px;
}
.task-signals {
  display: flex;
  align-items: center;
  gap: 8px;
  color: var(--text-muted);
}
.task-signals > span {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  font-size: 10px;
}
.priority-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
}
.faces {
  display: flex;
}
.faces i {
  display: grid;
  width: 22px;
  height: 22px;
  place-items: center;
  margin-left: -5px;
  border: 2px solid var(--surface-card);
  border-radius: 50%;
  color: var(--background);
  background: var(--foreground);
  font-size: 7px;
  font-style: normal;
}
.add-task {
  display: flex;
  width: 100%;
  min-height: 34px;
  align-items: center;
  gap: 6px;
  border: 1px dashed transparent;
  border-radius: 8px;
  padding: 0 8px;
  color: var(--text-muted);
  background: transparent;
  font-size: 11px;
  cursor: pointer;
}
.add-task:hover {
  border-color: var(--border-default);
  color: var(--foreground);
  background: var(--surface-card);
}
.quick-add,
.new-column form {
  display: grid;
  gap: 8px;
  border: 1px solid color-mix(in srgb, var(--primary) 30%, transparent);
  border-radius: 12px;
  padding: 11px;
  background: var(--surface-card);
}
.quick-add input,
.new-column input {
  width: 100%;
  border: 0;
  color: var(--foreground);
  background: transparent;
  font-size: 13px;
  font-weight: 600;
  outline: 0;
}
.quick-add div,
.new-column form div {
  display: flex;
  justify-content: flex-end;
  gap: 5px;
}
.quick-add button,
.new-column form button {
  border: 0;
  border-radius: 7px;
  padding: 5px 9px;
  color: var(--text-muted);
  background: transparent;
  font-size: 10px;
}
.save {
  color: white !important;
  background: var(--primary) !important;
}
.new-column {
  width: 288px;
  flex: 0 0 288px;
}
.new-column > button {
  display: flex;
  width: 100%;
  min-height: 44px;
  align-items: center;
  justify-content: center;
  gap: 7px;
  border: 1px dashed var(--border-default);
  border-radius: 12px;
  color: var(--text-muted);
  background: color-mix(in srgb, var(--surface-sunken) 30%, transparent);
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
}
.bulk-bar {
  position: fixed;
  bottom: 24px;
  left: 50%;
  z-index: 40;
  display: flex;
  align-items: center;
  gap: 6px;
  transform: translateX(-50%);
  border: 1px solid var(--border-default);
  border-radius: 12px;
  padding: 8px 12px;
  background: var(--surface-card);
  box-shadow: 0 20px 50px rgb(0 0 0 / 25%);
}
.bulk-bar b {
  padding: 0 5px;
  font-size: 12px;
}
.bulk-bar > span {
  width: 1px;
  height: 20px;
  background: var(--border-default);
}
.bulk-bar button {
  display: inline-flex;
  min-height: 28px;
  align-items: center;
  gap: 5px;
  border: 0;
  border-radius: 7px;
  padding: 0 8px;
  color: var(--text-muted);
  background: transparent;
  font-size: 11px;
  font-weight: 600;
}
.bulk-bar select {
  min-height: 28px;
  border: 1px solid var(--border-default);
  border-radius: 7px;
  padding: 0 8px;
  color: var(--foreground);
  background: var(--surface-sunken);
  font-size: 11px;
}
.bulk-bar .danger:hover {
  color: #ef4444;
  background: rgb(239 68 68 / 10%);
}
@media (max-width: 640px) {
  .column {
    width: 86vw;
    flex-basis: 86vw;
  }
  .kanban {
    margin-inline: -20px;
    padding-inline: 20px;
  }
  .select-button {
    margin-left: 0;
  }
}
@media (prefers-reduced-motion: reduce) {
  .task-card {
    transition: none;
  }
}
</style>
