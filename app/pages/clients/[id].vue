<script setup lang="ts">
import {
  AlertTriangle,
  ArrowLeft,
  Calendar,
  CheckCircle2,
  Clock,
  ExternalLink,
  FileText,
  FolderKanban,
  Globe,
  Loader2,
  Mail,
  MapPin,
  Pencil,
  Phone,
  Plus,
  ReceiptText,
  Save,
  ScrollText,
  Trash2,
  User,
  X,
} from 'lucide-vue-next';
import type { NoteSummary } from '~/types/collaboration';
import type { Client, ClientContact, ClientDocument, Contract } from '~/types/crm';

type DetailTab =
  | 'overview'
  | 'projects'
  | 'invoices'
  | 'contracts'
  | 'documents'
  | 'notes'
  | 'contacts'
  | 'activity';

const route = useRoute();
const router = useRouter();
const clientId = String(route.params.id);
const crm = useCrm();
const notesApi = useNotes();
const { user } = useAuth();

const client = ref<Client | null>(null);
const activity = ref<Array<Record<string, any>>>([]);
const contractedValues = ref<Array<{ currency: string; total: number; count: number }>>([]);
const clientNotes = ref<NoteSummary[]>([]);
const documents = ref<ClientDocument[]>([]);
const loading = ref(true);
const error = ref('');
const actionError = ref('');
const saving = ref(false);
const deleting = ref(false);
const deleteConfirm = ref(false);
const editing = ref(false);
const tab = ref<DetailTab>('overview');
const projectFormOpen = ref(false);
const contactFormOpen = ref(false);
const editingContactId = ref<string | null>(null);
const contractFormOpen = ref(false);
const editingContractId = ref<string | null>(null);
const deletingContractId = ref<string | null>(null);
const documentFormOpen = ref(false);

const isAdmin = computed(() => user.value?.role === 'ADMIN');
const projects = computed(() => client.value?.projects || []);
const invoices = computed<Array<any>>(() => (client.value?.invoices || []) as Array<any>);
const contracts = computed(() => client.value?.contracts || []);
const contacts = computed(() => client.value?.contacts || []);
const primaryContact = computed(
  () => contacts.value.find((item) => item.isPrimary) || contacts.value[0]
);

const edit = reactive({
  name: '',
  website: '',
  industry: '',
  location: '',
  notes: '',
  status: 'ACTIVE' as Client['status'],
});
const contactForm = reactive({ name: '', email: '', phone: '', role: '', isPrimary: false });
const contractForm = reactive({
  title: '',
  value: '',
  currency: 'USD' as Contract['currency'],
  status: 'DRAFT' as Contract['status'],
  projectId: '',
  startDate: '',
  endDate: '',
  signedAt: '',
  fileUrl: '',
  notes: '',
});
const documentForm = reactive({ name: '', url: '', type: '', size: '' });
useHead(() => ({
  title: client.value ? `${client.value.name} · Clients · DevFathom Hub` : 'Client · DevFathom Hub',
}));

const statusConfig: Record<Client['status'], { label: string; classes: string; dot: string }> = {
  ACTIVE: { label: 'Active', classes: 'bg-emerald-500/10 text-emerald-600', dot: 'bg-emerald-500' },
  INACTIVE: { label: 'Inactive', classes: 'bg-muted text-text-muted', dot: 'bg-text-muted' },
  PROSPECT: { label: 'Prospect', classes: 'bg-blue-500/10 text-blue-500', dot: 'bg-blue-500' },
};
const invoiceStatus: Record<string, { label: string; classes: string }> = {
  DRAFT: { label: 'Draft', classes: 'bg-muted text-text-muted' },
  SENT: { label: 'Sent', classes: 'bg-blue-500/10 text-blue-500' },
  PAID: { label: 'Paid', classes: 'bg-emerald-500/10 text-emerald-500' },
  OVERDUE: { label: 'Overdue', classes: 'bg-red-500/10 text-red-500' },
  CANCELLED: { label: 'Cancelled', classes: 'bg-muted text-text-muted' },
};
const invoiceMeta = (status?: string) =>
  invoiceStatus[status || 'DRAFT'] || { label: 'Draft', classes: 'bg-muted text-text-muted' };
const contractStatus: Record<Contract['status'], { label: string; classes: string }> = {
  DRAFT: { label: 'Draft', classes: 'bg-muted text-text-muted' },
  SENT: { label: 'Sent', classes: 'bg-blue-500/10 text-blue-500' },
  SIGNED: { label: 'Signed', classes: 'bg-emerald-500/10 text-emerald-600' },
  EXPIRED: { label: 'Expired', classes: 'bg-amber-500/10 text-amber-500' },
  TERMINATED: { label: 'Terminated', classes: 'bg-red-500/10 text-red-500' },
};

