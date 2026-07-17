<script setup lang="ts">
import {
  Activity,
  AlertTriangle,
  Bot,
  Clock,
  Download,
  Filter,
  RefreshCw,
  Search,
  ShieldAlert,
  ScrollText,
  Sparkles,
  UserRound,
  X,
} from 'lucide-vue-next';
import type { AuditLog } from '~/types/firm';

useHead({ title: 'Audit logs · DevFathom Hub' });

const api = useFirm();
const { user } = useAuth();
const allowed = computed(() => user.value?.role === 'ADMIN');
const logs = ref<AuditLog[]>([]);
const stats = ref<Record<string, any>>({});
const filters = ref<Record<string, any>>({});
const loading = ref(true);
const error = ref('');
const selected = ref<AuditLog | null>(null);
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

const requestQuery = (cursor?: string | null) => ({
  ...Object.fromEntries(
    Object.entries(query).filter(([, value]) => value !== '' && value !== false)
  ),
  limit: 50,
  ...(cursor ? { cursor } : {}),
});

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
  if (source === 'API') return 'bg-sky-500/10 text-sky-500';
  if (source === 'ASSISTANT') return 'bg-violet-500/10 text-violet-500';
  return 'bg-secondary text-text-muted';
};
</script>

<template>
  <section class="animate-fade-in space-y-6">
    <div class="flex items-end justify-between gap-4">
      <div>
        <h1
          class="flex items-center gap-2 font-display text-2xl font-bold tracking-tight text-foreground"
        >
          <ScrollText :size="24" class="text-primary" />Audit Log
        </h1>
        <p class="mt-1.5 text-[15px] text-text-muted">
          Every action across the workspace — who did what, when, and from where.
        </p>
      </div>
      <div class="flex shrink-0 items-center gap-2">
        <button
          class="flex items-center gap-1.5 rounded-lg border border-border px-3 py-2 text-xs font-medium text-text-muted transition-colors hover:bg-secondary hover:text-foreground disabled:opacity-40"
          :disabled="!logs.length"
          @click="exportLogs"
        >
          <Download :size="15" /> Export
        </button>
        <button
          class="flex items-center gap-1.5 rounded-lg border border-border px-3 py-2 text-xs font-medium text-text-muted transition-colors hover:bg-secondary hover:text-foreground"
          @click="load"
        >
          <RefreshCw :size="15" /> Refresh
        </button>
      </div>
    </div>

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
          class="rounded-xl bg-card px-5 py-9 ring-1 ring-foreground/10"
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

      <form
        class="space-y-3 rounded-xl bg-card p-4 ring-1 ring-foreground/10"
        @submit.prevent="load"
      >
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
          <select v-model="query.category" aria-label="Category">
            <option value="">All categories</option>
            <option v-for="item in filters.categories" :key="item">{{ item }}</option>
          </select>
          <select v-model="query.operation" aria-label="Operation">
            <option value="">All operations</option>
            <option v-for="item in filters.operations" :key="item">{{ item }}</option>
          </select>
          <select v-model="query.source" aria-label="Source">
            <option value="">All sources</option>
            <option v-for="item in filters.sources" :key="item">{{ item }}</option>
          </select>
          <select v-model="query.outcome" aria-label="Outcome">
            <option value="">Any outcome</option>
            <option v-for="item in filters.outcomes" :key="item">{{ item }}</option>
          </select>
          <select v-model="query.actor_id" aria-label="Actor">
            <option value="">All actors</option>
            <option v-for="actor in filters.actors" :key="actor.id" :value="actor.id">
              {{ actor.name || actor.id }} ({{ actor.count }})
            </option>
          </select>
          <input v-model="query.start_date" type="date" aria-label="From date" />
          <span class="text-xs text-text-muted">→</span>
          <input v-model="query.end_date" type="date" aria-label="To date" />
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
      <section v-else class="overflow-hidden rounded-xl bg-card py-4 ring-1 ring-foreground/10">
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
                v-if="entry.source === 'ASSISTANT'"
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
          >
            <header class="sticky top-0 z-10 border-b border-border-subtle bg-card px-5 py-5">
              <div class="flex items-start justify-between gap-4">
                <div>
                  <div class="flex flex-wrap items-center gap-2">
                    <h2 class="font-mono text-sm font-semibold text-foreground">
                      {{ selected.action }}
                    </h2>
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
                  @click="selected = null"
                >
                  <X :size="16" />
                </button>
              </div>
            </header>
            <div class="space-y-5 px-5 py-6">
              <section>
                <h3 class="mb-2 text-[11px] font-semibold uppercase tracking-wider text-text-muted">
                  Who
                </h3>
                <dl class="grid grid-cols-2 gap-3 text-sm">
                  <div>
                    <dt class="text-xs text-text-muted">Actor</dt>
                    <dd class="mt-1">{{ selected.actorName || '—' }}</dd>
                  </div>
                  <div>
                    <dt class="text-xs text-text-muted">Actor type</dt>
                    <dd class="mt-1">{{ selected.actorType }}</dd>
                  </div>
                </dl>
              </section>
              <section>
                <h3 class="mb-2 text-[11px] font-semibold uppercase tracking-wider text-text-muted">
                  What
                </h3>
                <dl class="grid grid-cols-2 gap-3 text-sm">
                  <div>
                    <dt class="text-xs text-text-muted">Category</dt>
                    <dd class="mt-1">{{ selected.category }}</dd>
                  </div>
                  <div>
                    <dt class="text-xs text-text-muted">Source</dt>
                    <dd class="mt-1">{{ selected.source }}</dd>
                  </div>
                  <div class="col-span-2">
                    <dt class="text-xs text-text-muted">Description</dt>
                    <dd class="mt-1">
                      {{
                        selected.description || selected.targetLabel || 'No description recorded.'
                      }}
                    </dd>
                  </div>
                </dl>
              </section>
              <section>
                <h3 class="mb-2 text-[11px] font-semibold uppercase tracking-wider text-text-muted">
                  Context
                </h3>
                <dl class="grid grid-cols-2 gap-3 text-sm">
                  <div>
                    <dt class="text-xs text-text-muted">IP address</dt>
                    <dd class="mt-1 font-mono text-xs">{{ selected.ip || '—' }}</dd>
                  </div>
                  <div>
                    <dt class="text-xs text-text-muted">Outcome</dt>
                    <dd class="mt-1">{{ selected.outcome }}</dd>
                  </div>
                </dl>
              </section>
              <pre
                class="max-h-72 overflow-auto rounded-lg bg-secondary/50 p-3 font-mono text-[10px] text-foreground"
                >{{ JSON.stringify(selected, null, 2) }}</pre>
            </div>
          </aside>
        </div>
      </Teleport>
    </ClientOnly>
  </section>
</template>
