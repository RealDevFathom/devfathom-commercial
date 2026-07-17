<script setup lang="ts">
import {
  ArrowUpRight,
  BriefcaseBusiness,
  FileText,
  FolderKanban,
  Globe,
  Loader2,
  MapPin,
  Plus,
  Search,
  Sparkles,
  X,
} from 'lucide-vue-next';
import type { Client } from '~/types/crm';

useHead({ title: 'Clients · DevFathom Hub' });
const crm = useCrm();
const { user } = useAuth();
const clients = ref<Client[]>([]);
const loading = ref(true);
const error = ref('');
const formOpen = ref(false);
const search = ref('');
const saving = ref(false);
const actionError = ref('');
const expiring = ref(0);
const sweeping = ref(false);
const form = reactive({
  name: '',
  website: '',
  industry: '',
  location: '',
  contactName: '',
  contactEmail: '',
  contactRole: '',
});

const isAdmin = computed(() => user.value?.role === 'ADMIN');
const statusConfig = {
  ACTIVE: { label: 'Active', bg: 'bg-emerald-500/10 text-emerald-600', dot: 'bg-emerald-500' },
  INACTIVE: { label: 'Inactive', bg: 'bg-muted text-text-muted', dot: 'bg-text-muted' },
  PROSPECT: { label: 'Prospect', bg: 'bg-blue-500/10 text-blue-500', dot: 'bg-blue-500' },
};

async function load() {
  loading.value = true;
  error.value = '';
  try {
    clients.value = await crm.listClients();
    expiring.value = isAdmin.value ? (await crm.expiringContracts(30).catch(() => [])).length : 0;
  } catch (caught: any) {
    error.value =
      caught?.data?.detail ||
      'The client directory is unavailable. Client REST access requires an administrator.';
  } finally {
    loading.value = false;
  }
}
await load();

async function sweepContracts() {
  sweeping.value = true;
  actionError.value = '';
  try {
    await crm.sweepExpiredContracts();
    await load();
  } catch (caught: any) {
    actionError.value = caught?.data?.detail || 'Contract statuses could not be refreshed.';
  } finally {
    sweeping.value = false;
  }
}

const filtered = computed(() => {
  const query = search.value.trim().toLowerCase();
  if (!query) return clients.value;
  return clients.value.filter((client) =>
    `${client.name} ${client.industry || ''} ${client.location || ''} ${client.contacts.map((contact) => contact.name).join(' ')}`
      .toLowerCase()
      .includes(query)
  );
});

