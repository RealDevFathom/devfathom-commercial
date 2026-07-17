<script setup lang="ts">
const route = useRoute();
const parts = computed(
  () =>
    (Array.isArray(route.params.slug) ? route.params.slug : [route.params.slug]).filter(
      Boolean
    ) as string[]
);
const root = computed(() => parts.value[0] || 'dashboard');

const modules: Record<
  string,
  { title: string; description: string; resource?: string; eyebrow?: string }
> = {
  projects: {
    title: 'Projects',
    description: 'Delivery portfolios, milestones, boards, and project health.',
    resource: 'projects',
  },
  clients: {
    title: 'Clients',
    description: 'Relationships, contacts, engagements, and commercial context.',
    resource: 'clients',
  },
  meetings: {
    title: 'Meetings',
    description: 'Upcoming conversations, recurring sessions, and attendance.',
    resource: 'meetings',
  },
  finance: {
    title: 'Finance',
    description: 'Invoices, transactions, and the financial position of the firm.',
    resource: 'invoices',
    eyebrow: 'Firm',
  },
  team: {
    title: 'Team',
    description: 'The people, roles, skills, and capacity behind the work.',
    resource: 'team',
    eyebrow: 'Firm',
  },
  notes: {
    title: 'Notes',
    description: 'Shared thinking, decisions, and durable project knowledge.',
    resource: 'notes',
  },
  chat: {
    title: 'Chat',
    description: 'Real-time company and project conversations.',
    resource: 'channels',
  },
  reviews: {
    title: 'Reviews',
    description: 'Performance cycles, feedback, and development conversations.',
    resource: 'reviews',
    eyebrow: 'Firm',
  },
  hr: {
    title: 'People operations',
    description: 'Leave, attendance, balances, and employee operations.',
    resource: 'leave-requests',
    eyebrow: 'Firm',
  },
  'audit-logs': {
    title: 'Audit log',
    description: 'A traceable record of security and business operations.',
    resource: 'audit-logs',
    eyebrow: 'Governance',
  },
  settings: {
    title: 'Settings',
    description: 'Workspace preferences, security, integrations, and API access.',
    eyebrow: 'System',
  },
  'api-docs': {
    title: 'API reference',
    description: 'Interactive FastAPI documentation is available at the API service.',
    eyebrow: 'Developers',
  },
};

const definition = computed(
  () =>
    modules[root.value] || {
      title: root.value.replace(/-/g, ' '),
      description: 'This route is being migrated to Nuxt.',
    }
);
const title = computed(() =>
  parts.value.length > 1 && parts.value[1] !== 'stats'
    ? `${definition.value.title} detail`
    : definition.value.title
);
useHead(() => ({ title: `${title.value} · DevFathom Hub` }));
</script>

<template>
  <ResourcePage
    :key="route.fullPath"
    :title="title"
    :description="definition.description"
    :resource="parts.length === 1 ? definition.resource : undefined"
    :eyebrow="definition.eyebrow"
  />
</template>
