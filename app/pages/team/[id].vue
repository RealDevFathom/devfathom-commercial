<script setup lang="ts">
import {
  Activity,
  ArrowLeft,
  BookOpen,
  CalendarDays,
  CheckSquare,
  Circle,
  FolderKanban,
  KeyRound,
  Mail,
  Pencil,
  Phone,
  Save,
  UserMinus,
} from 'lucide-vue-next';
import type { LeaveBalance, LeaveRequest, TeamMember } from '~/types/firm';

interface MemberProject {
  id: string;
  name: string;
  type: string;
  status: string;
  role: string;
}
interface MemberTask {
  id: string;
  title: string;
  priority: string;
  columnName: string;
}
interface MemberDetail extends TeamMember {
  projects: MemberProject[];
  tasks: MemberTask[];
  leaveRequests: LeaveRequest[];
}

const route = useRoute();
const api = useFirm();
const { user } = useAuth();
const {
  pending: actionPending,
  error: actionError,
  success: actionSuccess,
  clear: clearAction,
  run: runAction,
} = useFirmAction();
const id = String(route.params.id);
const member = ref<MemberDetail | null>(null);
const notes = ref<Record<string, any>[]>([]);
const balances = ref<LeaveBalance[]>([]);
const loading = ref(true);
const error = ref('');
const editing = ref(false);
const resetOpen = ref(false);
const layoffOpen = ref(false);
const temporaryPassword = ref('');
const layoffReason = ref('');
const draft = reactive({
  name: '',
  email: '',
  role: 'EMPLOYEE',
  department: 'ENGINEERING',
  title: '',
  status: 'ACTIVE',
  phone: '',
  bio: '',
  skills: [] as string[],
});
const note = ref('');
const isAdmin = computed(() => user.value?.role === 'ADMIN');
const canViewPersonal = computed(() => isAdmin.value || user.value?.id === id);

async function load(showSpinner = true) {
  if (showSpinner) loading.value = true;
  error.value = '';
  try {
    const record = (await api.member(id)) as Partial<MemberDetail> & TeamMember;
    member.value = {
      ...record,
      projects: record.projects || [],
      tasks: record.tasks || [],
      leaveRequests: record.leaveRequests || [],
    };
    Object.assign(draft, member.value);
    if (canViewPersonal.value) {
      const [noteResult, balanceResult] = await Promise.all([
        api.performanceNotes(id),
        api.balances(id),
      ]);
      notes.value = noteResult;
      balances.value = balanceResult.types;
    }
    useHead({ title: `${member.value.name} · Team` });
  } catch (caught: any) {
    error.value = caught?.data?.detail || 'This team record is unavailable.';
  } finally {
    loading.value = false;
  }
}
await load();

const initials = computed(() =>
  (member.value?.name || '')
    .split(' ')
    .map((part) => part[0])
    .join('')
    .slice(0, 2)
    .toUpperCase()
);
const pretty = (value?: string | null) =>
  value ? value.charAt(0) + value.slice(1).toLowerCase().replaceAll('_', ' ') : '—';
const date = (value?: string | null) =>
  value ? new Intl.DateTimeFormat('en', { dateStyle: 'medium' }).format(new Date(value)) : '—';

async function save() {
  if (!isAdmin.value) return;
  const result = await runAction('Saving member…', () => api.updateMember(id, { ...draft }), {
    success: 'Team member updated.',
    error: 'The team member could not be updated.',
  });
  if (!result) return;
  member.value = { ...(member.value as MemberDetail), ...result };
  editing.value = false;
}
async function addNote() {
  if (!isAdmin.value || !note.value.trim()) return;
  const result = await runAction(
    'Adding performance note…',
    async () => {
      const created = await api.addPerformanceNote(id, note.value.trim());
      await load(false);
      return created;
    },
    { success: 'Performance note added.', error: 'The performance note could not be added.' }
  );
  if (!result) return;
  note.value = '';
}
async function resetPassword() {
  if (!isAdmin.value || user.value?.id === id) return;
  const result = await runAction(
    'Resetting password…',
    () => api.adminResetPassword(id, temporaryPassword.value),
    {
      success: 'Password reset. Share the temporary password through a secure channel.',
      error: 'The password could not be reset.',
    }
  );
  if (!result) return;
  resetOpen.value = false;
  temporaryPassword.value = '';
}
async function layoff() {
  if (!isAdmin.value || user.value?.id === id) return;
  const result = await runAction(
    'Deactivating member…',
    async () => {
      const response = await api.layoff(id, layoffReason.value.trim());
      await load(false);
      return response;
    },
    { success: 'Member access deactivated.', error: 'The member could not be deactivated.' }
  );
  if (!result) return;
  layoffOpen.value = false;
  layoffReason.value = '';
}
</script>