async function load() {
  loading.value = true;
  error.value = '';
  try {
    const [record, events, totals, notes, files] = await Promise.all([
      crm.getClient(clientId),
      crm.activity(clientId).catch(() => []),
      crm.contractedValue(clientId).catch(() => []),
      notesApi.list({ clientId }).catch(() => []),
      isAdmin.value ? crm.listDocuments(clientId).catch(() => []) : Promise.resolve([]),
    ]);
    client.value = record;
    activity.value = events;
    contractedValues.value = totals;
    clientNotes.value = notes;
    documents.value = files;
  } catch (caught: any) {
    error.value = caught?.data?.detail || 'The client record could not be read.';
  } finally {
    loading.value = false;
  }
}
await load();

function startEdit() {
  if (!client.value) return;
  Object.assign(edit, {
    name: client.value.name,
    website: client.value.website || '',
    industry: client.value.industry || '',
    location: client.value.location || '',
    notes: client.value.notes || '',
    status: client.value.status,
  });
  editing.value = !editing.value;
}

async function saveEdit() {
  saving.value = true;
  actionError.value = '';
  try {
    await crm.updateClient(clientId, {
      name: edit.name.trim(),
      website: edit.website || null,
      industry: edit.industry || null,
      location: edit.location || null,
      notes: edit.notes || null,
      status: edit.status,
    });
    editing.value = false;
    await load();
  } catch (caught: any) {
    actionError.value = caught?.data?.detail || 'The client record could not be changed.';
  } finally {
    saving.value = false;
  }
}

async function removeClient() {
  deleting.value = true;
  actionError.value = '';
  try {
    await crm.removeClient(clientId);
    await router.push('/clients');
  } catch (caught: any) {
    actionError.value = caught?.data?.detail || 'This client could not be deleted.';
  } finally {
    deleting.value = false;
  }
}

async function createClientNote() {
  saving.value = true;
  actionError.value = '';
  try {
    const created = await notesApi.create({
      title: `Notes for ${client.value?.name || 'client'}`,
      contentJson: { type: 'doc', content: [] },
      visibility: 'PRIVATE',
      clientId,
    });
    await router.push(`/notes/${created.id}`);
  } catch (caught: any) {
    actionError.value = caught?.data?.detail || 'The client note could not be created.';
  } finally {
    saving.value = false;
  }
}

function resetContactForm(item?: ClientContact) {
  editingContactId.value = item?.id || null;
  Object.assign(contactForm, {
    name: item?.name || '',
    email: item?.email || '',
    phone: item?.phone || '',
    role: item?.role || '',
    isPrimary: item?.isPrimary || false,
  });
  contactFormOpen.value = true;
}

async function saveContact() {
  const body = {
    name: contactForm.name.trim(),
    email: contactForm.email || null,
    phone: contactForm.phone || null,
    role: contactForm.role || null,
    isPrimary: contactForm.isPrimary,
  };
  await runAction(() =>
    editingContactId.value
      ? crm.updateContact(editingContactId.value, body)
      : crm.addContact(clientId, body)
  );
  contactFormOpen.value = false;
  editingContactId.value = null;
}

function resetContractForm(item?: Contract) {
  editingContractId.value = item?.id || null;
  Object.assign(contractForm, {
    title: item?.title || '',
    value: item?.value == null ? '' : String(item.value),
    currency: item?.currency || 'USD',
    status: item?.status || 'DRAFT',
    projectId: item?.projectId || '',
    startDate: isoDate(item?.startDate),
    endDate: isoDate(item?.endDate),
    signedAt: isoDate(item?.signedAt),
    fileUrl: item?.fileUrl || '',
    notes: item?.notes || '',
  });
  contractFormOpen.value = true;
}

async function saveContract() {
  const body = {
    title: contractForm.title.trim(),
    value: contractForm.value ? Number(contractForm.value) : null,
    currency: contractForm.currency,
    status: contractForm.status,
    projectId: contractForm.projectId || null,
    startDate: toIso(contractForm.startDate),
    endDate: toIso(contractForm.endDate),
    signedAt: toIso(contractForm.signedAt),
    fileUrl: contractForm.fileUrl || null,
    notes: contractForm.notes || null,
  };
  await runAction(() =>
    editingContractId.value
      ? crm.updateContract(editingContractId.value, body)
      : crm.addContract(clientId, body)
  );
  contractFormOpen.value = false;
  editingContractId.value = null;
}

async function saveDocument() {
  if (!documentForm.name.trim() || !documentForm.url.trim()) return;
  await runAction(() =>
    crm.addDocument(clientId, {
      name: documentForm.name.trim(),
      url: documentForm.url.trim(),
      type: documentForm.type.trim() || null,
      size: documentForm.size ? Number(documentForm.size) : null,
    })
  );
  Object.assign(documentForm, { name: '', url: '', type: '', size: '' });
  documentFormOpen.value = false;
}

async function runAction(fn: () => Promise<unknown>) {
  saving.value = true;
  actionError.value = '';
  try {
    await fn();
    await load();
  } catch (caught: any) {
    actionError.value = caught?.data?.detail || 'The client record could not be changed.';
  } finally {
    saving.value = false;
  }
}

const money = (value?: number | null, currency = 'USD') =>
  value == null
    ? '—'
    : currency === 'PKR'
      ? `Rs ${Number(value).toLocaleString()}`
      : `$${Number(value).toLocaleString()}`;
