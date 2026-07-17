<script setup lang="ts">
import { Loader2, Plus, X } from 'lucide-vue-next';
import type { Client } from '~/types/crm';
import type { Project } from '~/types/delivery';
import type { TeamMember } from '~/types/firm';

const props = defineProps<{ open: boolean; project?: Project | null }>();
const emit = defineEmits<{ close: []; saved: [Project] }>();
const delivery = useDelivery();
const crm = useCrm();
const firm = useFirm();
const saving = ref(false);
const loadingOptions = ref(false);
const error = ref('');
const clients = ref<Client[]>([]);
const team = ref<TeamMember[]>([]);
const techInput = ref('');
const selectedMembers = ref<string[]>([]);
const form = reactive({
  name: '',
  description: '',
  type: 'CLIENT' as Project['type'],
  status: 'ACTIVE' as Project['status'],
  clientId: '',
  startDate: '',
  endDate: '',
  techStack: [] as string[],
  createDefaultBoard: true,
});

async function loadOptions() {
  if (props.project || (clients.value.length && team.value.length)) return;
  loadingOptions.value = true;
  try {
    const [clientRows, teamRows] = await Promise.all([crm.listClients(), firm.team()]);
    clients.value = clientRows;
    team.value = teamRows;
  } catch {
    // The form remains usable for an internal project if either supporting list is unavailable.
  } finally {
    loadingOptions.value = false;
  }
}

watch(
  () => [props.open, props.project] as const,
  ([open]) => {
    if (!open) return;
    const project = props.project;
    Object.assign(form, {
      name: project?.name || '',
      description: project?.description || '',
      type: project?.type || 'CLIENT',
      status: project?.status || 'ACTIVE',
      clientId: project?.clientId || '',
      startDate: project?.startDate?.slice(0, 10) || '',
      endDate: project?.endDate?.slice(0, 10) || '',
      techStack: [...(project?.techStack || [])],
      createDefaultBoard: true,
    });
    selectedMembers.value = project?.members.map((member) => member.user.id) || [];
    techInput.value = '';
    error.value = '';
    void loadOptions();
  },
  { immediate: true }
);

function addTech() {
  const value = techInput.value.trim();
  if (!value || form.techStack.includes(value)) return;
  form.techStack.push(value);
  techInput.value = '';
}

function toggleMember(id: string) {
  selectedMembers.value = selectedMembers.value.includes(id)
    ? selectedMembers.value.filter((memberId) => memberId !== id)
    : [...selectedMembers.value, id];
}

