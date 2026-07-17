<script setup lang="ts">
import {
  Activity,
  AlertTriangle,
  ArrowRight,
  Bot,
  Clock,
  Download,
  Filter,
  RefreshCw,
  Search,
  ShieldAlert,
  Sparkles,
  UserRound,
  X,
} from 'lucide-vue-next';
import type { AuditLog } from '~/types/firm';

type AuditChange = { before?: unknown; after?: unknown };
type AuditEvidence = AuditLog & {
  actorId?: string | null;
  actorEmail?: string | null;
  actorRole?: string | null;
  tokenId?: string | null;
  tokenName?: string | null;
  targetType?: string | null;
  targetId?: string | null;
  userAgent?: string | null;
  httpMethod?: string | null;
  path?: string | null;
  statusCode?: number | null;
  durationMs?: number | null;
  errorCode?: string | null;
  errorMessage?: string | null;
  input?: unknown;
  result?: unknown;
  changes?: Record<string, AuditChange> | null;
  metadata?: unknown;
};

useHead({ title: 'Audit logs · DevFathom Hub' });

const api = useFirm();
const { user } = useAuth();
const allowed = computed(() => user.value?.role === 'ADMIN');
const logs = ref<AuditEvidence[]>([]);
const stats = ref<Record<string, any>>({});
const filters = ref<Record<string, any>>({});
const loading = ref(true);
const error = ref('');
const selected = ref<AuditEvidence | null>(null);
const nextCursor = ref<string | null>(null);
const loadingMore = ref(false);
const query = reactive({
  search: '',
  category: '',
  operation: '',
  source: '',
  outcome: '',
  actor_id: '',
  start_date: '',
  end_date: '',
  assistant_only: false,
});

const requestQuery = (cursor?: string | null) => {
  const { start_date, end_date, ...rest } = query;
  return {
    ...Object.fromEntries(
      Object.entries(rest).filter(([, value]) => value !== '' && value !== false)
    ),
    ...(start_date ? { start_date: `${start_date}T00:00:00` } : {}),
    ...(end_date ? { end_date: `${end_date}T23:59:59.999` } : {}),
    limit: 50,
    ...(cursor ? { cursor } : {}),
  };
};

async function load() {
  if (!allowed.value) {
    loading.value = false;
    return;
  }
  loading.value = true;
  error.value = '';
  try {
    const [logResult, statsResult, filterResult] = await Promise.all([
      api.auditLogs(requestQuery()),
      api.auditStats(),
      api.auditFilters(),
    ]);
    logs.value = logResult.items;
    nextCursor.value = logResult.nextCursor || null;
    stats.value = statsResult;
    filters.value = filterResult;
  } catch (caught: any) {
    error.value = caught?.data?.detail || 'Audit records are unavailable.';
  } finally {
    loading.value = false;
  }
}

async function loadMore() {
  if (!nextCursor.value || loadingMore.value) return;
  loadingMore.value = true;
  try {
    const result = await api.auditLogs(requestQuery(nextCursor.value));
    logs.value.push(...result.items);
    nextCursor.value = result.nextCursor || null;
  } finally {
    loadingMore.value = false;
  }
}

function clearFilters() {
  Object.assign(query, {
    search: '',
    category: '',
    operation: '',
    source: '',
    outcome: '',
    actor_id: '',
    start_date: '',
    end_date: '',
    assistant_only: false,
  });
}

const hasActiveFilters = computed(() =>
  Object.values(query).some((value) => value !== '' && value !== false)
);

function exportLogs() {
  const escape = (value: unknown) => `"${String(value ?? '').replaceAll('"', '""')}"`;
  const rows = logs.value.map((entry) => [
    new Date(entry.createdAt).toISOString(),
    entry.actorName || '',
    entry.action,
    entry.operation,
    entry.category,
    entry.targetLabel || '',
    entry.outcome,
  ]);
  const csv = [['Time', 'Actor', 'Action', 'Operation', 'Category', 'Target', 'Outcome'], ...rows]
    .map((row) => row.map(escape).join(','))
    .join('\r\n');
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = `audit-log-${new Date().toISOString().slice(0, 10)}.csv`;
  link.click();
  URL.revokeObjectURL(url);
}