const date = (value?: string | null) =>
  value
    ? new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric' }).format(
        new Date(value)
      )
    : '—';
const isoDate = (value?: string | null) =>
  value ? new Date(value).toISOString().slice(0, 10) : '';
const toIso = (value: string) => (value ? new Date(`${value}T12:00:00Z`).toISOString() : null);
const expiry = (item: Contract) => {
  if (item.status === 'EXPIRED') return { label: 'Expired', classes: 'bg-red-500/10 text-red-500' };
  if (!['SENT', 'SIGNED'].includes(item.status) || !item.endDate) return null;
  const days = Math.ceil((new Date(item.endDate).getTime() - Date.now()) / 86_400_000);
  if (days < 0) return { label: 'Expired', classes: 'bg-red-500/10 text-red-500' };
  if (days <= 30)
    return {
      label: `Expires in ${days} day${days === 1 ? '' : 's'}`,
      classes: 'bg-amber-500/10 text-amber-500',
    };
  return null;
};
const totalRevenue = computed(() =>
  invoices.value
    .filter((item) => item.status === 'PAID')
    .reduce((sum, item) => sum + Number(item.total || 0), 0)
);
const outstanding = computed(() =>
  invoices.value
    .filter((item) => ['SENT', 'OVERDUE'].includes(item.status))
    .reduce((sum, item) => sum + Number(item.total || 0), 0)
);
</script>

