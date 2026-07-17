<script setup lang="ts">
import { Check, Clock3, Link2, MessageSquare, Paperclip, Plus, Trash2, X } from 'lucide-vue-next';
import type { Board, ProjectMember, Task, TimeEntry } from '~/types/delivery';

const props = defineProps<{
  open: boolean;
  taskId: string | null;
  board: Board;
  members: ProjectMember[];
}>();
const emit = defineEmits<{ close: []; changed: [] }>();
const delivery = useDelivery();
const task = ref<Task | null>(null);
const timeEntries = ref<TimeEntry[]>([]);
const loading = ref(false);
const saving = ref(false);
const error = ref('');
const comment = ref('');
const replyToId = ref<string | null>(null);
const editingCommentId = ref<string | null>(null);
const commentDraft = ref('');
const checklistName = ref('');
const itemText = reactive<Record<string, string>>({});
const attachment = reactive({ name: '', url: '' });
const time = reactive({ hours: '', description: '', date: new Date().toISOString().slice(0, 10) });
const editingTimeId = ref<string | null>(null);
const timeEdit = reactive({ hours: '', description: '', date: '' });
const form = reactive({
  title: '',
  description: '',
  priority: 'MEDIUM',
  dueDate: '',
  columnId: '',
  assigneeIds: [] as string[],
  labelIds: [] as string[],
});
const parentId = ref('');
const blockingTaskId = ref('');
const allTasks = computed(() =>
  props.board.columns.flatMap((column) => column.tasks).filter((item) => item.id !== props.taskId)
);

