<script setup lang="ts">
import { CheckSquare, FolderKanban, Plus, Search, Users } from 'lucide-vue-next';
import type { TeamMember } from '~/types/firm';

useHead({ title: 'Team · DevFathom Hub' });
const api = useFirm();
const { user } = useAuth();
const members = ref<TeamMember[]>([]);
const loading = ref(true);
const error = ref('');
const search = ref('');
const departmentFilter = ref('ALL');
const inviteOpen = ref(false);
const invite = reactive({
  name: '',
  email: '',
  role: 'EMPLOYEE',
  department: 'ENGINEERING',
  title: '',
  phone: '',
});
const inviteSecret = ref('');

async function load() {
  loading.value = true;
  error.value = '';
  try {
    members.value = await api.team();
  } catch (caught: any) {
    error.value = caught?.data?.detail || 'The team directory is unavailable.';
  } finally {
    loading.value = false;
  }
}
await load();

const departments = computed(() => [...new Set(members.value.map((member) => member.department))]);
const departmentTone: Record<string, string> = {
  LEADERSHIP: 'bg-primary/10 text-primary',
  ENGINEERING: 'bg-blue-500/10 text-blue-500',
  PRODUCT: 'bg-violet-500/10 text-violet-500',
  QUALITY: 'bg-amber-500/10 text-amber-500',
  MARKETING: 'bg-emerald-500/10 text-emerald-500',
  DESIGN: 'bg-pink-500/10 text-pink-500',
};
const filtered = computed(() => {
  const query = search.value.trim().toLowerCase();
  return members.value.filter((member) => {
    if (query && !`${member.name} ${member.title}`.toLowerCase().includes(query)) return false;
    return departmentFilter.value === 'ALL' || member.department === departmentFilter.value;
  });
});

function initials(name: string) {
  return name
    .split(' ')
    .map((part) => part[0])
    .join('')
    .toUpperCase()
    .slice(0, 2);
}

function relativeTime(value?: string | null) {
  if (!value) return '';
  const days = Math.max(0, Math.floor((Date.now() - new Date(value).getTime()) / 86_400_000));
  if (days === 0) return 'active today';
  if (days === 1) return '1 day ago';
  return `${days} days ago`;
}

async function submitInvite() {
  const result = await api.invite({ ...invite, skills: [] });
  inviteSecret.value = `${location.origin}${result.inviteUrl}`;
}
</script>