<template>
  <section class="core-route animate-fade-in space-y-6">
    <DeliveryFieldState
      v-if="loading || error"
      :loading="loading"
      :error="error"
      action="Try again"
      @action="load"
    />
    <template v-else-if="client">
      <div class="route-hero">
        <NuxtLink
          to="/clients"
          class="mb-4 inline-flex items-center gap-1.5 text-sm text-text-muted transition-colors hover:text-foreground"
        >
          <ArrowLeft :size="16" /> Back to Clients
        </NuxtLink>
        <header class="flex flex-col gap-5 sm:flex-row sm:items-start sm:justify-between">
          <div class="min-w-0">
            <div class="flex flex-wrap items-center gap-3">
              <h1 class="font-display text-4xl font-semibold tracking-[-0.04em] text-foreground">
                {{ client.name }}
              </h1>
              <span
                class="inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-medium"
                :class="statusConfig[client.status].classes"
                ><i class="h-1.5 w-1.5 rounded-full" :class="statusConfig[client.status].dot" />{{
                  statusConfig[client.status].label
                }}</span
              >
            </div>
            <p
              v-if="client.industry || client.location || client.website"
              class="mt-2 flex flex-wrap items-center gap-4 text-sm text-text-muted"
            >
              <span v-if="client.industry">{{ client.industry }}</span>
              <span v-if="client.location" class="inline-flex items-center gap-1"
                ><MapPin :size="12" />{{ client.location }}</span
              >
              <a
                v-if="client.website"
                :href="client.website"
                target="_blank"
                rel="noreferrer"
                class="inline-flex items-center gap-1 text-primary hover:underline"
                ><Globe :size="12" />{{ client.website.replace(/^https?:\/\//, '') }}</a
              >
            </p>
          </div>
          <div class="flex shrink-0 items-center gap-2">
            <button
              class="flex items-center gap-1.5 rounded-xl border border-border bg-card px-3.5 py-2 text-xs font-medium text-foreground transition-colors hover:bg-secondary"
              @click="startEdit"
            >
              <Pencil :size="14" /> Edit
            </button>
            <template v-if="deleteConfirm">
              <button
                class="rounded-xl bg-red-500 px-3.5 py-2 text-xs font-semibold text-white transition-colors hover:bg-red-600 disabled:opacity-50"
                :disabled="deleting"
                @click="removeClient"
              >
                {{ deleting ? 'Deleting...' : 'Confirm Delete' }}
              </button>
              <button
                class="rounded-xl px-2 py-2 text-xs text-text-muted hover:text-foreground"
                @click="deleteConfirm = false"
              >
                Cancel
              </button>
            </template>
            <button
              v-else
              class="flex items-center rounded-xl border border-border bg-card px-3.5 py-2 text-xs font-medium text-text-muted transition-colors hover:border-red-500/20 hover:bg-red-500/10 hover:text-red-500"
              aria-label="Delete client"
              @click="deleteConfirm = true"
            >
              <Trash2 :size="14" />
            </button>
          </div>
        </header>
        <p
          v-if="actionError"
          class="mt-2 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-500"
        >
          {{ actionError }}
        </p>
      </div>

      <article
        v-if="editing"
        class="overflow-hidden rounded-xl bg-card py-4 ring-1 ring-primary/20"
      >
        <form class="space-y-4 p-5" @submit.prevent="saveEdit">
          <h2 class="text-sm font-semibold text-foreground">Edit Client</h2>
          <div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <label class="field-label"
              >Name<input v-model="edit.name" class="field-input" required
            /></label>
            <label class="field-label"
              >Website<input v-model="edit.website" class="field-input" type="url"
            /></label>
            <label class="field-label"
              >Industry<input v-model="edit.industry" class="field-input"
            /></label>
            <label class="field-label"
              >Location<input v-model="edit.location" class="field-input"
            /></label>
            <label class="field-label"
              >Status<select v-model="edit.status" class="field-input">
                <option value="PROSPECT">Prospect</option>
                <option value="ACTIVE">Active</option>
                <option value="INACTIVE">Inactive</option>
              </select></label
            >
          </div>
          <label class="field-label"
            >Notes<textarea v-model="edit.notes" rows="2" class="field-input resize-none" />
          </label>
          <div class="flex justify-end gap-2">
            <button
              type="button"
              class="rounded-xl px-4 py-2 text-xs font-medium text-text-muted hover:text-foreground"
              @click="editing = false"
            >
              Cancel</button
            ><button
              class="flex items-center gap-1.5 rounded-xl bg-primary px-4 py-2 text-xs font-semibold text-white disabled:opacity-40"
              :disabled="saving"
            >
              <Loader2 v-if="saving" :size="14" class="animate-spin" /><Save
                v-else
                :size="14"
              />Save Changes
            </button>
          </div>
        </form>
      </article>

      <div class="space-y-6">
        <div class="overflow-x-auto">
          <nav
            class="inline-flex h-8 w-fit items-center justify-center rounded-lg bg-muted p-[3px] text-text-muted"
          >
            <button
              v-for="item in (isAdmin
                ? [
                    'overview',
                    'projects',
                    'invoices',
                    'contracts',
                    'documents',
                    'notes',
                    'contacts',
                    'activity',
                  ]
                : ['overview', 'projects', 'notes', 'contacts', 'activity']) as DetailTab[]"
              :key="item"
              class="relative inline-flex h-[calc(100%-1px)] items-center justify-center whitespace-nowrap rounded-md border border-transparent px-1.5 py-0.5 text-sm font-medium capitalize text-foreground/60 transition-all hover:text-foreground"
              :class="tab === item ? 'bg-background text-foreground shadow-sm' : ''"
              @click="tab = item"
            >
              {{ item }}<template v-if="item === 'projects'"> ({{ projects.length }})</template
              ><template v-else-if="item === 'invoices'"> ({{ invoices.length }})</template
              ><template v-else-if="item === 'contracts'"> ({{ contracts.length }})</template
              ><template v-else-if="item === 'documents'"> ({{ documents.length }})</template
              ><template v-else-if="item === 'contacts'"> ({{ contacts.length }})</template>
            </button>
          </nav>
        </div>

        <div v-if="tab === 'overview'" class="grid grid-cols-1 gap-5 lg:grid-cols-3">
          <article
            class="overflow-hidden rounded-xl bg-card py-4 ring-1 ring-foreground/10 lg:col-span-2"
          >
            <header class="px-4 pb-3">
              <h2 class="text-[15px] font-semibold text-foreground">Details</h2>
            </header>
            <div class="space-y-3 px-4">
              <p v-if="client.notes" class="text-sm leading-relaxed text-text-muted">
                {{ client.notes }}
              </p>
              <div class="grid grid-cols-1 gap-4 pt-2 sm:grid-cols-2">
                <div v-if="client.timezone">
                  <p class="mb-1 text-xs font-medium uppercase tracking-wider text-text-muted">
                    Timezone
                  </p>
                  <p class="flex items-center gap-1 text-sm font-medium text-foreground">
                    <Clock :size="12" />{{ client.timezone }}
                  </p>
                </div>
                <div>
                  <p class="mb-1 text-xs font-medium uppercase tracking-wider text-text-muted">
                    Projects
                  </p>
                  <p class="text-sm font-medium text-foreground">{{ projects.length }}</p>
                </div>
                <template v-if="isAdmin"
                  ><div>
                    <p class="mb-1 text-xs font-medium uppercase tracking-wider text-text-muted">
                      Total Revenue
                    </p>
                    <p class="text-sm font-bold text-emerald-500">
                      ${{ totalRevenue.toLocaleString() }}
                    </p>
                  </div>
                  <div>
                    <p class="mb-1 text-xs font-medium uppercase tracking-wider text-text-muted">
                      Outstanding
                    </p>
                    <p
                      class="text-sm font-bold"
                      :class="outstanding > 0 ? 'text-amber-500' : 'text-text-muted'"
                    >
                      ${{ outstanding.toLocaleString() }}
                    </p>
                  </div></template
                >
              </div>
            </div>
          </article>
          <article class="overflow-hidden rounded-xl bg-card py-4 ring-1 ring-foreground/10">
            <header class="px-4 pb-3">
              <h2 class="text-[15px] font-semibold text-foreground">Primary Contact</h2>
            </header>
            <div class="space-y-3 px-4">
              <template v-if="primaryContact"
                ><p class="text-base font-semibold text-foreground">{{ primaryContact.name }}</p>
                <p v-if="primaryContact.role" class="text-sm text-text-muted">
                  {{ primaryContact.role }}
                </p>
                <p
                  v-if="primaryContact.email"
                  class="flex items-center gap-1.5 text-sm text-text-muted"
                >
                  <Mail :size="14" />{{ primaryContact.email }}
                </p>
                <p
                  v-if="primaryContact.phone"
                  class="flex items-center gap-1.5 text-sm text-text-muted"
                >
                  <Phone :size="14" />{{ primaryContact.phone }}
                </p></template
              >
              <p v-else class="text-sm text-text-muted">No contacts added</p>
            </div>
          </article>
        </div>

        <section v-else-if="tab === 'projects'" class="space-y-4">
          <div class="flex justify-end">
            <button class="studio-primary-button" @click="projectFormOpen = true">
              <Plus :size="14" /> New Project
            </button>
          </div>
          <div v-if="projects.length" class="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
            <article
              v-for="item in projects"
              :key="item.id"
              class="group overflow-hidden rounded-lg border border-border-subtle bg-card py-5"
            >
              <div class="p-5">
                <div class="flex items-start justify-between gap-3">
                  <NuxtLink :to="`/projects/${item.id}`" class="min-w-0"
                    ><h3
                      class="truncate text-sm font-semibold text-foreground group-hover:text-primary"
                    >
                      {{ item.name }}
                    </h3>
                    <p class="mt-1 text-xs text-text-muted">
                      {{ item.status.replaceAll('_', ' ') }}
                    </p></NuxtLink
                  >
                </div>
              </div>
            </article>
          </div>
          <DeliveryFieldState v-else empty="No projects linked to this client." />
        </section>

        <section v-else-if="tab === 'invoices'">
          <DeliveryFieldState v-if="!invoices.length" empty="No invoices" />
          <article
            v-else
            class="overflow-hidden rounded-lg border border-border-subtle bg-card py-5"
          >
            <div class="divide-y divide-border-subtle">
              <div
                v-for="item in invoices"
                :key="item.id"
                class="flex items-center justify-between px-6 py-3.5"
              >
                <div>
                  <p class="font-mono text-sm font-semibold text-foreground">
                    {{ item.invoiceNumber }}
                  </p>
                  <p class="text-xs text-text-muted">
                    {{ item.project?.name || '—' }} · {{ date(item.dueDate) }}
                  </p>
                </div>
                <div class="flex items-center gap-4">
                  <span class="text-sm font-semibold tabular-nums text-foreground">{{
                    money(Number(item.total || 0), item.currency || 'USD')
                  }}</span
                  ><span
                    class="rounded-full px-2.5 py-1 text-[11px] font-medium"
                    :class="invoiceMeta(item.status).classes"
                    >{{ invoiceMeta(item.status).label }}</span
                  >
                </div>
              </div>
            </div>
          </article>
        </section>

        <section v-else-if="tab === 'contracts'" class="space-y-4">
          <div class="flex items-center justify-between">
            <div>
              <h2 class="text-lg font-semibold text-foreground">Contracts</h2>
              <p class="mt-1 text-sm text-text-muted">
                Agreements, terms, renewals, and signed documents.
              </p>
            </div>
            <button
              v-if="!contractFormOpen"
              class="studio-primary-button"
              @click="resetContractForm()"
            >
              <Plus :size="14" /> Add Contract
            </button>
          </div>
          <article
            v-if="contractedValues.length"
            class="overflow-hidden rounded-lg border border-border-subtle bg-card py-5"
          >
            <div class="flex flex-wrap items-center gap-x-8 gap-y-3 px-5">
              <p class="text-xs font-medium uppercase tracking-wider text-text-muted">
                Total Contracted Value
              </p>
              <div
                v-for="value in contractedValues"
                :key="value.currency"
                class="flex items-baseline gap-1.5"
              >
                <span class="text-base font-bold tabular-nums text-foreground">{{
                  money(value.total, value.currency)
                }}</span
                ><span class="text-xs text-text-muted"
                  >({{ value.count }} {{ value.currency }})</span
                >
              </div>
            </div>
          </article>
          <article
            v-if="contractFormOpen"
            class="overflow-hidden rounded-lg border border-primary/20 bg-card py-5"
          >
            <form class="space-y-4 p-5" @submit.prevent="saveContract">
              <div class="flex items-center justify-between">
                <h3 class="text-sm font-semibold text-foreground">
                  {{ editingContractId ? 'Edit Contract' : `New Contract for ${client.name}` }}
                </h3>
                <button
                  type="button"
                  class="text-text-muted hover:text-foreground"
                  @click="contractFormOpen = false"
                >
                  <X :size="16" />
                </button>
              </div>
              <label class="field-label"
                >Title *<input v-model="contractForm.title" class="field-input" required
              /></label>
              <div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <label class="field-label"
                  >Status<select v-model="contractForm.status" class="field-input">
                    <option v-for="(_, key) in contractStatus" :key="key" :value="key">
                      {{ contractStatus[key].label }}
                    </option>
                  </select></label
                ><label class="field-label"
                  >Value
                  <div class="flex gap-2">
                    <select v-model="contractForm.currency" class="field-input w-24">
                      <option>USD</option>
                      <option>PKR</option></select
                    ><input
                      v-model="contractForm.value"
                      class="field-input flex-1"
                      type="number"
                      min="0"
                    /></div></label
                ><label class="field-label"
                  >Linked Project<select v-model="contractForm.projectId" class="field-input">
                    <option value="">No project</option>
                    <option v-for="item in projects" :key="item.id" :value="item.id">
                      {{ item.name }}
                    </option>
                  </select></label
                ><label class="field-label"
                  >Start Date<input
                    v-model="contractForm.startDate"
                    class="field-input"
                    type="date" /></label
                ><label class="field-label"
                  >End Date<input
                    v-model="contractForm.endDate"
                    class="field-input"
                    type="date" /></label
                ><label class="field-label"
                  >Signed Date<input
                    v-model="contractForm.signedAt"
                    class="field-input"
                    type="date"
                /></label>
              </div>
              <label class="field-label"
                >Signed Document URL<input
                  v-model="contractForm.fileUrl"
                  class="field-input"
                  type="url" /></label
              ><label class="field-label"
                >Notes<textarea
                  v-model="contractForm.notes"
                  rows="2"
                  class="field-input resize-none"
                />
              </label>
              <div class="flex justify-end gap-2">
                <button
                  type="button"
                  class="rounded-xl px-4 py-2 text-xs text-text-muted"
                  @click="contractFormOpen = false"
                >
                  Cancel</button
                ><button class="studio-primary-button" :disabled="saving">
                  <Loader2 v-if="saving" :size="14" class="animate-spin" /><Save
                    v-else
                    :size="14"
                  />{{ editingContractId ? 'Save Changes' : 'Create Contract' }}
                </button>
              </div>
            </form>
          </article>
          <DeliveryFieldState
            v-if="!contracts.length && !contractFormOpen"
            empty="No contracts"
            action="Add First Contract"
            @action="resetContractForm()"
          />
          <article
            v-if="contracts.length"
            class="overflow-hidden rounded-lg border border-border-subtle bg-card py-5"
          >
            <div class="divide-y divide-border-subtle">
              <div v-for="item in contracts" :key="item.id" class="px-6 py-4">
                <div class="flex items-start justify-between gap-3">
                  <div class="min-w-0">
                    <div class="flex flex-wrap items-center gap-2">
                      <p class="text-sm font-semibold text-foreground">{{ item.title }}</p>
                      <select
                        :value="item.status"
                        class="cursor-pointer rounded-full border-0 px-2.5 py-1 text-[11px] font-medium"
                        :class="contractStatus[item.status].classes"
                        @change="
                          runAction(() =>
                            crm.setContractStatus(
                              item.id,
                              ($event.target as HTMLSelectElement).value as Contract['status']
                            )
                          )
                        "
                      >
                        <option v-for="(_, key) in contractStatus" :key="key" :value="key">
                          {{ contractStatus[key].label }}
                        </option></select
                      ><span
                        v-if="expiry(item)"
                        class="inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-[11px] font-medium"
                        :class="expiry(item)?.classes"
                        ><AlertTriangle :size="12" />{{ expiry(item)?.label }}</span
                      >
                    </div>
                    <div class="mt-1.5 flex flex-wrap items-center gap-4 text-xs text-text-muted">
                      <span
                        v-if="item.value != null"
                        class="font-semibold tabular-nums text-foreground"
                        >{{ money(item.value, item.currency) }}</span
                      ><NuxtLink
                        v-if="item.project"
                        :to="`/projects/${item.project.id}`"
                        class="flex items-center gap-1 text-primary hover:underline"
                        ><FolderKanban :size="12" />{{ item.project.name }}</NuxtLink
                      ><span v-if="item.startDate || item.endDate" class="flex items-center gap-1"
                        ><Calendar :size="12" />{{ date(item.startDate) }} –
                        {{ date(item.endDate) }}</span
                      ><span v-if="item.signedAt" class="flex items-center gap-1"
                        ><CheckCircle2 :size="12" class="text-emerald-500" />Signed
                        {{ date(item.signedAt) }}</span
                      ><a
                        v-if="item.fileUrl"
                        :href="item.fileUrl"
                        target="_blank"
                        class="flex items-center gap-1 text-primary hover:underline"
                        ><ExternalLink :size="12" />Document</a
                      >
                    </div>
                    <p v-if="item.notes" class="mt-2 text-xs leading-relaxed text-text-muted">
                      {{ item.notes }}
                    </p>
                  </div>
                  <div class="flex shrink-0 items-center gap-1.5">
                    <template v-if="deletingContractId === item.id"
                      ><button
                        class="rounded-lg bg-red-500 px-2.5 py-1.5 text-[11px] font-semibold text-white"
                        @click="
                          runAction(() => crm.removeContract(item.id));
                          deletingContractId = null;
                        "
                      >
                        Confirm</button
                      ><button
                        class="rounded-lg px-2 py-1.5 text-[11px] text-text-muted"
                        @click="deletingContractId = null"
                      >
                        Cancel
                      </button></template
                    ><template v-else
                      ><button
                        v-if="item.value && item.value > 0"
                        title="Generate draft invoice"
                        class="rounded-lg border border-border bg-card p-1.5 text-text-muted hover:bg-secondary hover:text-foreground"
                        @click="runAction(() => crm.generateInvoice(item.id))"
                      >
                        <ReceiptText :size="14" /></button
                      ><button
                        title="Edit"
                        class="rounded-lg border border-border bg-card p-1.5 text-text-muted hover:bg-secondary hover:text-foreground"
                        @click="resetContractForm(item)"
                      >
                        <Pencil :size="14" /></button
                      ><button
                        title="Delete"
                        class="rounded-lg border border-border bg-card p-1.5 text-text-muted hover:border-red-500/20 hover:bg-red-500/10 hover:text-red-500"
                        @click="deletingContractId = item.id"
                      >
                        <Trash2 :size="14" /></button
                    ></template>
                  </div>
                </div>
              </div>
            </div>
          </article>
        </section>

        <section v-else-if="tab === 'documents'" class="space-y-4">
          <div class="flex items-center justify-between gap-4">
            <div>
              <h2 class="text-lg font-semibold text-foreground">Client documents</h2>
              <p class="mt-1 text-sm text-text-muted">
                Agreements, references, and external source files.
              </p>
            </div>
            <button class="studio-primary-button" @click="documentFormOpen = true">
              <Plus :size="14" /> Add Document
            </button>
          </div>
          <form
            v-if="documentFormOpen"
            class="studio-section-card studio-form-grid"
            @submit.prevent="saveDocument"
          >
            <label class="field-label"
              >Name *<input v-model="documentForm.name" class="field-input" required
            /></label>
            <label class="field-label"
              >URL *<input v-model="documentForm.url" class="field-input" type="url" required
            /></label>
            <label class="field-label"
              >Type<input v-model="documentForm.type" class="field-input" placeholder="PDF"
            /></label>
            <label class="field-label"
              >Size in bytes<input
                v-model="documentForm.size"
                class="field-input"
                type="number"
                min="0"
            /></label>
            <div class="col-span-full flex justify-end gap-2">
              <button type="button" class="studio-outline-button" @click="documentFormOpen = false">
                Cancel
              </button>
              <button class="studio-primary-button" :disabled="saving">Save Document</button>
            </div>
          </form>
          <DeliveryFieldState v-if="!documents.length" empty="No client documents yet." />
          <article v-else class="studio-section-card p-0">
            <div class="divide-y divide-border-subtle">
              <div
                v-for="item in documents"
                :key="item.id"
                class="flex items-center gap-3 px-5 py-4"
              >
                <FileText :size="16" class="text-text-muted" />
                <a
                  :href="item.url"
                  target="_blank"
                  rel="noreferrer"
                  class="min-w-0 flex-1 truncate text-sm font-semibold text-foreground hover:text-primary"
                  >{{ item.name }}</a
                >
                <span class="text-xs text-text-muted">{{ item.type || 'Reference' }}</span>
                <button
                  class="studio-danger-icon"
                  :aria-label="`Delete ${item.name}`"
                  @click="runAction(() => crm.removeDocument(item.id))"
                >
                  <Trash2 :size="14" />
                </button>
              </div>
            </div>
          </article>
        </section>

        <section v-else-if="tab === 'notes'" class="space-y-4">
          <div class="flex justify-end">
            <button class="studio-primary-button" :disabled="saving" @click="createClientNote">
              <Plus :size="14" /> New Client Note
            </button>
          </div>
          <div
            v-if="clientNotes.length"
            class="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3"
          >
            <NuxtLink
              v-for="note in clientNotes"
              :key="note.id"
              :to="`/notes/${note.id}`"
              class="group overflow-hidden rounded-lg border border-border-subtle bg-card py-5"
              ><div class="p-5">
                <div class="flex items-start gap-3">
                  <FileText :size="18" class="mt-0.5 text-text-muted" />
                  <div class="min-w-0">
                    <h3
                      class="truncate text-sm font-semibold text-foreground group-hover:text-primary"
                    >
                      {{ note.title }}
                    </h3>
                    <p class="mt-1 line-clamp-2 text-xs leading-relaxed text-text-muted">
                      {{ note.contentText || 'No preview available.' }}
                    </p>
                  </div>
                </div>
              </div></NuxtLink
            >
          </div>
          <DeliveryFieldState v-else empty="No client notes yet." />
        </section>

        <section v-else-if="tab === 'contacts'" class="space-y-4">
          <div class="flex justify-end">
            <button
              v-if="!contactFormOpen"
              class="studio-primary-button"
              @click="resetContactForm()"
            >
              <Plus :size="14" /> Add Contact
            </button>
          </div>
          <article
            v-if="contactFormOpen"
            class="overflow-hidden rounded-lg border border-primary/20 bg-card py-5"
          >
            <form class="space-y-3 p-4" @submit.prevent="saveContact">
              <div class="grid grid-cols-1 gap-2 sm:grid-cols-2">
                <input
                  v-model="contactForm.name"
                  class="field-input"
                  placeholder="Name *"
                  required
                /><input v-model="contactForm.role" class="field-input" placeholder="Role" /><input
                  v-model="contactForm.email"
                  class="field-input"
                  type="email"
                  placeholder="Email"
                /><input v-model="contactForm.phone" class="field-input" placeholder="Phone" />
              </div>
              <label class="flex items-center gap-2 text-xs text-foreground"
                ><input
                  v-model="contactForm.isPrimary"
                  type="checkbox"
                  class="h-4 w-4 accent-primary"
                />Primary contact</label
              >
              <div class="flex justify-end gap-2">
                <button
                  type="button"
                  class="rounded-xl px-3 py-1.5 text-xs text-text-muted"
                  @click="contactFormOpen = false"
                >
                  Cancel</button
                ><button class="studio-primary-button" :disabled="saving">
                  <Loader2 v-if="saving" :size="14" class="animate-spin" />Save
                </button>
              </div>
            </form>
          </article>
          <DeliveryFieldState v-if="!contacts.length && !contactFormOpen" empty="No contacts yet" />
          <div v-if="contacts.length" class="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <article
              v-for="item in contacts"
              :key="item.id"
              class="group overflow-hidden rounded-lg border border-border-subtle bg-card py-5"
            >
              <div class="p-5">
                <div class="flex items-start gap-3">
                  <span
                    class="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-secondary text-xs font-semibold text-foreground"
                    >{{ item.name.slice(0, 1) }}</span
                  >
                  <div class="min-w-0 flex-1">
                    <div class="flex flex-wrap items-center gap-2">
                      <h3 class="truncate text-sm font-semibold text-foreground">
                        {{ item.name }}
                      </h3>
                      <span
                        v-if="item.isPrimary"
                        class="rounded-full bg-primary/10 px-2 py-0.5 text-[10px] font-medium text-primary"
                        >Primary</span
                      >
                    </div>
                    <p v-if="item.role" class="mt-0.5 text-xs text-text-muted">{{ item.role }}</p>
                    <p
                      v-if="item.email"
                      class="mt-2 flex items-center gap-1.5 truncate text-xs text-text-muted"
                    >
                      <Mail :size="12" />{{ item.email }}
                    </p>
                    <p
                      v-if="item.phone"
                      class="mt-1 flex items-center gap-1.5 text-xs text-text-muted"
                    >
                      <Phone :size="12" />{{ item.phone }}
                    </p>
                  </div>
                  <div class="flex gap-1 opacity-0 transition-opacity group-hover:opacity-100">
                    <button
                      title="Edit"
                      class="rounded-lg p-1.5 text-text-muted hover:bg-secondary hover:text-foreground"
                      @click="resetContactForm(item)"
                    >
                      <Pencil :size="13" /></button
                    ><button
                      title="Delete"
                      class="rounded-lg p-1.5 text-text-muted hover:bg-red-500/10 hover:text-red-500"
                      @click="runAction(() => crm.removeContact(item.id))"
                    >
                      <Trash2 :size="13" />
                    </button>
                  </div>
                </div>
              </div>
            </article>
          </div>
        </section>

        <section v-else class="space-y-4">
          <DeliveryFieldState v-if="!activity.length" empty="No activity recorded." />
          <article
            v-else
            class="overflow-hidden rounded-lg border border-border-subtle bg-card py-5"
          >
            <div class="divide-y divide-border-subtle">
              <div v-for="item in activity" :key="item.id" class="flex gap-3 px-6 py-4">
                <span class="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-primary" />
                <div>
                  <p class="text-sm font-medium text-foreground">
                    {{ item.message || item.action || 'Client record updated' }}
                  </p>
                  <p class="mt-1 text-xs text-text-muted">
                    {{ item.createdAt ? new Date(item.createdAt).toLocaleString() : '' }}
                  </p>
                </div>
              </div>
            </div>
          </article>
        </section>
      </div>
      <DeliveryProjectForm
        :open="projectFormOpen"
        :preset-client-id="clientId"
        @close="projectFormOpen = false"
        @saved="load"
      />
    </template>
  </section>
</template>

<style scoped>
.route-hero {
  border: 1px solid var(--border-default);
  border-radius: 28px;
  padding: clamp(22px, 4vw, 36px);
  background: var(--surface-card);
  box-shadow: var(--shadow-xs);
}
.field-label {
  display: grid;
  gap: 4px;
  color: var(--foreground);
  font-size: 12px;
  font-weight: 500;
}
.field-input {
  min-height: 38px;
  width: 100%;
  border: 1px solid var(--border-default);
  border-radius: 12px;
  padding: 8px 12px;
  color: var(--foreground);
  background: var(--background);
  outline: none;
}
.field-input:focus {
  border-color: var(--primary);
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--primary) 20%, transparent);
}
.studio-danger-button,
.studio-danger-icon,
.studio-ghost-button {
  min-height: 40px;
  border-radius: 12px;
  padding: 0 14px;
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
}
.studio-danger-button,
.studio-danger-icon {
  border: 1px solid #ef4444;
  color: white;
  background: #ef4444;
}
.studio-danger-icon {
  display: grid;
  width: 40px;
  place-items: center;
  padding: 0;
}
.studio-ghost-button {
  border: 0;
  color: var(--text-muted);
  background: transparent;
}
</style>