watch(
  () => [props.open, props.taskId] as const,
  ([open]) => {
    if (open && props.taskId) load();
  },
  { immediate: true }
);
function syncForm(record: Task) {
  Object.assign(form, {
    title: record.title,
    description: record.description || '',
    priority: record.priority,
    dueDate: record.dueDate?.slice(0, 10) || '',
    columnId: record.columnId,
    assigneeIds: record.assignees.map((a) => a.user.id),
    labelIds: record.labels.map((l) => l.label.id),
  });
  parentId.value = record.parentId || '';
}
async function load() {
  if (!props.taskId) return;
  loading.value = true;
  error.value = '';
  try {
    const [record, entries] = await Promise.all([
      delivery.getTask(props.taskId),
      delivery.listTaskTime(props.taskId),
    ]);
    task.value = record;
    timeEntries.value = entries;
    syncForm(record);
  } catch (caught: any) {
    error.value = caught?.data?.detail || 'The task record could not be read.';
  } finally {
    loading.value = false;
  }
}
async function change(action: () => Promise<unknown>) {
  saving.value = true;
  error.value = '';
  try {
    await action();
    await load();
    emit('changed');
  } catch (caught: any) {
    error.value = caught?.data?.detail || 'The task change could not be saved.';
  } finally {
    saving.value = false;
  }
}
async function saveTask() {
  const taskId = String(props.taskId);
  const currentLabels = new Set(task.value?.labels.map((entry) => entry.label.id) || []);
  const selectedLabels = new Set(form.labelIds);
  await change(async () => {
    await delivery.updateTask(taskId, {
      title: form.title,
      description: form.description || null,
      priority: form.priority,
      dueDate: form.dueDate ? new Date(`${form.dueDate}T12:00:00Z`).toISOString() : null,
      columnId: form.columnId,
    });
    await delivery.setTaskAssignees(taskId, form.assigneeIds);
    await Promise.all([
      ...[...selectedLabels]
        .filter((id) => !currentLabels.has(id))
        .map((id) => delivery.addTaskLabel(taskId, id)),
      ...[...currentLabels]
        .filter((id) => !selectedLabels.has(id))
        .map((id) => delivery.removeTaskLabel(taskId, id)),
    ]);
  });
}
async function addComment() {
  if (!comment.value.trim()) return;
  const value = comment.value;
  comment.value = '';
  const parentId = replyToId.value || undefined;
  replyToId.value = null;
  await change(() => delivery.addComment(String(props.taskId), value, parentId));
}
function startCommentEdit(id: string, content: string) {
  editingCommentId.value = id;
  commentDraft.value = content;
}
async function saveComment(id: string) {
  if (!commentDraft.value.trim()) return;
  const value = commentDraft.value.trim();
  editingCommentId.value = null;
  commentDraft.value = '';
  await change(() => delivery.updateComment(id, value));
}
async function addChecklist() {
  if (!checklistName.value.trim()) return;
  const value = checklistName.value;
  checklistName.value = '';
  await change(() => delivery.createChecklist(String(props.taskId), value));
}
async function addItem(id: string) {
  if (!itemText[id]?.trim()) return;
  const value = itemText[id];
  itemText[id] = '';
  await change(() => delivery.createChecklistItem(id, value));
}
function renameChecklist(id: string, event: Event) {
  const value = (event.target as HTMLInputElement).value.trim();
  if (value) void change(() => delivery.updateChecklist(id, value));
}
function renameChecklistItem(id: string, event: Event) {
  const text = (event.target as HTMLInputElement).value.trim();
  if (text) void change(() => delivery.updateChecklistItem(id, { text }));
}
async function addAttachment() {
  if (!attachment.name || !attachment.url) return;
  const body = { ...attachment };
  Object.assign(attachment, { name: '', url: '' });
  await change(() => delivery.addAttachment(String(props.taskId), body));
}
async function setParent() {
  await change(() => delivery.setTaskParent(String(props.taskId), parentId.value || null));
}
async function addBlocker() {
  if (!blockingTaskId.value) return;
  const id = blockingTaskId.value;
  blockingTaskId.value = '';
  await change(() => delivery.addBlocker(String(props.taskId), id));
}
async function addTime() {
  if (!time.hours) return;
  const body = {
    taskId: props.taskId,
    projectId: props.board.projectId,
    hours: Number(time.hours),
    description: time.description || null,
    date: new Date(`${time.date}T12:00:00Z`).toISOString(),
  };
  Object.assign(time, { hours: '', description: '', date: new Date().toISOString().slice(0, 10) });
  await change(() => delivery.addTime(body));
}
function startTimeEdit(entry: TimeEntry) {
  editingTimeId.value = entry.id;
  Object.assign(timeEdit, {
    hours: String(entry.hours),
    description: entry.description || '',
    date: entry.date.slice(0, 10),
  });
}
async function saveTime(id: string) {
  await change(() =>
    delivery.updateTime(id, {
      hours: Number(timeEdit.hours),
      description: timeEdit.description || null,
      date: new Date(`${timeEdit.date}T12:00:00Z`).toISOString(),
    })
  );
  editingTimeId.value = null;
}
async function removeTask() {
  if (!task.value || !confirm(`Delete “${task.value.title}”?`)) return;
  saving.value = true;
  try {
    await delivery.removeTask(task.value.id);
    emit('changed');
    emit('close');
  } catch (caught: any) {
    error.value = caught?.data?.detail || 'The task could not be deleted.';
  } finally {
    saving.value = false;
  }
}
function toggleId(list: string[], id: string) {
  const i = list.indexOf(id);
  i >= 0 ? list.splice(i, 1) : list.push(id);
}
function onKeydown(event: KeyboardEvent) {
  if (props.open && event.key === 'Escape') emit('close');
}
onMounted(() => window.addEventListener('keydown', onKeydown));
onBeforeUnmount(() => window.removeEventListener('keydown', onKeydown));
</script>