await load();
let timer: ReturnType<typeof setTimeout>;
watch(
  query,
  () => {
    clearTimeout(timer);
    timer = setTimeout(load, 250);
  },
  { deep: true }
);

const date = (value: string) =>
  new Intl.DateTimeFormat('en', { dateStyle: 'medium', timeStyle: 'short' }).format(
    new Date(value)
  );
const relativeDate = (value: string) => {
  const seconds = Math.max(0, Math.floor((Date.now() - new Date(value).getTime()) / 1000));
  if (seconds < 60) return 'less than a minute ago';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? '' : 's'} ago`;
};
const operationTone = (operation: string) => {
  if (operation === 'CREATE') return 'bg-emerald-500/10 text-emerald-500';
  if (operation === 'UPDATE') return 'bg-blue-500/10 text-blue-500';
  if (operation === 'DELETE') return 'bg-red-500/10 text-red-500';
  if (operation === 'AUTH') return 'bg-violet-500/10 text-violet-500';
  if (operation === 'EXPORT') return 'bg-amber-500/10 text-amber-500';
  return 'bg-secondary text-text-muted';
};
const sourceTone = (source: string) => {
  if (source === 'REST_API') return 'bg-sky-500/10 text-sky-500';
  if (source === 'AUTH') return 'bg-violet-500/10 text-violet-500';
  return 'bg-secondary text-text-muted';
};
const isAssistantEntry = (entry: AuditEvidence) => {
  if (entry.action.startsWith('assistant.')) return true;
  return (
    !!entry.metadata &&
    typeof entry.metadata === 'object' &&
    !Array.isArray(entry.metadata) &&
    (entry.metadata as Record<string, unknown>).via === 'assistant'
  );
};
const hasEvidence = (value: unknown) => {
  if (value === null || value === undefined) return false;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'object') return Object.keys(value).length > 0;
  return String(value).length > 0;
};
const formatEvidence = (value: unknown) => {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
};
const changeEntries = computed(() =>
  selected.value?.changes && typeof selected.value.changes === 'object'
    ? Object.entries(selected.value.changes)
    : []
);
</script>

<template>
  <section class="studio-fade-in space-y-6">
    <PageHeader
      class="!mb-0"
      eyebrow="System"
      title="Audit Log"
      description="Every action across the workspace — who did what, when, and from where."
    >
      <div class="flex flex-wrap items-center gap-2">
        <button class="studio-outline-button" :disabled="!logs.length" @click="exportLogs">
          <Download :size="15" /> Export
        </button>
        <button class="studio-outline-button" @click="load">
          <RefreshCw :size="15" /> Refresh
        </button>
      </div>
    </PageHeader>

    <DeliveryFieldState v-if="!allowed" error="Audit logs are limited to administrators." />
    <template v-else>
      <div class="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <article
          v-for="item in [
            { label: 'Total events', value: stats.total || 0, icon: Activity, tone: 'blue' },
            { label: 'Last 24h', value: stats.last24h || 0, icon: Clock, tone: 'violet' },
            {
              label: 'Failures · 24h',
              value: stats.failures24h || 0,
              icon: AlertTriangle,
              tone: stats.failures24h ? 'amber' : 'emerald',
            },
            {
              label: 'Failures · all time',
              value: stats.failures || 0,
              icon: ShieldAlert,
              tone: stats.failures ? 'red' : 'emerald',
            },
          ]"
          :key="item.label"
          class="studio-kpi-card bg-card px-5 py-7"
        >
          <div class="flex items-center gap-2">
            <span
              class="flex size-7 shrink-0 items-center justify-center rounded-md"
              :class="{
                'bg-blue-500/10 text-blue-500': item.tone === 'blue',
                'bg-violet-500/10 text-violet-500': item.tone === 'violet',
                'bg-amber-500/10 text-amber-500': item.tone === 'amber',
                'bg-red-500/10 text-red-500': item.tone === 'red',
                'bg-emerald-500/10 text-emerald-500': item.tone === 'emerald',
              }"
              ><component :is="item.icon" :size="14"
            /></span>
            <p class="text-[11px] font-medium uppercase tracking-wider text-text-muted">
              {{ item.label }}
            </p>
          </div>
          <strong
            class="mt-2 block text-3xl font-bold tabular-nums"
            :class="{
              'text-blue-500': item.tone === 'blue',
              'text-violet-500': item.tone === 'violet',
              'text-amber-500': item.tone === 'amber',
              'text-red-500': item.tone === 'red',
              'text-emerald-500': item.tone === 'emerald',
            }"
            >{{ item.value }}</strong
          >
        </article>
      </div>

      <form class="audit-filter-shell studio-section-card" @submit.prevent="load">
        <div class="flex items-center gap-2">
          <label class="studio-audit-search flex-1"
            ><Search :size="16" /><input
              v-model="query.search"
              placeholder="Search actor, action, target, IP, error…"
              aria-label="Search audit logs"
          /></label>
          <button
            v-if="hasActiveFilters"
            type="button"
            class="studio-outline-button"
            @click="clearFilters"
          >
            <X :size="14" /> Clear
          </button>
        </div>
        <div class="flex flex-wrap items-center gap-2">
          <Filter :size="15" class="text-text-muted" />
          <select v-model="query.category" class="audit-filter-control" aria-label="Category">
            <option value="">All categories</option>
            <option v-for="item in filters.categories" :key="item">{{ item }}</option>
          </select>
          <select v-model="query.operation" class="audit-filter-control" aria-label="Operation">
            <option value="">All operations</option>
            <option v-for="item in filters.operations" :key="item">{{ item }}</option>
          </select>
          <select v-model="query.source" class="audit-filter-control" aria-label="Source">
            <option value="">All sources</option>
            <option v-for="item in filters.sources" :key="item">{{ item }}</option>
          </select>
          <select v-model="query.outcome" class="audit-filter-control" aria-label="Outcome">
            <option value="">Any outcome</option>
            <option v-for="item in filters.outcomes" :key="item">{{ item }}</option>
          </select>
          <select v-model="query.actor_id" class="audit-filter-control" aria-label="Actor">
            <option value="">All actors</option>
            <option v-for="actor in filters.actors" :key="actor.id" :value="actor.id">
              {{ actor.name || actor.id }} ({{ actor.count }})
            </option>
          </select>
          <input
            v-model="query.start_date"
            class="audit-filter-control"
            type="date"
            aria-label="From date"
          />
          <span class="text-xs text-text-muted">→</span>
          <input
            v-model="query.end_date"
            class="audit-filter-control"
            type="date"
            aria-label="To date"
          />
          <button
            type="button"
            class="studio-outline-button"
            :class="{
              '!border-violet-500/40 !bg-violet-500/10 !text-violet-600': query.assistant_only,
            }"
            :aria-pressed="query.assistant_only"
            @click="query.assistant_only = !query.assistant_only"
          >
            <Sparkles :size="14" /> Assistant actions
          </button>
        </div>
      </form>

      <DeliveryFieldState
        v-if="loading || error"
        :loading="loading"
        :error="error"
        action="Try again"
        @action="load"
      />
      <section v-else class="studio-section-card overflow-hidden py-4">
        <div class="divide-y divide-border-subtle">
          <button
            v-for="entry in logs"
            :key="entry.id"
            class="flex w-full items-center gap-4 px-4 py-3 text-left transition-colors hover:bg-secondary/40"
            @click="selected = entry"
          >
            <span
              class="flex size-8 shrink-0 items-center justify-center rounded-full"
              :class="
                entry.actorType === 'API_TOKEN'
                  ? 'bg-violet-500/10 text-violet-500'
                  : entry.actorType === 'ANONYMOUS'
                    ? 'bg-amber-500/10 text-amber-500'
                    : 'bg-blue-500/10 text-blue-500'
              "
            >
              <Bot v-if="entry.actorType === 'API_TOKEN'" :size="16" />
              <ShieldAlert v-else-if="entry.actorType === 'ANONYMOUS'" :size="16" />
              <UserRound v-else :size="16" />
            </span>
            <span class="flex min-w-0 flex-1 items-center gap-2.5">
              <span class="min-w-0">
                <strong class="block truncate text-sm font-medium text-foreground">{{
                  entry.actorName || 'Anonymous'
                }}</strong>
                <small class="block truncate text-xs text-text-muted"
                  ><span class="font-mono">{{ entry.action }}</span
                  >{{ entry.targetLabel ? ` · ${entry.targetLabel}` : '' }}</small
                >
              </span>
            </span>
            <span class="hidden shrink-0 items-center gap-1.5 sm:flex">
              <em
                v-if="isAssistantEntry(entry)"
                class="inline-flex items-center gap-1 rounded-full bg-violet-500/10 px-2 py-0.5 text-[11px] font-medium not-italic text-violet-500"
                ><Sparkles :size="10" />Assistant</em
              >
              <em
                class="rounded-full px-2 py-0.5 text-[11px] font-medium not-italic"
                :class="operationTone(entry.operation)"
                >{{ entry.operation }}</em
              >
              <em
                class="rounded-full bg-secondary px-2 py-0.5 text-[11px] font-medium not-italic text-text-muted"
                >{{ entry.category }}</em
              >
              <em
                class="rounded-full px-2 py-0.5 text-[11px] font-medium not-italic"
                :class="sourceTone(entry.source)"
                >{{ entry.source }}</em
              >
            </span>
            <span
              class="shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium"
              :class="
                entry.outcome === 'SUCCESS'
                  ? 'bg-emerald-500/10 text-emerald-500'
                  : 'bg-red-500/10 text-red-500'
              "
              >{{ entry.outcome === 'SUCCESS' ? 'OK' : 'FAIL' }}</span
            >
            <time class="hidden w-28 shrink-0 text-right md:block" :title="date(entry.createdAt)">
              <span class="block text-xs text-foreground">{{ relativeDate(entry.createdAt) }}</span>
              <span class="block text-[10px] text-text-muted">{{
                new Date(entry.createdAt).toLocaleString('en', {
                  month: 'short',
                  day: 'numeric',
                  hour: '2-digit',
                  minute: '2-digit',
                })
              }}</span>
            </time>
          </button>
          <DeliveryFieldState v-if="!logs.length" empty="No audit entries match these filters." />
        </div>
      </section>
      <div v-if="nextCursor" class="flex justify-center">
        <button class="studio-outline-button" :disabled="loadingMore" @click="loadMore">
          {{ loadingMore ? 'Loading…' : 'Load more' }}
        </button>
      </div>
    </template>

    <ClientOnly>
      <Teleport to="body">
        <div v-if="selected" class="fixed inset-0 z-[80]">
          <button
            class="absolute inset-0 bg-black/30 backdrop-blur-[1px]"
            aria-label="Close audit details"
            @click="selected = null"
          />
          <aside
            class="absolute inset-y-0 right-0 w-full overflow-y-auto border-l border-border bg-card shadow-2xl sm:max-w-xl"
            role="dialog"
            aria-modal="true"
            aria-label="Audit evidence"
          >
            <header class="sticky top-0 z-10 border-b border-border-subtle bg-card px-5 py-5">
              <div class="flex items-start justify-between gap-4">
                <div>
                  <div class="flex flex-wrap items-center gap-2">
                    <h2 class="font-mono text-sm font-semibold text-foreground">
                      {{ selected.action }}
                    </h2>
                    <span
                      v-if="isAssistantEntry(selected)"
                      class="inline-flex items-center gap-1 rounded-full bg-violet-500/10 px-2 py-0.5 text-[11px] font-medium text-violet-600"
                      ><Sparkles :size="10" />Assistant</span
                    >
                    <span
                      class="rounded-full px-2 py-0.5 text-[11px] font-medium"
                      :class="operationTone(selected.operation)"
                      >{{ selected.operation }}</span
                    >
                  </div>
                  <p class="mt-2 text-xs text-text-muted">
                    {{ date(selected.createdAt) }} ·
                    {{ selected.outcome === 'SUCCESS' ? 'Succeeded' : 'Failed' }}
                  </p>
                </div>
                <button
                  class="grid size-8 place-items-center rounded-lg text-text-muted hover:bg-secondary hover:text-foreground"
                  aria-label="Close audit evidence"
                  @click="selected = null"
                >
                  <X :size="16" />
                </button>
              </div>
            </header>
            <div class="space-y-5 px-5 py-6">
              <section
                v-if="selected.outcome === 'FAILURE' && selected.errorMessage"
                class="rounded-2xl border border-red-500/20 bg-red-500/5 p-4"
              >
                <p class="text-sm font-semibold text-red-600">
                  {{ selected.errorCode ? `${selected.errorCode}: ` : ''
                  }}{{ selected.errorMessage }}
                </p>
              </section>

              <section class="evidence-section">
                <h3>Who</h3>
                <dl class="evidence-grid">
                  <div>
                    <dt>Actor</dt>
                    <dd>{{ selected.actorName || '—' }}</dd>
                  </div>
                  <div>
                    <dt>Email</dt>
                    <dd class="mono-evidence">{{ selected.actorEmail || '—' }}</dd>
                  </div>
                  <div>
                    <dt>Role</dt>
                    <dd>{{ selected.actorRole || '—' }}</dd>
                  </div>
                  <div>
                    <dt>Actor type</dt>
                    <dd>{{ selected.actorType }}</dd>
                  </div>
                  <div>
                    <dt>Actor ID</dt>
                    <dd class="mono-evidence">{{ selected.actorId || '—' }}</dd>
                  </div>
                  <div v-if="selected.tokenName">
                    <dt>API token</dt>
                    <dd>{{ selected.tokenName }}</dd>
                  </div>
                  <div v-if="selected.tokenId">
                    <dt>Token ID</dt>
                    <dd class="mono-evidence">{{ selected.tokenId }}</dd>
                  </div>
                </dl>
              </section>

              <section class="evidence-section">
                <h3>What</h3>
                <dl class="evidence-grid">
                  <div>
                    <dt>Action</dt>
                    <dd class="mono-evidence">{{ selected.action }}</dd>
                  </div>
                  <div>
                    <dt>Category</dt>
                    <dd>{{ selected.category }}</dd>
                  </div>
                  <div>
                    <dt>Operation</dt>
                    <dd>{{ selected.operation }}</dd>
                  </div>
                  <div>
                    <dt>Source</dt>
                    <dd>{{ selected.source }}</dd>
                  </div>
                  <div class="sm:col-span-2">
                    <dt>Description</dt>
                    <dd>{{ selected.description || 'No description recorded.' }}</dd>
                  </div>
                </dl>
              </section>

              <section
                v-if="selected.targetType || selected.targetId || selected.targetLabel"
                class="evidence-section"
              >
                <h3>Target</h3>
                <dl class="evidence-grid">
                  <div v-if="selected.targetLabel">
                    <dt>Label</dt>
                    <dd>{{ selected.targetLabel }}</dd>
                  </div>
                  <div v-if="selected.targetType">
                    <dt>Type</dt>
                    <dd>{{ selected.targetType }}</dd>
                  </div>
                  <div v-if="selected.targetId">
                    <dt>ID</dt>
                    <dd class="mono-evidence">{{ selected.targetId }}</dd>
                  </div>
                </dl>
              </section>

              <section v-if="changeEntries.length" class="evidence-section">
                <h3>Changes</h3>
                <div class="space-y-2">
                  <article
                    v-for="[field, change] in changeEntries"
                    :key="field"
                    class="rounded-xl border border-border-subtle bg-[var(--surface-sunken)] p-3"
                  >
                    <p class="mb-2 font-mono text-[11px] font-semibold">{{ field }}</p>
                    <div class="flex flex-wrap items-center gap-2 text-xs">
                      <code class="change-before">{{ formatEvidence(change.before) }}</code>
                      <ArrowRight :size="13" class="shrink-0 text-text-faint" />
                      <code class="change-after">{{ formatEvidence(change.after) }}</code>
                    </div>
                  </article>
                </div>
              </section>

              <section class="evidence-section">
                <h3>Context</h3>
                <dl class="evidence-grid">
                  <div>
                    <dt>IP address</dt>
                    <dd class="mono-evidence">{{ selected.ip || '—' }}</dd>
                  </div>
                  <div>
                    <dt>User agent</dt>
                    <dd>{{ selected.userAgent || '—' }}</dd>
                  </div>
                  <div v-if="selected.httpMethod">
                    <dt>HTTP method</dt>
                    <dd>{{ selected.httpMethod }}</dd>
                  </div>
                  <div v-if="selected.path">
                    <dt>Path</dt>
                    <dd class="mono-evidence">{{ selected.path }}</dd>
                  </div>
                  <div v-if="typeof selected.statusCode === 'number'">
                    <dt>Status code</dt>
                    <dd>{{ selected.statusCode }}</dd>
                  </div>
                  <div v-if="typeof selected.durationMs === 'number'">
                    <dt>Duration</dt>
                    <dd>{{ selected.durationMs }}ms</dd>
                  </div>
                </dl>
              </section>

              <section v-if="hasEvidence(selected.input)" class="evidence-section">
                <h3>Input</h3>
                <pre class="json-evidence">{{ JSON.stringify(selected.input, null, 2) }}</pre>
              </section>
              <section v-if="hasEvidence(selected.result)" class="evidence-section">
                <h3>Result</h3>
                <pre class="json-evidence">{{ JSON.stringify(selected.result, null, 2) }}</pre>
              </section>
              <section v-if="hasEvidence(selected.metadata)" class="evidence-section">
                <h3>Metadata</h3>
                <pre class="json-evidence">{{ JSON.stringify(selected.metadata, null, 2) }}</pre>
              </section>

              <details class="rounded-2xl border border-border-subtle p-4">
                <summary class="cursor-pointer text-xs font-semibold text-text-muted">
                  Raw record
                </summary>
                <pre class="json-evidence mt-3">{{ JSON.stringify(selected, null, 2) }}</pre>
              </details>
            </div>
          </aside>
        </div>
      </Teleport>
    </ClientOnly>
  </section>
</template>

<style scoped>
.audit-filter-shell {
  display: grid;
  gap: 12px;
  padding: 14px;
}

.audit-filter-control {
  min-height: 40px;
  max-width: 100%;
  border: 1px solid var(--border-default);
  border-radius: 12px;
  padding: 0 10px;
  color: var(--foreground);
  background: var(--surface-card);
  font-size: 12px;
  outline: none;
}

.audit-filter-control:focus {
  border-color: var(--foreground);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--foreground) 8%, transparent);
}

.evidence-section {
  border: 1px solid var(--border-subtle);
  border-radius: 18px;
  padding: 16px;
  background: var(--surface-card);
}

.evidence-section > h3 {
  margin: 0 0 12px;
  color: var(--text-muted);
  font-family: var(--font-mono);
  font-size: 10px;
  font-weight: 600;
  letter-spacing: var(--tracking-caps);
  text-transform: uppercase;
}

.evidence-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 14px;
}

.evidence-grid dt {
  color: var(--text-muted);
  font-size: 11px;
}

.evidence-grid dd {
  margin: 4px 0 0;
  overflow-wrap: anywhere;
  color: var(--foreground);
  font-size: 13px;
}

.mono-evidence,
.json-evidence,
.change-before,
.change-after {
  font-family: var(--font-mono);
}

.json-evidence {
  max-height: 288px;
  overflow: auto;
  border-radius: 12px;
  padding: 12px;
  color: var(--foreground);
  background: var(--surface-sunken);
  font-size: 10px;
  line-height: 1.65;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.change-before,
.change-after {
  max-width: 100%;
  overflow-wrap: anywhere;
  border-radius: 7px;
  padding: 4px 7px;
}

.change-before {
  color: #b91c1c;
  background: #fef2f2;
  text-decoration: line-through;
}

.change-after {
  color: #047857;
  background: #ecfdf5;
}

@media (max-width: 640px) {
  .audit-filter-shell > div {
    align-items: stretch;
  }

  .audit-filter-control {
    min-width: calc(50% - 12px);
    flex: 1 1 140px;
  }

  .evidence-grid {
    grid-template-columns: 1fr;
  }
}
</style>