async function save() {
  if (!form.name.trim()) return;
  saving.value = true;
  error.value = '';
  const body: Record<string, unknown> = {
    name: form.name.trim(),
    description: form.description.trim() || null,
    status: form.status,
    startDate: form.startDate ? new Date(`${form.startDate}T12:00:00Z`).toISOString() : null,
    endDate: form.endDate ? new Date(`${form.endDate}T12:00:00Z`).toISOString() : null,
    techStack: form.techStack,
  };
  try {
    const project = props.project
      ? await delivery.updateProject(props.project.id, body)
      : await delivery.createProject({
          ...body,
          type: form.type,
          clientId: form.type === 'CLIENT' && form.clientId ? form.clientId : null,
          createDefaultBoard: form.createDefaultBoard,
          memberIds: selectedMembers.value,
        });
    emit('saved', project);
    emit('close');
  } catch (caught: any) {
    error.value = caught?.data?.detail || 'The project could not be saved.';
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <Teleport to="body">
    <div v-if="open" class="project-modal-layer" @mousedown.self="emit('close')">
      <section
        class="project-modal"
        role="dialog"
        aria-modal="true"
        :aria-label="project ? 'Edit Project' : 'New Project'"
      >
        <header>
          <h2>{{ project ? 'Edit Project' : 'New Project' }}</h2>
          <button type="button" aria-label="Close" @click="emit('close')"><X :size="16" /></button>
        </header>

        <form id="project-form" class="project-form" @submit.prevent="save">
          <label class="full"
            >Project Name *<input
              v-model="form.name"
              autofocus
              required
              placeholder="e.g. WXW Delivery Platform"
          /></label>

          <div class="field-pair full">
            <fieldset :disabled="!!project">
              <legend>Type</legend>
              <div class="segmented">
                <button
                  v-for="type in ['CLIENT', 'INTERNAL'] as const"
                  :key="type"
                  type="button"
                  :class="{ active: form.type === type }"
                  @click="form.type = type"
                >
                  {{ type === 'CLIENT' ? 'Client' : 'Internal' }}
                </button>
              </div>
            </fieldset>
            <label
              >Status<select v-model="form.status">
                <option value="ACTIVE">Active</option>
                <option value="IN_DEVELOPMENT">In Development</option>
                <option value="ON_HOLD">On Hold</option>
                <option v-if="project" value="COMPLETED">Completed</option>
                <option v-if="project" value="CANCELLED">Cancelled</option>
              </select></label
            >
          </div>

          <label v-if="form.type === 'CLIENT' && !project" class="full"
            >Client<select v-model="form.clientId">
              <option value="">Select client...</option>
              <option v-for="client in clients" :key="client.id" :value="client.id">
                {{ client.name }}
              </option>
            </select></label
          >
          <label class="full"
            >Description<textarea
              v-model="form.description"
              rows="3"
              placeholder="Brief project description..."
            />
          </label>

          <div class="field-pair full">
            <label>Start Date<input v-model="form.startDate" type="date" /></label>
            <label>End Date<input v-model="form.endDate" type="date" /></label>
          </div>

          <label class="full"
            >Tech Stack
            <span class="inline-field"
              ><input
                v-model="techInput"
                placeholder="Add technology..."
                @keydown.enter.prevent="addTech"
              /><button type="button" :disabled="!techInput.trim()" @click="addTech">
                Add
              </button></span
            >
          </label>
          <div v-if="form.techStack.length" class="tech-list full">
            <span v-for="tech in form.techStack" :key="tech"
              >{{ tech
              }}<button
                type="button"
                :aria-label="`Remove ${tech}`"
                @click="form.techStack = form.techStack.filter((item) => item !== tech)"
              >
                <X :size="12" /></button
            ></span>
          </div>

          <fieldset v-if="!project" class="full team-field">
            <legend>
              Team Members <span>({{ selectedMembers.length }} selected)</span>
            </legend>
            <div class="team-options">
              <p v-if="loadingOptions">Loading team…</p>
              <button
                v-for="member in team"
                :key="member.id"
                type="button"
                :class="{ selected: selectedMembers.includes(member.id) }"
                @click="toggleMember(member.id)"
              >
                <span class="avatar">{{ member.name[0] }}</span
                ><span
                  ><b>{{ member.name }}</b
                  ><small>{{ member.title }}</small></span
                >
              </button>
            </div>
          </fieldset>

          <label v-if="!project" class="default-board full"
            ><input v-model="form.createDefaultBoard" type="checkbox" /> Create a default delivery
            board</label
          >
          <p v-if="error" class="project-error full">{{ error }}</p>
        </form>

        <footer>
          <button type="button" class="cancel" @click="emit('close')">Cancel</button>
          <button form="project-form" class="save" :disabled="saving || !form.name.trim()">
            <Loader2 v-if="saving" :size="16" class="spin" /><Plus
              v-else-if="!project"
              :size="16"
            />
            {{ saving ? 'Saving...' : project ? 'Save Changes' : 'Create Project' }}
          </button>
        </footer>
      </section>
    </div>
  </Teleport>
</template>

<style scoped>
.project-modal-layer {
  position: fixed;
  inset: 0;
  z-index: 100;
  display: grid;
  place-items: center;
  padding: 16px;
  background: rgb(0 0 0 / 40%);
  backdrop-filter: blur(4px);
}
.project-modal {
  width: min(512px, 100%);
  max-height: 90vh;
  overflow: auto;
  border: 1px solid var(--border-default);
  border-radius: 16px;
  color: var(--foreground);
  background: var(--background);
  box-shadow: 0 25px 60px rgb(0 0 0 / 22%);
}
.project-modal > header {
  position: sticky;
  top: 0;
  z-index: 2;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 16px 24px;
  border-bottom: 1px solid var(--border-subtle);
  background: color-mix(in srgb, var(--background) 92%, transparent);
  backdrop-filter: blur(16px);
}
h2 {
  margin: 0;
  font-size: 18px;
  font-weight: 700;
  letter-spacing: -0.02em;
}
header button {
  display: grid;
  width: 32px;
  height: 32px;
  place-items: center;
  border: 0;
  border-radius: 8px;
  color: var(--text-muted);
  background: transparent;
  cursor: pointer;
}
header button:hover {
  color: var(--foreground);
  background: var(--surface-sunken);
}
.project-form {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 20px 12px;
  padding: 24px;
}
.full {
  grid-column: 1 / -1;
}
label,
fieldset {
  display: grid;
  gap: 6px;
  min-width: 0;
  margin: 0;
  padding: 0;
  border: 0;
  color: var(--foreground);
  font-size: 14px;
  font-weight: 500;
}
legend {
  margin-bottom: 6px;
  font-size: 14px;
  font-weight: 500;
}
legend span {
  color: var(--text-muted);
  font-weight: 400;
}
input,
textarea,
select {
  width: 100%;
  min-height: 40px;
  border: 1px solid var(--border-default);
  border-radius: 12px;
  padding: 9px 12px;
  color: var(--foreground);
  background: var(--surface-card);
  font: inherit;
  outline: 0;
}
textarea {
  resize: none;
}
input:focus,
textarea:focus,
select:focus {
  border-color: var(--primary);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--primary) 18%, transparent);
}
.field-pair {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 12px;
}
.segmented {
  display: flex;
  overflow: hidden;
  min-height: 40px;
  border: 1px solid var(--border-default);
  border-radius: 12px;
}
.segmented button {
  flex: 1;
  border: 0;
  color: var(--text-muted);
  background: var(--surface-card);
  font-size: 12px;
  font-weight: 500;
  cursor: pointer;
}
.segmented button.active {
  color: var(--background);
  background: var(--foreground);
}
.inline-field {
  display: flex;
  gap: 8px;
}
.inline-field button {
  border: 0;
  border-radius: 12px;
  padding: 0 14px;
  color: var(--foreground);
  background: var(--surface-sunken);
  font-weight: 600;
}
.inline-field button:disabled {
  opacity: 0.4;
}
.tech-list {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: -12px;
}
.tech-list > span {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  border-radius: 8px;
  padding: 5px 9px;
  background: var(--surface-sunken);
  font-size: 12px;
  font-weight: 600;
}
.tech-list button {
  display: grid;
  place-items: center;
  border: 0;
  padding: 0;
  color: var(--text-muted);
  background: transparent;
}
.team-options {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 6px;
  max-height: 160px;
  overflow: auto;
  border: 1px solid var(--border-default);
  border-radius: 12px;
  padding: 8px;
  background: var(--surface-card);
}
.team-options > button {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  border: 0;
  border-radius: 8px;
  padding: 8px 10px;
  color: var(--foreground);
  background: transparent;
  text-align: left;
  cursor: pointer;
}
.team-options > button:hover {
  background: var(--surface-sunken);
}
.team-options > button.selected {
  background: color-mix(in srgb, var(--primary) 10%, transparent);
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--primary) 25%, transparent);
}
.avatar {
  display: grid;
  flex: 0 0 24px;
  width: 24px;
  height: 24px;
  place-items: center;
  border-radius: 50%;
  background: var(--surface-sunken);
  font-size: 9px;
}
.team-options b,
.team-options small {
  display: block;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.team-options b {
  font-size: 12px;
}
.team-options small {
  color: var(--text-muted);
  font-size: 10px;
  font-weight: 400;
}
.default-board {
  display: flex;
  grid-column: 1 / -1;
  align-items: center;
  gap: 9px;
  color: var(--text-muted);
  font-size: 12px;
}
.default-board input {
  width: 16px;
  min-height: 16px;
  accent-color: var(--primary);
}
.project-error {
  margin: 0;
  border: 1px solid #fecaca;
  border-radius: 9px;
  padding: 8px 11px;
  color: #dc2626;
  background: #fef2f2;
  font-size: 12px;
}
.project-modal > footer {
  position: sticky;
  bottom: 0;
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  padding: 16px 24px;
  border-top: 1px solid var(--border-subtle);
  background: var(--background);
}
footer button {
  min-height: 40px;
  border: 0;
  border-radius: 12px;
  padding: 0 16px;
  font-size: 14px;
  font-weight: 600;
  cursor: pointer;
}
.cancel {
  color: var(--text-muted);
  background: transparent;
}
.save {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  color: white;
  background: var(--primary);
}
.save:disabled {
  opacity: 0.4;
  pointer-events: none;
}
.spin {
  animation: spin 1s linear infinite;
}
@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}
@media (max-width: 560px) {
  .project-form,
  .field-pair,
  .team-options {
    grid-template-columns: 1fr;
  }
  .full {
    grid-column: auto;
  }
}
</style>