<template>
  <Teleport to="body"
    ><div v-if="open" class="drawer-layer" @mousedown.self="emit('close')">
      <aside class="task-drawer" role="dialog" aria-modal="true" aria-label="Task detail">
        <header>
          <div>
            <p>Delivery / Task</p>
            <h2>{{ task?.title || 'Task detail' }}</h2>
          </div>
          <div class="drawer-actions">
            <button v-if="task" class="drawer-delete" aria-label="Delete task" @click="removeTask">
              <Trash2 :size="16" />
            </button>
            <button aria-label="Close task" @click="emit('close')"><X :size="18" /></button>
          </div>
        </header>
        <DeliveryFieldState
          v-if="loading || error"
          :loading="loading"
          :error="error"
          action="Try again"
          @action="load"
        />
        <div v-else-if="task" class="drawer-body">
          <section class="task-form">
            <label>Task title<input v-model="form.title" /></label
            ><label>Working note<textarea v-model="form.description" rows="4" /></label>
            <div class="form-grid">
              <label
                >Priority<select v-model="form.priority">
                  <option v-for="p in ['LOW', 'MEDIUM', 'HIGH', 'URGENT']" :key="p">{{ p }}</option>
                </select></label
              ><label>Due date<input v-model="form.dueDate" type="date" /></label
              ><label
                >Stage<select v-model="form.columnId">
                  <option v-for="column in board.columns" :key="column.id" :value="column.id">
                    {{ column.name }}
                  </option>
                </select></label
              >
            </div>
            <fieldset>
              <legend>Assignees</legend>
              <button
                v-for="member in members"
                :key="member.id"
                type="button"
                :class="{ chosen: form.assigneeIds.includes(member.user.id) }"
                @click="toggleId(form.assigneeIds, member.user.id)"
              >
                <Check :size="12" />{{ member.user.name }}
              </button>
            </fieldset>
            <fieldset>
              <legend>Labels</legend>
              <button
                v-for="label in board.labels"
                :key="label.id"
                type="button"
                :class="{ chosen: form.labelIds.includes(label.id) }"
                @click="toggleId(form.labelIds, label.id)"
              >
                <i :style="{ background: label.color }" />{{ label.name }}
              </button>
            </fieldset>
            <button class="button save" :disabled="saving" @click="saveTask">Save task note</button>
          </section>

          <section>
            <h3><MessageSquare :size="15" />Conversation</h3>
            <div class="comments">
              <article v-for="entry in task.comments" :key="entry.id">
                <span>{{ entry.user?.name.slice(0, 1) }}</span>
                <div>
                  <div class="comment-head">
                    <strong>{{ entry.user?.name }}</strong>
                    <span>
                      <button @click="replyToId = entry.id">Reply</button>
                      <button @click="startCommentEdit(entry.id, entry.content)">Edit</button>
                      <button @click="change(() => delivery.removeComment(entry.id))">
                        Delete
                      </button>
                    </span>
                  </div>
                  <form
                    v-if="editingCommentId === entry.id"
                    class="inline-form"
                    @submit.prevent="saveComment(entry.id)"
                  >
                    <input v-model="commentDraft" autofocus />
                    <button>Save</button>
                  </form>
                  <p v-else>{{ entry.content }}</p>
                  <small>{{ new Date(entry.createdAt).toLocaleString() }}</small>
                  <div v-for="reply in entry.replies" :key="reply.id" class="comment-reply">
                    <strong>{{ reply.user?.name }}</strong>
                    <span>{{ reply.content }}</span>
                  </div>
                </div>
              </article>
            </div>
            <form class="inline-form" @submit.prevent="addComment">
              <input
                v-model="comment"
                :placeholder="replyToId ? 'Write a reply…' : 'Add a field note'"
              /><button>{{ replyToId ? 'Reply' : 'Add note' }}</button>
              <button v-if="replyToId" type="button" class="cancel" @click="replyToId = null">
                Cancel
              </button>
            </form>
          </section>

          <section>
            <h3><Check :size="15" />Checklists</h3>
            <article v-for="list in task.checklists" :key="list.id" class="checklist">
              <header>
                <input
                  :value="list.name"
                  class="checklist-name"
                  aria-label="Checklist name"
                  @change="renameChecklist(list.id, $event)"
                />
                ><button
                  aria-label="Delete checklist"
                  @click="change(() => delivery.removeChecklist(list.id))"
                >
                  <Trash2 :size="13" />
                </button>
              </header>
              <label v-for="item in list.items" :key="item.id"
                ><input
                  type="checkbox"
                  :checked="item.completed"
                  @change="
                    change(() =>
                      delivery.updateChecklistItem(item.id, { completed: !item.completed })
                    )
                  " /><input
                  :value="item.text"
                  class="checklist-item-text"
                  aria-label="Checklist item"
                  @change="renameChecklistItem(item.id, $event)" /><button
                  aria-label="Delete item"
                  @click.prevent="change(() => delivery.removeChecklistItem(item.id))"
                >
                  <X :size="12" /></button
              ></label>
              <form class="inline-form" @submit.prevent="addItem(list.id)">
                <input v-model="itemText[list.id]" placeholder="Checklist item" /><button>
                  Add
                </button>
              </form>
            </article>
            <form class="inline-form" @submit.prevent="addChecklist">
              <input v-model="checklistName" placeholder="New checklist" /><button>
                <Plus :size="13" /> Add list
              </button>
            </form>
          </section>

          <section>
            <h3><Paperclip :size="15" />Attachments</h3>
            <a
              v-for="file in task.attachments"
              :key="file.id"
              class="file-row"
              :href="file.url"
              target="_blank"
              ><Link2 :size="14" /><span>{{ file.name }}</span
              ><button
                aria-label="Remove attachment"
                @click.prevent="change(() => delivery.removeAttachment(file.id))"
              >
                <Trash2 :size="13" /></button
            ></a>
            <form class="two-form" @submit.prevent="addAttachment">
              <input v-model="attachment.name" placeholder="File name" required /><input
                v-model="attachment.url"
                type="url"
                placeholder="https://…"
                required
              /><button>Add reference</button>
            </form>
          </section>

          <section>
            <h3>Structure & dependencies</h3>
            <div class="two-form">
              <label
                >Parent task<select v-model="parentId" @change="setParent">
                  <option value="">No parent</option>
                  <option v-for="item in allTasks" :key="item.id" :value="item.id">
                    {{ item.title }}
                  </option>
                </select></label
              ><label
                >Blocked by<select v-model="blockingTaskId" @change="addBlocker">
                  <option value="">Add blocker…</option>
                  <option v-for="item in allTasks" :key="item.id" :value="item.id">
                    {{ item.title }}
                  </option>
                </select></label
              >
            </div>
            <div class="dependency" v-for="edge in task.blockedBy" :key="edge.id">
              <span>Blocked by {{ edge.blockingTask.title }}</span
              ><button @click="change(() => delivery.removeBlocker(edge.id))">
                <X :size="12" />
              </button>
            </div>
            <p v-if="task.subtasks?.length" class="subtasks">
              {{ task.subtasks.length }} subtasks:
              {{ task.subtasks.map((s) => s.title).join(', ') }}
            </p>
          </section>

          <section>
            <h3><Clock3 :size="15" />Time ledger</h3>
            <div class="time-row" v-for="entry in timeEntries" :key="entry.id">
              <template v-if="editingTimeId === entry.id">
                <input v-model="timeEdit.hours" type="number" min=".01" step=".25" />
                <input v-model="timeEdit.date" type="date" />
                <input v-model="timeEdit.description" placeholder="Work note" />
                <button @click="saveTime(entry.id)">Save</button>
              </template>
              <template v-else>
                <span>{{ entry.description || 'Task work' }}</span
                ><b>{{ entry.hours }}h</b
                ><small>{{ new Date(entry.date).toLocaleDateString() }}</small>
                <span class="time-actions">
                  <button @click="startTimeEdit(entry)">Edit</button>
                  <button @click="change(() => delivery.removeTime(entry.id))">Delete</button>
                </span>
              </template>
            </div>
            <form class="three-form" @submit.prevent="addTime">
              <input
                v-model="time.hours"
                type="number"
                min=".01"
                step=".25"
                placeholder="Hours"
              /><input v-model="time.date" type="date" /><input
                v-model="time.description"
                placeholder="Work note"
              /><button>Log</button>
            </form>
          </section>
        </div>
      </aside>
    </div></Teleport
  >