<template>
  <section class="animate-fade-in space-y-6">
    <div class="flex items-center justify-between gap-4">
      <NuxtLink
        class="inline-flex items-center gap-1.5 text-sm text-text-muted transition-colors hover:text-foreground"
        to="/team"
        ><ArrowLeft :size="16" /> Back to Team</NuxtLink
      >
      <div v-if="member && isAdmin && user?.id !== id" class="flex flex-wrap gap-2">
        <button
          class="flex items-center gap-1.5 rounded-xl border border-border bg-card px-3.5 py-2 text-xs font-medium text-foreground transition-colors hover:bg-secondary"
          :disabled="Boolean(actionPending)"
          @click="editing = !editing"
        >
          <Pencil :size="14" /> Edit
        </button>
        <button
          class="flex items-center gap-1.5 rounded-xl border border-border bg-card px-3.5 py-2 text-xs font-medium text-text-muted transition-colors hover:bg-secondary hover:text-foreground"
          :disabled="Boolean(actionPending)"
          @click="resetOpen = true"
        >
          <KeyRound :size="14" /> Reset Password
        </button>
        <button
          class="flex items-center gap-1.5 rounded-xl border border-border bg-card px-3.5 py-2 text-xs font-medium text-text-muted transition-colors hover:border-red-500/20 hover:bg-red-500/10 hover:text-red-500"
          :disabled="Boolean(actionPending)"
          @click="layoffOpen = true"
        >
          <UserMinus :size="14" /> Lay off
        </button>
      </div>
    </div>

    <FirmActionFeedback
      :busy="Boolean(actionPending)"
      :busy-label="actionPending"
      :error="actionError"
      :success="actionSuccess"
      @dismiss="clearAction"
    />

    <DeliveryFieldState
      v-if="loading || error"
      :loading="loading"
      :error="error"
      action="Try again"
      @action="load"
    />

    <template v-else-if="member">
      <header class="member-hero">
        <span class="member-avatar">
          <img v-if="member.avatar" :src="member.avatar" :alt="member.name" />
          <template v-else>{{ initials }}</template>
        </span>
        <div class="min-w-0 flex-1">
          <h1 class="break-words font-display text-2xl font-bold tracking-tight text-foreground">
            {{ member.name }}
          </h1>
          <p class="mt-0.5 text-[15px] text-text-muted">{{ member.title }}</p>
          <div class="mt-2 flex flex-wrap items-center gap-3 text-sm text-text-muted">
            <span v-if="member.email" class="inline-flex items-center gap-1"
              ><Mail :size="13" />{{ member.email }}</span
            >
            <span v-if="member.phone" class="inline-flex items-center gap-1"
              ><Phone :size="13" />{{ member.phone }}</span
            >
          </div>
          <p v-if="member.bio" class="mt-3 max-w-xl text-sm leading-relaxed text-text-muted">
            {{ member.bio }}
          </p>
          <div v-if="member.skills?.length" class="mt-3 flex flex-wrap gap-1.5">
            <span
              v-for="skill in member.skills"
              :key="skill"
              class="rounded-lg bg-secondary px-2.5 py-1 text-xs font-medium text-foreground"
              >{{ skill }}</span
            >
          </div>
        </div>
      </header>

      <form
        v-if="editing && isAdmin"
        class="space-y-4 rounded-xl bg-card p-5 ring-1 ring-primary/20"
        @submit.prevent="save"
      >
        <div class="flex items-center justify-between">
          <h2 class="text-[15px] font-semibold">Edit Member</h2>
          <button type="button" class="text-xs text-[var(--text-muted)]" @click="editing = false">
            Cancel
          </button>
        </div>
        <div class="grid gap-3 sm:grid-cols-2">
          <label class="studio-field">Name<input v-model="draft.name" required /></label>
          <label class="studio-field"
            >Email<input v-model="draft.email" type="email" required
          /></label>
          <label class="studio-field">Title<input v-model="draft.title" required /></label>
          <label class="studio-field">Phone<input v-model="draft.phone" /></label>
          <label class="studio-field"
            >Department<select v-model="draft.department">
              <option
                v-for="value in [
                  'LEADERSHIP',
                  'ENGINEERING',
                  'PRODUCT',
                  'QUALITY',
                  'MARKETING',
                  'DESIGN',
                ]"
                :key="value"
              >
                {{ value }}
              </option>
            </select></label
          >
          <label class="studio-field"
            >Role<select v-model="draft.role">
              <option>EMPLOYEE</option>
              <option>HR</option>
              <option>ADMIN</option>
            </select></label
          >
          <label class="studio-field"
            >Status<select v-model="draft.status">
              <option>ACTIVE</option>
              <option>ON_LEAVE</option>
              <option>INACTIVE</option>
            </select></label
          >
        </div>
        <label class="studio-field">Bio<textarea v-model="draft.bio" rows="4" /></label>
        <button class="studio-primary-button" :disabled="Boolean(actionPending)">
          <Save :size="15" />
          {{ actionPending === 'Saving member…' ? 'Saving…' : 'Save changes' }}
        </button>
      </form>

      <div v-if="canViewPersonal" class="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <article
          v-for="item in [
            {
              label: 'Open tasks',
              value: member.tasks?.filter((task) => task.columnName !== 'Done').length || 0,
              icon: Activity,
              tone: 'blue',
            },
            {
              label: 'Projects',
              value: member.projects?.length || 0,
              icon: FolderKanban,
              tone: 'violet',
            },
            {
              label: 'Leave remaining',
              value: balances.reduce((total, balance) => total + balance.remaining, 0),
              icon: CalendarDays,
              tone: 'amber',
            },
            {
              label: 'Status',
              value: pretty(member.status),
              icon: Circle,
              tone: member.status === 'ACTIVE' ? 'emerald' : 'amber',
            },
          ]"
          :key="item.label"
          class="rounded-xl bg-card px-5 py-9 ring-1 ring-foreground/10"
        >
          <div class="flex items-start justify-between gap-3">
            <div>
              <p class="text-[13px] font-medium text-text-muted">{{ item.label }}</p>
              <strong class="mt-1 block text-2xl font-bold tracking-tight text-foreground">{{
                item.value
              }}</strong>
            </div>
            <span
              class="flex size-10 shrink-0 items-center justify-center rounded-xl"
              :class="
                item.tone === 'blue'
                  ? 'bg-blue-500/10 text-blue-500'
                  : item.tone === 'violet'
                    ? 'bg-violet-500/10 text-violet-500'
                    : item.tone === 'emerald'
                      ? 'bg-emerald-500/10 text-emerald-500'
                      : 'bg-amber-500/10 text-amber-500'
              "
              ><component :is="item.icon" :size="20"
            /></span>
          </div>
        </article>
      </div>

      <section
        v-if="canViewPersonal && balances.length"
        class="rounded-xl bg-card p-5 ring-1 ring-foreground/10"
      >
        <h2 class="mb-4 text-[15px] font-semibold">Leave balances</h2>
        <div class="grid gap-4 sm:grid-cols-3">
          <article
            v-for="balance in balances"
            :key="balance.type"
            class="rounded-2xl border border-[var(--border-subtle)] p-4"
          >
            <p class="text-[10px] font-semibold uppercase tracking-wider text-[var(--text-muted)]">
              {{ balance.type }}
            </p>
            <strong class="mt-2 block text-2xl">{{ balance.remaining }}</strong>
            <p class="text-xs text-[var(--text-muted)]">
              days remaining · {{ balance.usedDays }} used
            </p>
            <progress
              class="studio-progress mt-3"
              :value="balance.usedDays"
              :max="Math.max(balance.entitledDays, 1)"
            />
          </article>
        </div>
      </section>

      <div class="grid gap-5" :class="canViewPersonal ? 'lg:grid-cols-3' : 'max-w-xl'">
        <section
          v-if="canViewPersonal"
          class="overflow-hidden rounded-xl bg-card py-4 ring-1 ring-foreground/10 lg:col-span-2"
        >
          <header class="flex items-center gap-2 px-4 pb-2">
            <span class="grid size-6 place-items-center rounded-md bg-blue-500/10 text-blue-500"
              ><FolderKanban :size="14"
            /></span>
            <h2 class="text-[15px] font-semibold">Projects ({{ member.projects?.length || 0 }})</h2>
          </header>
          <div class="divide-y divide-border-subtle px-4">
            <NuxtLink
              v-for="project in member.projects"
              :key="project.id"
              :to="`/projects/${project.id}`"
              class="-mx-4 flex items-center justify-between gap-4 px-4 py-3 transition-colors hover:bg-secondary/30"
              ><div>
                <strong class="text-sm">{{ project.name }}</strong>
                <p class="mt-1 text-xs text-text-muted">
                  {{ pretty(project.type) }} · {{ project.role }}
                </p>
              </div>
              <span
                class="text-xs font-medium"
                :class="
                  project.status === 'ACTIVE'
                    ? 'text-emerald-500'
                    : project.status === 'IN_DEVELOPMENT'
                      ? 'text-blue-500'
                      : project.status === 'ON_HOLD'
                        ? 'text-amber-500'
                        : 'text-text-muted'
                "
                >{{ pretty(project.status) }}</span
              ></NuxtLink
            >
            <DeliveryFieldState v-if="!member.projects?.length" empty="No projects assigned" />
          </div>
        </section>
        <div class="space-y-5">
          <section class="rounded-xl bg-card p-5 ring-1 ring-foreground/10">
            <dl class="space-y-4">
              <div>
                <dt class="meta-label">Department</dt>
                <dd>{{ pretty(member.department) }}</dd>
              </div>
              <div>
                <dt class="meta-label">Role</dt>
                <dd>
                  <span class="studio-status-pill" data-tone="neutral">{{
                    pretty(member.role)
                  }}</span>
                </dd>
              </div>
              <div>
                <dt class="meta-label">Start Date</dt>
                <dd>{{ date(member.startDate) }}</dd>
              </div>
              <div>
                <dt class="meta-label">Status</dt>
                <dd :class="member.status === 'ACTIVE' ? 'text-emerald-600' : 'text-amber-600'">
                  {{ pretty(member.status) }}
                </dd>
              </div>
            </dl>
          </section>
          <section
            v-if="canViewPersonal"
            class="overflow-hidden rounded-xl bg-card py-4 ring-1 ring-foreground/10"
          >
            <header class="flex items-center gap-2 px-4 pb-2">
              <span class="grid size-6 place-items-center rounded-md bg-primary/10 text-primary"
                ><CheckSquare :size="14"
              /></span>
              <h2 class="text-[15px] font-semibold">Tasks</h2>
            </header>
            <div class="divide-y divide-border-subtle px-4">
              <article
                v-for="task in member.tasks"
                :key="task.id"
                class="flex items-center gap-2 py-2.5"
              >
                <Circle
                  :size="11"
                  :class="
                    task.priority === 'URGENT'
                      ? 'text-red-500'
                      : task.priority === 'HIGH'
                        ? 'text-primary'
                        : task.priority === 'MEDIUM'
                          ? 'text-amber-500'
                          : 'text-text-muted'
                  "
                  fill="currentColor"
                />
                <div class="min-w-0">
                  <p class="truncate text-sm">{{ task.title }}</p>
                  <small class="text-[11px] text-text-muted">{{ task.columnName }}</small>
                </div>
              </article>
              <DeliveryFieldState v-if="!member.tasks?.length" empty="No tasks assigned" />
            </div>
          </section>
        </div>
      </div>

      <section
        v-if="canViewPersonal && member.leaveRequests?.length"
        class="overflow-hidden rounded-xl bg-card py-4 ring-1 ring-foreground/10"
      >
        <header class="flex items-center gap-2 border-b border-[var(--border-subtle)] p-5">
          <span class="grid size-7 place-items-center rounded-lg bg-amber-500/10 text-amber-600"
            ><CalendarDays :size="15"
          /></span>
          <h2 class="text-[15px] font-semibold">Leave History</h2>
        </header>
        <article
          v-for="leave in member.leaveRequests"
          :key="leave.id"
          class="flex flex-wrap items-center justify-between gap-4 border-b border-[var(--border-subtle)] p-5 last:border-0"
        >
          <div>
            <strong class="text-sm">{{ pretty(leave.type) }}</strong>
            <p class="mt-1 text-xs text-[var(--text-muted)]">
              {{ date(leave.startDate) }} – {{ date(leave.endDate)
              }}<template v-if="leave.reason"> · {{ leave.reason }}</template>
            </p>
          </div>
          <span
            class="studio-status-pill"
            :data-tone="
              leave.status === 'APPROVED'
                ? 'success'
                : leave.status === 'REJECTED'
                  ? 'danger'
                  : 'neutral'
            "
            >{{ pretty(leave.status) }}</span
          >
        </article>
      </section>

      <section
        v-if="canViewPersonal"
        class="overflow-hidden rounded-xl bg-card py-4 ring-1 ring-foreground/10"
      >
        <header class="flex items-center gap-2 border-b border-[var(--border-subtle)] p-5">
          <span class="grid size-7 place-items-center rounded-lg bg-violet-500/10 text-violet-600"
            ><BookOpen :size="15"
          /></span>
          <h2 class="text-[15px] font-semibold">Performance notes</h2>
        </header>
        <form
          v-if="isAdmin"
          class="flex flex-col gap-3 border-b border-[var(--border-subtle)] p-5 sm:flex-row"
          @submit.prevent="addNote"
        >
          <textarea
            v-model="note"
            rows="2"
            required
            class="min-h-20 flex-1 rounded-xl border border-[var(--border-default)] bg-[var(--surface-card)] p-3 text-sm"
            placeholder="Private performance note…"
          /><button class="studio-primary-button self-end" :disabled="Boolean(actionPending)">
            {{ actionPending === 'Adding performance note…' ? 'Adding…' : 'Add note' }}
          </button>
        </form>
        <article
          v-for="entry in notes"
          :key="String(entry.id)"
          class="border-b border-[var(--border-subtle)] p-5 last:border-0"
        >
          <strong class="text-sm">{{ entry.authorName || 'Admin' }}</strong>
          <p class="mt-2 text-sm">{{ entry.content }}</p>
          <small class="mt-2 block font-mono text-[10px] text-[var(--text-muted)]">{{
            date(String(entry.createdAt))
          }}</small>
        </article>
        <DeliveryFieldState v-if="!notes.length" empty="No performance notes are recorded." />
      </section>
    </template>

    <DeliveryFieldDialog
      :open="resetOpen"
      :title="`Reset password for ${member?.name || ''}`"
      @close="!actionPending && (resetOpen = false)"
    >
      <form class="studio-form-grid" @submit.prevent="resetPassword">
        <FirmActionFeedback
          :busy="actionPending === 'Resetting password…'"
          :busy-label="actionPending"
          :error="actionError"
          @dismiss="clearAction"
        />
        <label
          >Temporary password<input
            v-model="temporaryPassword"
            type="password"
            minlength="8"
            required
        /></label>
        <p class="text-xs text-[var(--text-muted)]">
          Use at least eight characters with uppercase, lowercase, and a number.
        </p>
        <button class="studio-primary-button" :disabled="Boolean(actionPending)">
          {{ actionPending === 'Resetting password…' ? 'Resetting…' : 'Reset password' }}
        </button>
      </form>
    </DeliveryFieldDialog>
    <DeliveryFieldDialog
      :open="layoffOpen"
      :title="`Lay off ${member?.name || ''}`"
      description="This deactivates access, sends a notice, and keeps the record for audit history."
      @close="!actionPending && (layoffOpen = false)"
    >
      <form class="studio-form-grid" @submit.prevent="layoff">
        <FirmActionFeedback
          :busy="actionPending === 'Deactivating member…'"
          :busy-label="actionPending"
          :error="actionError"
          @dismiss="clearAction"
        />
        <label>Reason<textarea v-model="layoffReason" rows="4" minlength="3" required /></label
        ><button class="studio-danger-button" :disabled="Boolean(actionPending)">
          {{ actionPending === 'Deactivating member…' ? 'Deactivating…' : 'Lay off' }}
        </button>
      </form>
    </DeliveryFieldDialog>
  </section>
</template>

<style scoped>
.member-hero {
  display: flex;
  align-items: flex-start;
  gap: 20px;
}
.member-avatar {
  display: grid;
  place-items: center;
  width: 80px;
  height: 80px;
  flex: 0 0 80px;
  overflow: hidden;
  border-radius: 999px;
  color: var(--foreground);
  background: var(--surface-sunken);
  font-size: 22px;
  font-weight: 700;
}
.member-avatar img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}
.meta-label {
  margin-bottom: 4px;
  font: 600 10px var(--font-mono);
  color: var(--text-muted);
  letter-spacing: 0.08em;
  text-transform: uppercase;
}
@media (max-width: 760px) {
  .member-hero {
    flex-wrap: wrap;
  }
  .member-hero > div:last-child {
    width: 100%;
  }
}
</style>