<template>
  <section class="animate-fade-in space-y-6">
    <div class="flex items-end justify-between gap-4">
      <div>
        <h1 class="font-display text-2xl font-bold tracking-tight text-foreground">Team</h1>
        <p class="mt-1.5 text-[15px] text-text-muted">
          {{ members.length }} team members across {{ departments.length }} departments.
        </p>
      </div>
      <button
        v-if="user?.role === 'ADMIN'"
        class="flex items-center gap-2 rounded-xl bg-primary px-4 py-2.5 text-sm font-semibold text-white transition-all hover:bg-[#0C2E2C] active:scale-[0.98]"
        @click="inviteOpen = true"
      >
        <Plus :size="16" /> Add Member
      </button>
    </div>

    <div class="flex flex-col items-start gap-3 sm:flex-row sm:items-center">
      <label class="relative w-full flex-1 sm:max-w-xs"
        ><Search
          :size="16"
          class="absolute left-3 top-1/2 -translate-y-1/2 text-text-muted" /><input
          v-model="search"
          placeholder="Search by name or role..."
          class="h-10 w-full rounded-xl border border-border bg-card pl-9 pr-4 text-sm text-foreground outline-none focus:border-primary focus:ring-2 focus:ring-primary/20"
      /></label>
      <nav class="flex flex-wrap items-center gap-1.5" aria-label="Department filters">
        <button
          class="rounded-lg px-3 py-1.5 text-xs font-medium"
          :class="
            departmentFilter === 'ALL'
              ? 'bg-foreground text-background'
              : 'text-text-muted hover:bg-secondary hover:text-foreground'
          "
          @click="departmentFilter = 'ALL'"
        >
          All</button
        ><button
          v-for="department in departments"
          :key="department"
          class="rounded-lg px-3 py-1.5 text-xs font-medium"
          :class="
            departmentFilter === department
              ? 'bg-foreground text-background'
              : 'text-text-muted hover:bg-secondary hover:text-foreground'
          "
          @click="departmentFilter = department"
        >
          {{ department.charAt(0) + department.slice(1).toLowerCase() }}
        </button>
      </nav>
    </div>

    <DeliveryFieldState
      v-if="loading || error"
      :loading="loading"
      :error="error"
      action="Try again"
      @action="load"
    />
    <div
      v-else-if="!filtered.length"
      class="flex flex-col items-center justify-center rounded-2xl border border-dashed border-border py-20"
    >
      <Users :size="48" class="text-text-faint/20" />
      <h2 class="mt-4 text-lg font-semibold text-foreground">No team members found</h2>
    </div>
    <div v-else class="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
      <NuxtLink
        v-for="member in filtered"
        :key="member.id"
        :to="`/team/${member.id}`"
        class="group h-full rounded-xl bg-card px-6 py-10 ring-1 ring-foreground/10 transition-all duration-200 hover:-translate-y-0.5 hover:shadow-lg hover:ring-foreground/20"
      >
        <div class="flex items-start gap-4">
          <div class="relative">
            <span
              class="grid h-14 w-14 place-items-center overflow-hidden rounded-full bg-secondary text-lg font-semibold text-foreground"
              ><img
                v-if="member.avatar"
                :src="member.avatar"
                :alt="member.name"
                class="h-full w-full object-cover"
              /><template v-else>{{ initials(member.name) }}</template></span
            ><i
              class="absolute -bottom-0.5 -right-0.5 h-3.5 w-3.5 rounded-full border-2 border-card"
              :class="
                member.status === 'ACTIVE'
                  ? 'bg-emerald-500'
                  : member.status === 'ON_LEAVE'
                    ? 'bg-amber-500'
                    : 'bg-text-faint'
              "
            />
          </div>
          <div class="min-w-0 flex-1">
            <h2
              class="truncate text-sm font-semibold text-foreground group-hover:text-accent-brand"
            >
              {{ member.name }}
            </h2>
            <p class="mt-0.5 truncate text-xs text-text-muted">{{ member.title }}</p>
            <div class="mt-2 flex items-center gap-2">
              <span
                class="rounded-md px-2 py-0.5 text-[10px] font-medium"
                :class="departmentTone[member.department] || 'bg-secondary text-text-muted'"
                >{{ member.department.charAt(0) + member.department.slice(1).toLowerCase() }}</span
              ><span
                v-if="member.role === 'ADMIN'"
                class="rounded-md bg-primary/10 px-2 py-0.5 text-[10px] font-medium text-primary"
                >Admin</span
              ><span
                v-if="member.role === 'HR'"
                class="rounded-md bg-indigo-500/10 px-2 py-0.5 text-[10px] font-medium text-indigo-500"
                >HR</span
              >
            </div>
          </div>
        </div>
        <footer
          class="mt-4 flex items-center justify-between border-t border-border-subtle pt-3 text-xs text-text-muted"
        >
          <div class="flex items-center gap-3">
            <span class="flex items-center gap-1"
              ><FolderKanban :size="12" />{{ member.projectCount || 0 }}</span
            ><span class="flex items-center gap-1"
              ><CheckSquare :size="12" />{{ member.taskCount || 0 }}</span
            >
          </div>
          <span v-if="member.lastActiveAt">{{ relativeTime(member.lastActiveAt) }}</span>
        </footer>
      </NuxtLink>
    </div>

    <DeliveryFieldDialog
      :open="inviteOpen"
      title="Invite team member"
      description="The invitation URL is shown once after creation."
      @close="
        inviteOpen = false;
        inviteSecret = '';
      "
    >
      <AdminOneShotSecret
        v-if="inviteSecret"
        label="Invitation link"
        :secret="inviteSecret"
        @dismiss="inviteSecret = ''"
      />
      <form v-else class="studio-form-grid" @submit.prevent="submitInvite">
        <label>Name<input v-model="invite.name" required /></label
        ><label>Email<input v-model="invite.email" type="email" required /></label>
        <div class="grid grid-cols-2 gap-3">
          <label
            >Role<select v-model="invite.role">
              <option>EMPLOYEE</option>
              <option>HR</option>
              <option>ADMIN</option>
            </select></label
          ><label
            >Department<select v-model="invite.department">
              <option>ENGINEERING</option>
              <option>PRODUCT</option>
              <option>QUALITY</option>
              <option>MARKETING</option>
              <option>DESIGN</option>
              <option>LEADERSHIP</option>
            </select></label
          >
        </div>
        <label>Title<input v-model="invite.title" required /></label
        ><label>Phone<input v-model="invite.phone" /></label
        ><button class="studio-primary-button">Create invitation</button>
      </form>
    </DeliveryFieldDialog>
  </section>
</template>