</template>

<style scoped>
.drawer-layer {
  position: fixed;
  inset: 0;
  z-index: 75;
  background: rgb(17 17 16 / 28%);
  backdrop-filter: blur(2px);
}
.task-drawer {
  position: absolute;
  inset: 0 0 0 auto;
  width: min(680px, 100%);
  overflow: auto;
  background: var(--surface-card);
  border-left: 1px solid var(--border-default);
  box-shadow: -24px 0 70px rgba(24, 31, 25, 0.2);
}
.task-drawer > header {
  position: sticky;
  top: 0;
  z-index: 3;
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 21px 24px;
  border-bottom: 1px solid var(--border-default);
  color: var(--foreground);
  background: var(--surface-card);
}
.task-drawer > header p {
  margin: 0 0 4px;
  color: var(--primary);
  font:
    9px 'IBM Plex Mono',
    monospace;
  text-transform: uppercase;
}
.task-drawer > header h2 {
  margin: 0;
  font-size: 24px;
  font-weight: 650;
  letter-spacing: -0.03em;
}
.task-drawer > header button {
  display: grid;
  place-items: center;
  width: 34px;
  height: 34px;
  color: var(--text-muted);
  background: transparent;
  border: 1px solid var(--border-default);
  border-radius: 10px;
}
.drawer-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}
.task-drawer > header .drawer-delete:hover {
  border-color: rgb(239 68 68 / 35%);
  color: #ef4444;
  background: rgb(239 68 68 / 8%);
}
.drawer-body {
  padding: 22px;
}
.drawer-body > section {
  padding: 19px 0;
  border-top: 1px solid var(--border-default);
}
.drawer-body > section:first-child {
  padding-top: 0;
  border-top: 0;
}
h3 {
  display: flex;
  align-items: center;
  gap: 7px;
  margin: 0 0 13px;
  font-size: 16px;
  font-weight: 650;
}
.task-form,
.task-form label {
  display: grid;
  gap: 7px;
}
.task-form > label,
.form-grid label,
.two-form label {
  font-size: 10px;
  font-weight: 600;
}
.task-form input,
.task-form textarea,
.task-form select,
.inline-form input,
.two-form input,
.two-form select,
.three-form input {
  width: 100%;
  padding: 9px;
  color: var(--foreground);
  background: var(--surface-sunken);
  border: 1px solid var(--border-default);
  border-radius: 10px;
}
.form-grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 10px;
}
fieldset {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin: 6px 0 0;
  padding: 11px;
  border: 1px solid var(--border-default);
  border-radius: 12px;
}
legend {
  color: var(--text-muted);
  font:
    9px 'IBM Plex Mono',
    monospace;
  text-transform: uppercase;
}
fieldset button {
  display: flex;
  align-items: center;
  gap: 5px;
  padding: 6px 8px;
  color: var(--text-muted);
  background: var(--surface-card);
  border: 1px solid var(--border-default);
  border-radius: 9px;
  font-size: 9px;
}
fieldset button.chosen {
  color: white;
  background: var(--primary);
  border-color: var(--primary);
}
fieldset i {
  width: 8px;
  height: 8px;
  border-radius: 50%;
}
.save {
  justify-self: end;
}
.comments article {
  display: grid;
  grid-template-columns: 30px 1fr;
  gap: 9px;
  padding: 11px 0;
  border-top: 1px solid var(--border-default);
}
.comments article > span {
  display: grid;
  place-items: center;
  width: 27px;
  height: 27px;
  color: white;
  background: var(--foreground);
  border-radius: 50%;
  font-size: 8px;
}
.comments strong {
  font-size: 10px;
}
.comment-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.comment-head > span {
  display: flex;
  gap: 4px;
}
.comment-head button,
.time-actions button {
  border: 0;
  padding: 2px 4px;
  color: var(--text-muted);
  background: transparent;
  font-size: 8px;
}
.comment-head button:hover,
.time-actions button:hover {
  color: var(--primary);
}
.comment-reply {
  display: grid;
  gap: 2px;
  margin-top: 8px;
  border-left: 2px solid var(--border-default);
  padding-left: 8px;
  color: var(--text-muted);
  font-size: 10px;
}
.comments p {
  margin: 3px 0;
  font-size: 12px;
  line-height: 1.5;
}
.comments small,
.time-row small {
  color: var(--text-muted);
  font-size: 9px;
}
.inline-form {
  display: flex;
  gap: 6px;
  margin-top: 9px;
}
.inline-form button,
.two-form button,
.three-form button {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 4px;
  padding: 8px 10px;
  color: white;
  background: var(--primary);
  border: 0;
  font-size: 9px;
  white-space: nowrap;
}
.inline-form .cancel {
  color: var(--text-muted);
  background: var(--surface-sunken);
}
.checklist {
  margin-bottom: 10px;
  padding: 11px;
  background: var(--surface-sunken);
  border: 1px solid var(--border-default);
  border-radius: 12px;
}
.checklist header {
  display: flex;
  justify-content: space-between;
}
.checklist-name,
.checklist-item-text {
  width: 100%;
  border: 0;
  color: var(--foreground);
  background: transparent;
  outline: 0;
}
.checklist-name {
  font-size: 11px;
  font-weight: 650;
}
.checklist-item-text {
  font-size: 11px;
}
.checklist header button,
.checklist label button,
.file-row button,
.dependency button {
  color: var(--text-muted);
  background: transparent;
  border: 0;
}
.checklist label {
  display: grid;
  grid-template-columns: 17px 1fr 20px;
  gap: 7px;
  align-items: center;
  padding: 7px 0;
  border-top: 1px solid var(--border-default);
  font-size: 11px;
}
.file-row,
.dependency {
  display: grid;
  grid-template-columns: 20px 1fr auto;
  gap: 7px;
  padding: 10px 2px;
  border-top: 1px solid var(--border-default);
  font-size: 11px;
}
.two-form,
.three-form {
  display: grid;
  grid-template-columns: 1fr 1fr auto;
  gap: 7px;
  margin-top: 9px;
}
.dependency {
  grid-template-columns: 1fr auto;
  color: #b54734;
}
.subtasks {
  color: var(--text-muted);
  font-size: 10px;
}
.time-row {
  display: grid;
  grid-template-columns: 1fr auto 90px auto;
  gap: 8px;
  padding: 9px 2px;
  border-top: 1px solid var(--border-default);
  font-size: 11px;
}
.time-row > input {
  min-width: 0;
  border: 1px solid var(--border-default);
  border-radius: 8px;
  padding: 6px;
  color: var(--foreground);
  background: var(--surface-sunken);
  font-size: 10px;
}
.time-row > button {
  border: 0;
  border-radius: 8px;
  padding: 0 10px;
  color: white;
  background: var(--primary);
  font-size: 9px;
}
.time-actions {
  display: flex;
  justify-content: flex-end;
  gap: 2px;
}
.three-form {
  grid-template-columns: 90px 130px 1fr auto;
}
@media (max-width: 580px) {
  .drawer-body {
    padding: 16px;
  }
  .form-grid,
  .two-form,
  .three-form,
  .time-row {
    grid-template-columns: 1fr;
  }
  .inline-form {
    align-items: stretch;
    flex-direction: column;
  }
}
</style>
