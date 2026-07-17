<script setup lang="ts">
import { ArrowUpRight, Plus, RefreshCw } from 'lucide-vue-next';

const props = defineProps<{
  resource?: string;
  title: string;
  description: string;
  eyebrow?: string;
}>();

const { request } = useApi();
const loading = ref(false);
const error = ref('');
const records = ref<Record<string, unknown>[]>([]);

const columns = computed(() => {
  const priority = [
    'name',
    'title',
    'invoiceNumber',
    'email',
    'status',
    'type',
    'role',
    'department',
    'updatedAt',
  ];
  const keys = new Set(records.value.flatMap((record) => Object.keys(record)));
  return priority.filter((key) => keys.has(key)).slice(0, 5);
});

function display(value: unknown) {
  if (value == null || value === '') return '—';
  if (Array.isArray(value)) return value.join(', ');
  if (typeof value === 'object') return 'View details';
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(value)) {
    return new Intl.DateTimeFormat('en', { dateStyle: 'medium' }).format(new Date(value));
  }
  return String(value);
}

async function load() {
  if (!props.resource) return;
  loading.value = true;
  error.value = '';
  try {
    const response = await request<{ data: Record<string, unknown>[] }>(
      `/api/v1/${props.resource}`
    );
    records.value = response.data;
  } catch (caught: any) {
    error.value =
      caught?.data?.detail || caught?.data?.error || 'This module is still being moved to FastAPI.';
  } finally {
    loading.value = false;
  }
}

onMounted(load);
</script>

<template>
  <section>
    <PageHeader :eyebrow="eyebrow || 'Workspace'" :title="title" :description="description">
      <button class="button secondary" :disabled="loading" @click="load">
        <RefreshCw :size="16" :class="{ spinning: loading }" /> Refresh
      </button>
      <button class="button"><Plus :size="16" /> New {{ title.replace(/s$/, '') }}</button>
    </PageHeader>

    <div v-if="error" class="notice">
      <strong>Migration in progress</strong>
      <p>{{ error }}</p>
    </div>

    <div class="table-card">
      <div class="table-toolbar">
        <div>
          <strong>{{ records.length }}</strong> records
        </div>
        <span>Served by FastAPI</span>
      </div>
      <div v-if="loading" class="empty-state">Loading {{ title.toLowerCase() }}…</div>
      <div v-else-if="!records.length" class="empty-state">
        <p>No {{ title.toLowerCase() }} found.</p>
        <small>The new API is connected and ready for data.</small>
      </div>
      <div v-else class="table-scroll">
        <table>
          <thead>
            <tr>
              <th v-for="column in columns" :key="column">
                {{ column.replace(/([A-Z])/g, ' $1') }}
              </th>
              <th />
            </tr>
          </thead>
          <tbody>
            <tr v-for="record in records" :key="String(record.id)">
              <td v-for="column in columns" :key="column">
                <span v-if="column === 'status' || column === 'role'" class="badge">{{
                  display(record[column])
                }}</span>
                <template v-else>{{ display(record[column]) }}</template>
              </td>
              <td>
                <NuxtLink
                  :to="`/${resource}/${record.id}`"
                  class="row-link"
                  aria-label="Open record"
                  ><ArrowUpRight :size="16"
                /></NuxtLink>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  </section>
</template>