async function createClient() {
  if (!form.name.trim()) return;
  saving.value = true;
  actionError.value = '';
  try {
    await crm.createClient({
      name: form.name.trim(),
      website: form.website || null,
      industry: form.industry || null,
      location: form.location || null,
      contacts: form.contactName.trim()
        ? [
            {
              name: form.contactName.trim(),
              email: form.contactEmail || null,
              role: form.contactRole || null,
              isPrimary: true,
            },
          ]
        : [],
    });
    Object.assign(form, {
      name: '',
      website: '',
      industry: '',
      location: '',
      contactName: '',
      contactEmail: '',
      contactRole: '',
    });
    formOpen.value = false;
    await load();
  } catch (caught: any) {
    actionError.value = caught?.data?.detail || 'The client could not be created.';
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <section class="core-route animate-fade-in space-y-6">
    <PageHeader
      eyebrow="CRM"
      title="Clients"
      :description="`${clients.length} relationships across active, prospect, and archived accounts.`"
    >
      <button
        v-if="isAdmin"
        class="studio-outline-button"
        :disabled="sweeping"
        @click="sweepContracts"
      >
        <Sparkles :size="15" />
        {{ sweeping ? 'Refreshing…' : `Refresh contracts${expiring ? ` · ${expiring}` : ''}` }}
      </button>
      <button class="studio-primary-button" @click="formOpen = true">
        <Plus :size="16" /> Add Client
      </button>
    </PageHeader>

    <p
      v-if="actionError"
      class="rounded-xl border border-red-500/20 bg-red-500/5 px-4 py-3 text-sm text-red-500"
    >
      {{ actionError }}
    </p>

    <label class="route-search relative block max-w-sm">
      <Search :size="16" class="absolute left-3 top-1/2 -translate-y-1/2 text-text-muted" />
      <input
        v-model="search"
        placeholder="Search clients…"
        class="h-10 w-full rounded-xl border border-border bg-card pl-9 pr-4 text-sm text-foreground outline-none focus:border-primary focus:ring-2 focus:ring-primary/20"
      />
    </label>

    <article v-if="formOpen" class="overflow-hidden rounded-xl bg-card py-4 ring-1 ring-primary/20">
      <form class="space-y-4 p-5" @submit.prevent="createClient">
        <div class="flex items-center justify-between">
          <h2 class="text-sm font-semibold text-foreground">New Client</h2>
          <button
            type="button"
            class="text-text-muted transition-colors hover:text-foreground"
            aria-label="Close new client form"
            @click="formOpen = false"
          >
            <X :size="16" />
          </button>
        </div>
        <div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <label class="block text-xs font-medium text-foreground"
            >Company Name *<input
              v-model="form.name"
              autofocus
              required
              placeholder="Acme Corp"
              class="mt-1 w-full rounded-xl border border-border bg-background px-3 py-2 text-sm text-foreground outline-none placeholder:text-text-muted focus:border-primary focus:ring-2 focus:ring-primary/20"
          /></label>
          <label class="block text-xs font-medium text-foreground"
            >Website<input
              v-model="form.website"
              type="url"
              placeholder="https://example.com"
              class="mt-1 w-full rounded-xl border border-border bg-background px-3 py-2 text-sm text-foreground outline-none placeholder:text-text-muted focus:border-primary focus:ring-2 focus:ring-primary/20"
          /></label>
          <label class="block text-xs font-medium text-foreground"
            >Industry<input
              v-model="form.industry"
              placeholder="Technology, Finance..."
              class="mt-1 w-full rounded-xl border border-border bg-background px-3 py-2 text-sm text-foreground outline-none placeholder:text-text-muted focus:border-primary focus:ring-2 focus:ring-primary/20"
          /></label>
          <label class="block text-xs font-medium text-foreground"
            >Location<input
              v-model="form.location"
              placeholder="United States"
              class="mt-1 w-full rounded-xl border border-border bg-background px-3 py-2 text-sm text-foreground outline-none placeholder:text-text-muted focus:border-primary focus:ring-2 focus:ring-primary/20"
          /></label>
        </div>
        <div class="border-t border-border-subtle pt-3">
          <p class="mb-2 text-xs font-medium text-text-muted">Primary Contact (optional)</p>
          <div class="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <input
              v-model="form.contactName"
              placeholder="Name"
              class="rounded-xl border border-border bg-background px-3 py-2 text-sm text-foreground outline-none placeholder:text-text-muted focus:border-primary"
            />
            <input
              v-model="form.contactEmail"
              type="email"
              placeholder="Email"
              class="rounded-xl border border-border bg-background px-3 py-2 text-sm text-foreground outline-none placeholder:text-text-muted focus:border-primary"
            />
            <input
              v-model="form.contactRole"
              placeholder="Role (CEO, CTO...)"
              class="rounded-xl border border-border bg-background px-3 py-2 text-sm text-foreground outline-none placeholder:text-text-muted focus:border-primary"
            />
          </div>
        </div>
        <p v-if="actionError" class="text-xs text-red-500">{{ actionError }}</p>
        <div class="flex justify-end gap-2">
          <button
            type="button"
            class="rounded-xl px-4 py-2 text-xs font-medium text-text-muted hover:text-foreground"
            @click="formOpen = false"
          >
            Cancel
          </button>
          <button
            class="flex items-center gap-1.5 rounded-xl bg-primary px-4 py-2 text-xs font-semibold text-white transition-colors hover:brightness-90 disabled:opacity-40"
            :disabled="!form.name.trim() || saving"
          >
            <Loader2 v-if="saving" :size="14" class="animate-spin" />{{
              saving ? 'Creating...' : 'Create Client'
            }}
          </button>
        </div>
      </form>
    </article>

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
      <BriefcaseBusiness :size="48" class="text-text-faint/20" />
      <h2 class="mt-4 text-lg font-semibold text-foreground">
        {{ search ? 'No clients found' : 'No clients yet' }}
      </h2>
      <p class="mt-1 text-sm text-text-muted">
        {{ search ? 'Try a different search' : 'Add your first client to get started' }}
      </p>
    </div>

    <div v-else class="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
      <NuxtLink
        v-for="client in filtered"
        :key="client.id"
        :to="`/clients/${client.id}`"
        class="client-card group h-full overflow-hidden bg-card transition-all hover:-translate-y-0.5 hover:shadow-lg"
      >
        <div class="p-6">
          <div class="mb-3 flex items-start justify-between gap-3">
            <div class="min-w-0">
              <h2
                class="truncate text-base font-semibold text-foreground group-hover:text-accent-brand"
              >
                {{ client.name }}
              </h2>
              <p v-if="client.industry" class="mt-0.5 text-xs text-text-muted">
                {{ client.industry }}
              </p>
            </div>
            <span
              class="inline-flex shrink-0 items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-medium"
              :class="statusConfig[client.status].bg"
              ><i class="h-1.5 w-1.5 rounded-full" :class="statusConfig[client.status].dot" />{{
                statusConfig[client.status].label
              }}</span
            >
          </div>
          <div class="mb-4 space-y-1.5">
            <p v-if="client.contacts[0]" class="truncate text-sm text-text-muted">
              {{ client.contacts[0].name
              }}{{ client.contacts[0].role ? ` · ${client.contacts[0].role}` : '' }}
            </p>
            <p v-if="client.location" class="flex items-center gap-1 text-xs text-text-muted">
              <MapPin :size="12" />{{ client.location }}
            </p>
            <p
              v-if="client.website"
              class="flex items-center gap-1 truncate text-xs text-text-muted"
            >
              <Globe :size="12" />{{ client.website.replace(/^https?:\/\//, '') }}
            </p>
          </div>
          <footer class="flex items-center justify-between border-t border-border-subtle pt-3">
            <div class="flex items-center gap-4 text-xs text-text-muted">
              <span class="flex items-center gap-1"
                ><FolderKanban :size="12" />{{ client._count?.projects || 0 }}</span
              ><span v-if="isAdmin" class="flex items-center gap-1"
                ><FileText :size="12" />{{ client._count?.invoices || 0 }}</span
              ><strong v-if="isAdmin && client.totalRevenue" class="text-emerald-500"
                >${{ client.totalRevenue.toLocaleString() }}</strong
              >
            </div>
            <ArrowUpRight :size="16" class="text-text-faint group-hover:text-accent-brand" />
          </footer>
        </div>
      </NuxtLink>
    </div>
  </section>
</template>

<style scoped>
.route-search input {
  border-radius: 14px;
  background: var(--surface-card);
}
.client-card {
  position: relative;
  border: 1px solid var(--border-default);
  border-radius: 24px;
  box-shadow: var(--shadow-xs);
}
.client-card::before {
  position: absolute;
  inset: 0 auto 0 0;
  width: 4px;
  background: var(--primary);
  content: '';
}
</style>
