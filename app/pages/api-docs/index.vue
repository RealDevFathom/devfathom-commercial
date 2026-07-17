<script setup lang="ts">
import { Code2, Copy, ExternalLink, Search } from 'lucide-vue-next';
useHead({ title: 'API docs · DevFathom Hub' });
const config = useRuntimeConfig();
const spec = ref<any>(null);
const loading = ref(true);
const error = ref('');
const query = ref('');
try {
  spec.value = await $fetch(`${config.public.apiBase}/openapi.json`);
} catch (caught: any) {
  error.value = caught?.data?.detail || 'The OpenAPI document is unavailable.';
} finally {
  loading.value = false;
}
const operations = computed(() => {
  if (!spec.value) return [];
  return Object.entries(spec.value.paths || {})
    .flatMap(([path, methods]: any) =>
      Object.entries(methods).map(([method, op]: any) => ({
        path,
        method: method.toUpperCase(),
        summary: op.summary || op.operationId || path,
        tags: op.tags || [],
        operationId: op.operationId,
      }))
    )
    .filter((op: any) =>
      `${op.path} ${op.summary} ${op.tags.join(' ')}`
        .toLowerCase()
        .includes(query.value.toLowerCase())
    );
});
async function copy(path: string) {
  await navigator.clipboard.writeText(`${config.public.apiBase}${path}`);
}
</script>
<template>
  <section>
    <PageHeader
      eyebrow="Developer reference"
      title="API documentation"
      description="Live FastAPI OpenAPI operations, grouped from the running backend contract."
      ><a
        class="button secondary"
        :href="`${config.public.apiBase}/docs`"
        target="_blank"
        rel="noopener noreferrer"
        ><ExternalLink :size="15" />Interactive docs</a
      ></PageHeader
    ><DeliveryFieldState v-if="loading || error" :loading="loading" :error="error" /><template
      v-else
      ><div class="api-head">
        <Code2 :size="18" />
        <div>
          <strong>{{ spec?.info?.title }}</strong
          ><small>OpenAPI {{ spec?.openapi }} · version {{ spec?.info?.version }}</small>
        </div>
        <label
          ><Search :size="14" /><input v-model="query" placeholder="Filter operations…"
        /></label>
      </div>
      <div class="operations">
        <article v-for="op in operations" :key="`${op.method}-${op.path}`">
          <span class="method" :data-method="op.method">{{ op.method }}</span
          ><code>{{ op.path }}</code>
          <div>
            <strong>{{ op.summary }}</strong
            ><small>{{ op.tags.join(' · ') }}</small>
          </div>
          <button :aria-label="`Copy ${op.path}`" @click="copy(op.path)">
            <Copy :size="14" />
          </button>
        </article>
        <DeliveryFieldState
          v-if="!operations.length"
          empty="No operations match this filter."
        /></div
    ></template>
  </section>
</template>
<style scoped>
.api-head {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 17px;
  color: white;
  background: var(--forest-950);
}
.api-head > div {
  flex: 1;
}
.api-head strong,
.api-head small {
  display: block;
}
.api-head small {
  margin-top: 4px;
  color: #aeb8ab;
  font-size: 9px;
}
.api-head label {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 260px;
  padding: 8px;
  background: rgba(255, 255, 255, 0.08);
}
.api-head input {
  width: 100%;
  color: white;
  background: transparent;
  border: 0;
  outline: 0;
}
.operations {
  background: var(--paper);
  border: 1px solid var(--border);
}
.operations article {
  display: grid;
  grid-template-columns: 64px minmax(210px, 0.7fr) 1fr 34px;
  gap: 12px;
  align-items: center;
  min-height: 61px;
  padding: 8px 14px;
  border-bottom: 1px solid var(--border);
}
.method {
  padding: 5px;
  color: white;
  background: var(--forest-800);
  text-align: center;
  font:
    9px 'IBM Plex Mono',
    monospace;
}
.method[data-method='POST'] {
  background: #9e6530;
}
.method[data-method='DELETE'] {
  background: var(--clay-600);
}
code {
  font-size: 10px;
  overflow-wrap: anywhere;
}
.operations strong,
.operations small {
  display: block;
}
.operations strong {
  font-size: 11px;
}
.operations small {
  margin-top: 3px;
  color: var(--muted);
  font-size: 9px;
}
.operations button {
  display: grid;
  place-items: center;
  width: 30px;
  height: 30px;
  color: var(--muted);
  background: transparent;
  border: 1px solid var(--border);
  cursor: pointer;
}
@media (max-width: 680px) {
  .api-head {
    align-items: stretch;
    flex-wrap: wrap;
  }
  .api-head label {
    width: 100%;
    min-width: 0;
  }
  .operations article {
    grid-template-columns: 56px 1fr 30px;
  }
  .operations article > div {
    grid-column: 2;
  }
}
</style>
