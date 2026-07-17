<script setup lang="ts">
import {
  Activity,
  ArrowUpRight,
  CheckCircle2,
  ChevronRight,
  Circle,
  Clock,
  DollarSign,
  FileText,
  FolderKanban,
  LoaderCircle,
  Plus,
  SlidersHorizontal,
  TrendingUp,
  Video,
  X,
} from 'lucide-vue-next';
import type { Component } from 'vue';
import type { ApiResponse, DashboardStats } from '~/types/api';
import type { Meeting } from '~/types/collaboration';
import type { Project } from '~/types/delivery';

interface ActivityItem {
  id: string;
  type: string;
  message: string;
  createdAt: string;
  userName?: string;
  avatar?: string | null;
}

interface DashboardDeadline {
  id: string;
  name: string;
  dueDate: string;
  projectId: string;
  projectName: string;
  projectStatus: string;
}

interface DashboardTask {
  id: string;
  title: string;
  priority: string;
  dueDate?: string | null;
  columnName: string;
  boardId: string;
  projectId: string;
  projectName: string;
}

interface RevenuePoint {
  month: string;
  income: number;
  expense: number;
  profit: number;
}

interface RevenueChartData {
  currencies: string[];
  byCurrency: Record<string, RevenuePoint[]>;
}

interface ChartPoint extends RevenuePoint {
  x: number;
  y: number;
}

interface TeamPerson {
  id: string;
  name: string;
}

interface KpiCard {
  title: string;
  value: string;
  change?: string;
  changeLabel?: string;
  icon: Component;
  trend?: 'up' | 'down' | 'neutral';
}

const dashboardWidgets = [
  { key: 'myTasks', label: 'My Tasks' },
  { key: 'deadlines', label: 'Upcoming Deadlines' },
  { key: 'activity', label: 'Activity' },
  { key: 'projects', label: 'Active Projects' },
] as const;

useHead({ title: 'Dashboard · DevFathom Hub' });
const { request } = useApi();
const { user } = useAuth();
const meetingApi = useMeetings();
const firmApi = useFirm();

const stats = ref<DashboardStats | null>(null);
const activity = ref<ActivityItem[]>([]);
const projects = ref<Project[]>([]);
const meetings = ref<Meeting[]>([]);
const deadlines = ref<DashboardDeadline[]>([]);
const tasks = ref<DashboardTask[]>([]);
const team = ref<TeamPerson[]>([]);
const revenueChart = ref<RevenueChartData | null>(null);
const selectedCurrency = ref('');
const activeChartIndex = ref<number | null>(null);
const hiddenWidgets = ref<string[]>([]);
const showCustomize = ref(false);
const showCreateMeeting = ref(false);
const creatingMeeting = ref(false);
const loading = ref(true);
const error = ref('');
const clock = ref(0);
const chartContainer = ref<SVGSVGElement | null>(null);
const chartWidth = ref(720);
const meetingForm = reactive({
  title: '',
  date: '',
  startTime: '',
  endTime: '',
  location: '',
  recurrence: '' as '' | 'daily' | 'weekly' | 'biweekly' | 'monthly',
  attendeeIds: [] as string[],
});
let timer: ReturnType<typeof setInterval> | undefined;
let chartResizeObserver: ResizeObserver | undefined;

async function loadDashboard() {
  loading.value = true;
  error.value = '';
  try {
    const [
      statsResponse,
      activityResponse,
      projectResponse,
      meetingResponse,
      deadlineResponse,
      taskResponse,
    ] = await Promise.all([
      request<ApiResponse<DashboardStats>>('/api/dashboard/stats'),
      request<ApiResponse<ActivityItem[]>>('/api/dashboard/activity'),
      request<ApiResponse<Project[]>>('/api/v1/projects'),
      meetingApi.upcoming(),
      request<ApiResponse<DashboardDeadline[]>>('/api/dashboard/deadlines'),
      request<ApiResponse<DashboardTask[]>>('/api/dashboard/my-tasks'),
    ]);

    stats.value = statsResponse.data;
    activity.value = activityResponse.data;
    projects.value = projectResponse.data.slice(0, 4);
    meetings.value = meetingResponse;
    deadlines.value = deadlineResponse.data;
    tasks.value = taskResponse.data;

    const [preferencesResult, teamResult] = await Promise.allSettled([
      firmApi.preferences(),
      firmApi.team(),
    ]);
    if (preferencesResult.status === 'fulfilled') {
      const hidden = preferencesResult.value.preferences.hiddenWidgets;
      hiddenWidgets.value = Array.isArray(hidden)
        ? hidden.filter((key): key is string => typeof key === 'string')
        : [];
    }
    if (teamResult.status === 'fulfilled') {
      team.value = teamResult.value.map((member) => ({ id: member.id, name: member.name }));
    }

    if (stats.value.isAdmin) {
      const chartResponse = await request<ApiResponse<RevenueChartData>>(
        '/api/dashboard/revenue-chart'
      );
      revenueChart.value = chartResponse.data;
      selectedCurrency.value = chartResponse.data.currencies[0] || '';
    }
  } catch (caught: unknown) {
    error.value =
      caught && typeof caught === 'object' && 'data' in caught
        ? ((caught as { data?: { detail?: string } }).data?.detail ??
          'Your dashboard could not be refreshed.')
        : 'Your dashboard could not be refreshed.';
  } finally {
    loading.value = false;
  }
}

onMounted(() => {
  clock.value = Date.now();
  timer = setInterval(() => (clock.value = Date.now()), 1000);
  loadDashboard();
});

watch(chartContainer, (element) => {
  chartResizeObserver?.disconnect();
  chartResizeObserver = undefined;
  if (!element) return;

  const updateWidth = () => {
    chartWidth.value = Math.max(320, Math.round(element.getBoundingClientRect().width));
  };
  updateWidth();
  chartResizeObserver = new ResizeObserver(updateWidth);
  chartResizeObserver.observe(element);
});

onBeforeUnmount(() => {
  if (timer) clearInterval(timer);
  chartResizeObserver?.disconnect();
});
watch(selectedCurrency, () => (activeChartIndex.value = null));

const greeting = computed(() => {
  const hour = new Date(clock.value || Date.now()).getHours();
  if (hour < 12) return 'Good morning';
  if (hour < 18) return 'Good afternoon';
  return 'Good evening';
});

const dateParts = computed(() => {
  const current = new Date(clock.value || Date.now());
  return {
    day: String(current.getDate()),
    weekday: new Intl.DateTimeFormat('en-US', { weekday: 'short' }).format(current),
    monthYear: new Intl.DateTimeFormat('en-US', { month: 'short', year: 'numeric' }).format(
      current
    ),
  };
});

function money(amount: number, currency: string, compact = false) {
  try {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency,
      maximumFractionDigits: 0,
      notation: compact ? 'compact' : 'standard',
    }).format(amount);
  } catch {
    return `${currency} ${Math.round(amount).toLocaleString()}`;
  }
}

function moneyList(values: DashboardStats['revenue']) {
  if (!values.length) return '$0';
  return values.map((item) => money(item.amount, item.currency, true)).join(' · ');
}

const netRevenue = computed(() => {
  if (!stats.value || !stats.value.revenue.length) return '$0';
  return stats.value.revenue
    .map((revenue) => {
      const expense =
        stats.value?.expenses.find((entry) => entry.currency === revenue.currency)?.amount || 0;
      return money(revenue.amount - expense, revenue.currency, true);
    })
    .join(' · ');
});

const cards = computed<KpiCard[]>(() => {
  if (stats.value?.isAdmin) {
    return [
      {
        title: 'Revenue This Month',
        value: moneyList(stats.value.revenue),
        change: '+12%',
        changeLabel: 'vs last month',
        icon: DollarSign,
        trend: 'up',
      },
      {
        title: 'Active Projects',
        value: String(stats.value.activeProjects),
        change: '2 new this quarter',
        icon: FolderKanban,
        trend: 'up',
      },
      {
        title: 'Tasks Completed',
        value: String(stats.value.completedTasksThisWeek),
        changeLabel: 'this week',
        icon: CheckCircle2,
        trend: 'neutral',
      },
      {
        title: 'Outstanding Invoices',
        value: String(stats.value.outstandingInvoices),
        change: `${netRevenue.value} net`,
        changeLabel: 'this month',
        icon: FileText,
        trend: 'up',
      },
    ];
  }
  return [
    {
      title: 'Active Projects',
      value: String(stats.value?.activeProjects ?? 0),
      change: '2 new this quarter',
      icon: FolderKanban,
      trend: 'up',
    },
    {
      title: 'Tasks Completed',
      value: String(stats.value?.completedTasksThisWeek ?? 0),
      changeLabel: 'this week',
      icon: CheckCircle2,
      trend: 'neutral',
    },
    {
      title: 'Pending Leaves',
      value: String(stats.value?.pendingLeaves ?? 0),
      icon: Clock,
      trend: 'neutral',
    },
  ];
});

function isHidden(key: string) {
  return hiddenWidgets.value.includes(key);
}

async function toggleWidget(key: string) {
  const previous = [...hiddenWidgets.value];
  hiddenWidgets.value = isHidden(key)
    ? hiddenWidgets.value.filter((entry) => entry !== key)
    : [...hiddenWidgets.value, key];
  try {
    await firmApi.savePreferences({ hiddenWidgets: hiddenWidgets.value });
  } catch {
    hiddenWidgets.value = previous;
  }
}

const nextMeeting = computed(() => meetings.value[0] || null);
const meetingLive = computed(() => {
  if (!nextMeeting.value || !clock.value) return false;
  return (
    clock.value >= new Date(nextMeeting.value.startTime).getTime() &&
    clock.value < new Date(nextMeeting.value.endTime).getTime()
  );
});

const countdown = computed(() => {
  if (!nextMeeting.value || !clock.value) return { hours: '00', minutes: '00', seconds: '00' };
  const target = meetingLive.value
    ? clock.value - new Date(nextMeeting.value.startTime).getTime()
    : Math.max(0, new Date(nextMeeting.value.startTime).getTime() - clock.value);
  return {
    hours: String(Math.floor(target / 3_600_000)).padStart(2, '0'),
    minutes: String(Math.floor((target % 3_600_000) / 60_000)).padStart(2, '0'),
    seconds: String(Math.floor((target % 60_000) / 1000)).padStart(2, '0'),
  };
});

const attendeeSummary = computed(() => {
  if (!nextMeeting.value) return '';
  const names = nextMeeting.value.attendees
    .slice(0, 3)
    .map((attendee) => attendee.user.name.split(' ')[0]);
  return `${names.join(', ')}${nextMeeting.value.attendees.length > 3 ? ` +${nextMeeting.value.attendees.length - 3}` : ''}`;
});

function toggleAttendee(id: string) {
  meetingForm.attendeeIds = meetingForm.attendeeIds.includes(id)
    ? meetingForm.attendeeIds.filter((entry) => entry !== id)
    : [...meetingForm.attendeeIds, id];
}

async function createMeeting() {
  if (
    !meetingForm.title.trim() ||
    !meetingForm.date ||
    !meetingForm.startTime ||
    !meetingForm.endTime
  )
    return;
  creatingMeeting.value = true;
  try {
    await meetingApi.create({
      title: meetingForm.title.trim(),
      startTime: new Date(`${meetingForm.date}T${meetingForm.startTime}`).toISOString(),
      endTime: new Date(`${meetingForm.date}T${meetingForm.endTime}`).toISOString(),
      location: meetingForm.location || null,
      recurrence: meetingForm.recurrence || null,
      attendeeIds: meetingForm.attendeeIds,
    });
    meetings.value = await meetingApi.upcoming();
    showCreateMeeting.value = false;
    Object.assign(meetingForm, {
      title: '',
      date: '',
      startTime: '',
      endTime: '',
      location: '',
      recurrence: '',
      attendeeIds: [],
    });
  } finally {
    creatingMeeting.value = false;
  }
}

async function joinMeeting() {
  if (!nextMeeting.value) return;
  meetingApi.join(nextMeeting.value.id).catch(() => undefined);
  if (nextMeeting.value.location) {
    const href = nextMeeting.value.location.startsWith('http')
      ? nextMeeting.value.location
      : `https://${nextMeeting.value.location}`;
    window.open(href, '_blank', 'noopener,noreferrer');
  } else {
    await navigateTo(`/meetings/${nextMeeting.value.id}`);
  }
}

function dueDays(value: string) {
  return Math.ceil((new Date(value).getTime() - Date.now()) / 86_400_000);
}

function dueDate(value: string) {
  return new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' }).format(
    new Date(value)
  );
}

function relativeTime(value: string) {
  const seconds = Math.max(1, Math.round((Date.now() - new Date(value).getTime()) / 1000));
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} minutes ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hours ago`;
  return `${Math.floor(hours / 24)} days ago`;
}

function initials(name: string) {
  return name
    .split(' ')
    .map((part) => part[0])
    .join('')
    .toUpperCase()
    .slice(0, 2);
}

function priorityColor(priority: string) {
  if (priority === 'URGENT') return 'text-red-500';
  if (priority === 'HIGH') return 'text-accent-brand';
  if (priority === 'MEDIUM') return 'text-amber-500';
  return 'text-text-muted';
}

function columnColor(column: string) {
  if (column === 'In Progress') return 'bg-[var(--accent-quiet)] text-accent-brand';
  if (column === 'Review') return 'bg-foreground/10 text-foreground';
  return 'bg-muted text-text-muted';
}

function projectStatus(status: string) {
  if (status === 'ACTIVE')
    return { badge: 'bg-emerald-500/10 text-emerald-600', dot: 'bg-emerald-500' };
  if (status === 'IN_DEVELOPMENT')
    return { badge: 'bg-[var(--accent-quiet)] text-accent-brand', dot: 'bg-accent-brand' };
  if (status === 'ON_HOLD') return { badge: 'bg-amber-500/10 text-amber-600', dot: 'bg-amber-500' };
  return { badge: 'bg-muted text-text-muted', dot: 'bg-text-muted' };
}

function kpiIconClass(title: string) {
  if (title === 'Active Projects') return 'bg-blue-500/10 text-blue-500';
  if (title === 'Tasks Completed') return 'bg-emerald-500/10 text-emerald-500';
  if (title === 'Outstanding Invoices' || title === 'Pending Leaves')
    return 'bg-amber-500/10 text-amber-500';
  return 'bg-primary/10 text-primary';
}

const chartSeries = computed(() => revenueChart.value?.byCurrency[selectedCurrency.value] || []);
const chartMaximum = computed(() => {
  const maximum = Math.max(
    1,
    ...chartSeries.value.flatMap((point) => [point.income, point.expense])
  );
  const roughStep = maximum / 4;
  const magnitude = 10 ** Math.floor(Math.log10(roughStep));
  const normalized = roughStep / magnitude;
  const niceStep =
    normalized <= 1
      ? 1
      : normalized <= 1.5
        ? 1.5
        : normalized <= 2
          ? 2
          : normalized <= 2.5
            ? 2.5
            : normalized <= 5
              ? 5
              : 10;
  return niceStep * magnitude * 4;
});

function plottedSeries(key: 'income' | 'expense'): ChartPoint[] {
  return chartSeries.value.map((point, index, series) => ({
    ...point,
    x:
      series.length === 1
        ? chartWidth.value / 2
        : 40 + (index * (chartWidth.value - 48)) / Math.max(1, series.length - 1),
    y: 230 - (point[key] / chartMaximum.value) * 222,
  }));
}

const incomePoints = computed(() => plottedSeries('income'));
const expensePoints = computed(() => plottedSeries('expense'));

function monotonePath(points: ChartPoint[]) {
  if (!points.length) return '';
  if (points.length === 1) return `M${points[0]!.x},${points[0]!.y}`;

  const slopes = points.map((point, index) => {
    if (index === 0 || index === points.length - 1) return 0;
    const previous = points[index - 1]!;
    const next = points[index + 1]!;
    const h0 = point.x - previous.x;
    const h1 = next.x - point.x;
    const s0 = (point.y - previous.y) / h0;
    const s1 = (next.y - point.y) / h1;
    const weighted = (s0 * h1 + s1 * h0) / (h0 + h1);
    return (
      (Math.sign(s0) + Math.sign(s1)) *
        Math.min(Math.abs(s0), Math.abs(s1), 0.5 * Math.abs(weighted)) || 0
    );
  });

  const firstDelta = (points[1]!.y - points[0]!.y) / (points[1]!.x - points[0]!.x);
  const lastIndex = points.length - 1;
  const lastDelta =
    (points[lastIndex]!.y - points[lastIndex - 1]!.y) /
    (points[lastIndex]!.x - points[lastIndex - 1]!.x);
  slopes[0] = (3 * firstDelta - slopes[1]!) / 2;
  slopes[lastIndex] = (3 * lastDelta - slopes[lastIndex - 1]!) / 2;

  let path = `M${points[0]!.x},${points[0]!.y}`;
  for (let index = 1; index < points.length; index += 1) {
    const previous = points[index - 1]!;
    const point = points[index]!;
    const third = (point.x - previous.x) / 3;
    path += `C${previous.x + third},${previous.y + third * slopes[index - 1]!},${point.x - third},${point.y - third * slopes[index]!},${point.x},${point.y}`;
  }
  return path;
}

const incomePath = computed(() => monotonePath(incomePoints.value));
const expensePath = computed(() => monotonePath(expensePoints.value));
const incomeArea = computed(() =>
  incomePoints.value.length
    ? `${incomePath.value} L ${incomePoints.value.at(-1)?.x} 230 L ${incomePoints.value[0]?.x} 230 Z`
    : ''
);
const totalIncome = computed(() => chartSeries.value.reduce((sum, point) => sum + point.income, 0));
const totalProfit = computed(() => chartSeries.value.reduce((sum, point) => sum + point.profit, 0));
const chartTicks = computed(() =>
  [1, 0.75, 0.5, 0.25, 0].map((ratio) => ({
    y: 230 - ratio * 222,
    label: `${selectedCurrency.value === 'PKR' ? 'Rs ' : '$'}${Math.round(
      (chartMaximum.value * ratio) / 1000
    )}k`,
  }))
);
const activeChartPoint = computed(() =>
  activeChartIndex.value === null ? null : chartSeries.value[activeChartIndex.value]
);
const activeChartX = computed(() =>
  activeChartIndex.value === null ? 0 : incomePoints.value[activeChartIndex.value]?.x || 0
);
</script>

<template>
  <div class="studio-dashboard space-y-6">
    <header class="flex items-end justify-between gap-5" aria-labelledby="dashboard-greeting">
      <div class="min-w-0">
        <h1
          id="dashboard-greeting"
          class="font-display text-2xl font-bold tracking-tight text-foreground"
        >
          {{ greeting }}, {{ user?.name?.split(' ')[0] || 'there' }}
        </h1>
        <p class="mt-1.5 text-[15px] text-text-muted">
          Here's what's happening across your workspace today.
        </p>
      </div>
      <div class="hidden shrink-0 items-baseline gap-2 sm:flex">
        <span class="font-display text-[2rem] font-bold leading-none tracking-tight text-primary">{{
          dateParts.weekday
        }}</span>
        <span
          class="font-display text-[2rem] font-bold leading-none tracking-tight text-foreground"
          >{{ dateParts.day }}</span
        >
        <span class="ml-0.5 text-sm text-text-muted/60">{{ dateParts.monthYear }}</span>
      </div>
    </header>

    <div class="flex justify-end">
      <button
        type="button"
        class="inline-flex items-center gap-1.5 rounded-xl border px-3 py-1.5 text-xs font-medium transition-colors"
        :class="
          showCustomize
            ? 'border-primary/30 bg-primary/10 text-primary'
            : 'border-border bg-card text-text-muted hover:text-foreground'
        "
        :aria-expanded="showCustomize"
        @click="showCustomize = !showCustomize"
      >
        <SlidersHorizontal :size="14" />
        <span>Customize</span>
      </button>
    </div>

    <section v-if="showCustomize" class="studio-card p-4">
      <p class="mb-3 text-xs font-medium text-text-muted">Show widgets</p>
      <div class="flex flex-wrap gap-x-6 gap-y-2.5">
        <label
          v-for="widget in dashboardWidgets"
          :key="widget.key"
          class="flex cursor-pointer items-center gap-2 text-sm text-foreground"
        >
          <input
            type="checkbox"
            class="h-4 w-4 accent-foreground"
            :checked="!isHidden(widget.key)"
            @change="toggleWidget(widget.key)"
          />
          {{ widget.label }}
        </label>
      </div>
    </section>

    <div v-if="error" class="studio-toast-error" role="status">
      <strong class="block text-sm">Dashboard unavailable</strong>
      <span class="text-xs">{{ error }}</span>
    </div>

    <div v-if="loading" class="grid min-h-[420px] place-items-center text-text-muted">
      <div class="flex items-center gap-2 text-xs">
        <LoaderCircle :size="17" class="animate-spin" /> Loading your operating view…
      </div>
    </div>

    <template v-else>
      <section
        v-if="showCreateMeeting"
        class="studio-meeting-card space-y-4 border border-primary/20 bg-card p-5"
      >
        <header class="flex items-center justify-between">
          <h2 class="flex items-center gap-2 text-sm font-semibold text-foreground">
            <Video :size="16" /> Schedule Meeting
          </h2>
          <button
            class="text-text-muted hover:text-foreground"
            aria-label="Close meeting form"
            @click="showCreateMeeting = false"
          >
            <X :size="16" />
          </button>
        </header>
        <div class="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <label class="sm:col-span-2">
            <span class="mb-1 block text-xs font-medium text-foreground">Title *</span>
            <input
              v-model="meetingForm.title"
              autofocus
              placeholder="e.g. Sprint Planning"
              class="w-full rounded-xl border border-border bg-background px-3 py-2 text-sm text-foreground outline-none focus:border-primary"
            />
          </label>
          <label>
            <span class="mb-1 block text-xs font-medium text-foreground">Date *</span>
            <input
              v-model="meetingForm.date"
              type="date"
              class="w-full rounded-xl border border-border bg-background px-3 py-2 text-sm text-foreground outline-none focus:border-primary"
            />
          </label>
          <label>
            <span class="mb-1 block text-xs font-medium text-foreground">Location</span>
            <input
              v-model="meetingForm.location"
              placeholder="Google Meet, Zoom…"
              class="w-full rounded-xl border border-border bg-background px-3 py-2 text-sm text-foreground outline-none focus:border-primary"
            />
          </label>
          <label>
            <span class="mb-1 block text-xs font-medium text-foreground">Start *</span>
            <input
              v-model="meetingForm.startTime"
              type="time"
              class="w-full rounded-xl border border-border bg-background px-3 py-2 text-sm text-foreground outline-none focus:border-primary"
            />
          </label>
          <label>
            <span class="mb-1 block text-xs font-medium text-foreground">End *</span>
            <input
              v-model="meetingForm.endTime"
              type="time"
              class="w-full rounded-xl border border-border bg-background px-3 py-2 text-sm text-foreground outline-none focus:border-primary"
            />
          </label>
        </div>
        <div>
          <span class="mb-1.5 block text-xs font-medium text-foreground">Repeat</span>
          <div class="flex flex-wrap gap-1.5">
            <button
              v-for="option in [
                { value: '', label: 'One-time' },
                { value: 'daily', label: 'Daily' },
                { value: 'weekly', label: 'Weekly' },
                { value: 'biweekly', label: 'Bi-weekly' },
                { value: 'monthly', label: 'Monthly' },
              ]"
              :key="option.value"
              type="button"
              class="rounded-lg px-3 py-1.5 text-[11px] font-medium"
              :class="
                meetingForm.recurrence === option.value
                  ? 'bg-foreground text-background'
                  : 'bg-secondary text-text-muted hover:text-foreground'
              "
              @click="meetingForm.recurrence = option.value as typeof meetingForm.recurrence"
            >
              {{ option.label }}
            </button>
          </div>
        </div>
        <div v-if="team.length">
          <span class="mb-1.5 block text-xs font-medium text-foreground">Attendees</span>
          <div class="flex flex-wrap gap-1.5">
            <button
              v-for="member in team"
              :key="member.id"
              type="button"
              class="rounded-lg px-2.5 py-1 text-[11px] font-medium"
              :class="
                meetingForm.attendeeIds.includes(member.id)
                  ? 'bg-[var(--accent-quiet)] text-accent-brand ring-1 ring-accent-brand/20'
                  : 'bg-secondary text-text-muted hover:text-foreground'
              "
              @click="toggleAttendee(member.id)"
            >
              {{ member.name.split(' ')[0] }}
            </button>
          </div>
        </div>
        <footer class="flex justify-end gap-2">
          <button
            class="rounded-xl px-3 py-2 text-xs font-medium text-text-muted hover:text-foreground"
            @click="showCreateMeeting = false"
          >
            Cancel
          </button>
          <button
            class="flex items-center gap-1.5 rounded-full bg-primary px-4 py-2 text-xs font-semibold text-primary-foreground disabled:opacity-40"
            :disabled="
              creatingMeeting ||
              !meetingForm.title ||
              !meetingForm.date ||
              !meetingForm.startTime ||
              !meetingForm.endTime
            "
            @click="createMeeting"
          >
            <LoaderCircle v-if="creatingMeeting" :size="14" class="animate-spin" /> Schedule
          </button>
        </footer>
      </section>

      <section
        v-else-if="nextMeeting"
        class="studio-meeting-card flex items-center justify-between border p-4 transition-colors sm:p-5"
        :class="
          meetingLive ? 'border-emerald-500/30 bg-emerald-500/5' : 'border-border-subtle bg-card'
        "
      >
        <div class="flex min-w-0 items-center gap-4">
          <div
            class="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl"
            :class="meetingLive ? 'bg-emerald-500/15' : 'bg-primary/10'"
          >
            <Video :size="20" :class="meetingLive ? 'text-emerald-500' : 'text-primary'" />
          </div>
          <div class="min-w-0">
            <p class="flex items-center gap-1.5 text-[13px] text-text-muted">
              <template v-if="meetingLive">
                <span class="relative flex h-2 w-2"
                  ><span
                    class="absolute h-full w-full animate-ping rounded-full bg-emerald-500 opacity-75" /><span
                    class="relative h-2 w-2 rounded-full bg-emerald-500"
                /></span>
                <span class="font-semibold uppercase tracking-wider text-emerald-500"
                  >Live now</span
                >
              </template>
              <template v-else>Next meeting</template>
              <span
                v-if="nextMeeting.recurrence"
                class="ml-1 rounded-md bg-violet-500/10 px-1.5 py-0.5 text-[10px] font-medium text-violet-500"
                >{{ nextMeeting.recurrence }}</span
              >
            </p>
            <p class="mt-0.5 truncate text-[15px] font-semibold text-foreground">
              {{ nextMeeting.title
              }}<span v-if="attendeeSummary" class="font-normal text-text-muted"> with </span
              >{{ attendeeSummary }}
            </p>
          </div>
        </div>
        <div class="hidden items-center gap-5 sm:flex">
          <div class="flex items-center gap-3" aria-live="polite">
            <div
              v-for="unit in [
                { value: countdown.hours, label: 'hr' },
                { value: countdown.minutes, label: 'min' },
                { value: countdown.seconds, label: 'sec' },
              ]"
              :key="unit.label"
              class="flex flex-col items-center"
            >
              <strong
                class="text-2xl font-bold leading-none tracking-tight tabular-nums"
                :class="meetingLive ? 'text-emerald-500' : 'text-foreground'"
                >{{ unit.value }}</strong
              >
              <small class="mt-1 text-[10px] uppercase tracking-wider text-text-faint">{{
                unit.label
              }}</small>
            </div>
          </div>
          <span
            v-if="meetingLive"
            class="text-[10px] font-semibold uppercase tracking-wider text-emerald-500/80"
            >elapsed</span
          >
          <button
            class="rounded-xl px-5 py-2.5 text-sm font-semibold text-white transition-all active:scale-[0.98]"
            :class="
              meetingLive
                ? 'bg-emerald-500 hover:bg-emerald-600'
                : 'bg-primary hover:bg-[var(--primary-hover)]'
            "
            @click="joinMeeting"
          >
            {{ meetingLive ? 'Join now' : nextMeeting.location ? 'Join' : 'View' }}
          </button>
        </div>
        <NuxtLink :to="`/meetings/${nextMeeting.id}`" class="sm:hidden"
          ><ChevronRight :size="18" class="text-text-muted"
        /></NuxtLink>
      </section>

      <section
        v-else
        class="studio-meeting-card flex items-center justify-between border border-dashed border-border bg-card/50 p-4 sm:p-5"
      >
        <div class="flex items-center gap-4">
          <div class="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-primary/10">
            <Video :size="20" class="text-primary" />
          </div>
          <div>
            <p class="text-[15px] font-semibold text-foreground">No upcoming meetings</p>
            <p class="text-[13px] text-text-muted">Schedule one to get started</p>
          </div>
        </div>
        <button
          class="flex items-center gap-1.5 rounded-full bg-primary px-4 py-2.5 text-sm font-semibold text-primary-foreground"
          @click="showCreateMeeting = true"
        >
          <Plus :size="16" /> Schedule
        </button>
      </section>

      <section
        class="grid grid-cols-1 gap-4"
        :class="stats?.isAdmin ? 'sm:grid-cols-2 lg:grid-cols-4' : 'sm:grid-cols-3'"
      >
        <article
          v-for="card in cards"
          :key="card.title"
          class="group relative min-h-[168px] overflow-hidden rounded-xl border border-border/60 bg-card px-6 py-10 transition-all duration-200 hover:border-border hover:shadow-lg hover:shadow-black/5"
        >
          <div class="flex items-start justify-between gap-3" data-slot="stat">
            <div class="space-y-2">
              <p class="text-[13px] font-medium text-text-muted">{{ card.title }}</p>
              <p class="font-display break-words text-3xl font-bold tracking-tight text-foreground">
                {{ card.value }}
              </p>
              <div v-if="card.change" class="flex items-center gap-1.5">
                <TrendingUp v-if="card.trend === 'up'" :size="14" class="text-emerald-500" />
                <span
                  class="text-xs font-medium"
                  :class="
                    card.trend === 'down'
                      ? 'text-red-500'
                      : card.trend === 'neutral'
                        ? 'text-text-muted'
                        : 'text-emerald-600'
                  "
                  >{{ card.change }}</span
                >
                <span v-if="card.changeLabel" class="text-xs text-text-muted">{{
                  card.changeLabel
                }}</span>
              </div>
            </div>
            <div
              class="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl transition-transform group-hover:scale-105"
              :class="kpiIconClass(card.title)"
            >
              <component :is="card.icon" :size="20" />
            </div>
          </div>
        </article>
      </section>

      <section
        v-if="stats?.isAdmin && revenueChart?.currencies.length"
        class="studio-card studio-revenue-card overflow-hidden"
      >
        <header class="p-5 pb-2 sm:px-6 sm:pt-6">
          <div class="flex flex-wrap items-center justify-between gap-3">
            <h2 class="flex items-center gap-2 text-[15px] font-semibold text-foreground">
              <span class="studio-section-icon"><TrendingUp :size="14" /></span>Revenue Overview
            </h2>
            <div class="flex items-center gap-5">
              <div
                v-if="revenueChart.currencies.length > 1"
                class="flex items-center gap-1 rounded-lg border border-border p-0.5"
              >
                <button
                  v-for="currency in revenueChart.currencies"
                  :key="currency"
                  class="rounded-md px-2 py-0.5 text-[11px] font-semibold"
                  :class="
                    selectedCurrency === currency
                      ? 'bg-foreground text-background'
                      : 'text-text-muted'
                  "
                  @click="selectedCurrency = currency"
                >
                  {{ currency }}
                </button>
              </div>
              <span class="flex items-center gap-1.5 text-xs text-text-muted"
                ><i class="h-2 w-2 rounded-full bg-primary" /> Income</span
              >
              <span class="hidden items-center gap-1.5 text-xs text-text-muted sm:flex"
                ><i class="h-2 w-2 rounded-full bg-border-strong" /> Expenses</span
              >
            </div>
          </div>
          <div class="mt-2 flex flex-wrap items-baseline gap-4">
            <div>
              <strong class="text-2xl font-bold tracking-tight text-foreground">{{
                money(totalIncome, selectedCurrency)
              }}</strong
              ><span class="ml-1.5 text-xs text-text-muted">total income</span>
            </div>
            <div>
              <strong class="text-sm font-semibold text-emerald-500">{{
                money(totalProfit, selectedCurrency)
              }}</strong
              ><span class="ml-1 text-xs text-text-muted">net profit</span>
            </div>
          </div>
        </header>
        <div class="px-3 pb-4 sm:px-5">
          <svg
            ref="chartContainer"
            :viewBox="`0 0 ${chartWidth} 260`"
            class="h-[260px] w-full overflow-visible"
            role="img"
            aria-label="Revenue and expenses by month"
          >
            <defs>
              <linearGradient id="studio-income-gradient" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stop-color="var(--primary)" stop-opacity="0.22" />
                <stop offset="100%" stop-color="var(--primary)" stop-opacity="0" />
              </linearGradient>
            </defs>
            <g v-for="tick in chartTicks" :key="tick.y">
              <line
                x1="40"
                :x2="chartWidth - 8"
                :y1="tick.y"
                :y2="tick.y"
                stroke="var(--border)"
                stroke-dasharray="3 3"
              />
              <text
                x="42"
                :y="tick.y + 4"
                text-anchor="end"
                fill="var(--text-muted)"
                font-size="10"
              >
                {{ tick.label }}
              </text>
            </g>
            <path :d="incomeArea" fill="url(#studio-income-gradient)" />
            <path
              :d="expensePath"
              fill="none"
              stroke="var(--text-faint)"
              stroke-width="1.5"
              stroke-linecap="round"
              stroke-linejoin="round"
            />
            <path
              :d="incomePath"
              fill="none"
              stroke="var(--primary)"
              stroke-width="2.5"
              stroke-linecap="round"
              stroke-linejoin="round"
            />
            <g v-for="(point, index) in incomePoints" :key="point.month">
              <rect
                :x="point.x - 25"
                y="35"
                width="50"
                height="190"
                fill="transparent"
                @mouseenter="activeChartIndex = index"
                @mouseleave="activeChartIndex = null"
              />
              <text
                :x="point.x"
                y="252"
                text-anchor="middle"
                fill="var(--text-muted)"
                font-size="10"
              >
                {{ point.month }}
              </text>
            </g>
            <g v-if="activeChartPoint">
              <line
                :x1="activeChartX"
                :x2="activeChartX"
                y1="42"
                y2="230"
                stroke="var(--border-strong)"
                stroke-dasharray="3 3"
              />
              <circle
                :cx="activeChartX"
                :cy="activeChartIndex === null ? 0 : incomePoints[activeChartIndex]?.y"
                r="5"
                fill="var(--primary)"
                stroke="var(--card)"
                stroke-width="2"
              />
            </g>
          </svg>
        </div>
      </section>

      <div class="grid grid-cols-1 gap-5 lg:grid-cols-5">
        <section v-if="!isHidden('myTasks')" class="studio-card lg:col-span-3">
          <header class="flex items-center justify-between px-6 pb-2 pt-6">
            <h2 class="flex items-center gap-2 text-[15px] font-semibold text-foreground">
              <span class="studio-section-icon"><CheckCircle2 :size="14" /></span>My Tasks
            </h2>
            <span v-if="tasks.length" class="text-xs text-text-muted">{{ tasks.length }} open</span>
          </header>
          <div class="divide-y divide-border-subtle px-6 pb-6">
            <NuxtLink
              v-for="task in tasks"
              :key="task.id"
              :to="`/projects/${task.projectId}/board/${task.boardId}`"
              class="group flex items-center gap-3 py-3"
            >
              <Circle :size="16" :stroke-width="2.5" :class="priorityColor(task.priority)" />
              <div class="min-w-0 flex-1">
                <p
                  class="truncate text-sm font-medium text-foreground group-hover:text-accent-brand"
                >
                  {{ task.title }}
                </p>
                <div class="mt-1 flex items-center gap-2">
                  <span
                    class="rounded-md px-1.5 py-0.5 text-[10px] font-medium"
                    :class="columnColor(task.columnName)"
                    >{{ task.columnName }}</span
                  ><span v-if="task.dueDate" class="text-[11px] text-text-muted">{{
                    dueDate(task.dueDate)
                  }}</span
                  ><span class="truncate text-[11px] text-text-faint">{{ task.projectName }}</span>
                </div>
              </div>
              <ChevronRight
                :size="16"
                class="shrink-0 text-text-faint opacity-0 group-hover:opacity-100"
              />
            </NuxtLink>
            <div v-if="!tasks.length" class="py-12 text-center">
              <CheckCircle2 :size="40" class="mx-auto text-emerald-500/20" />
              <p class="mt-3 text-sm font-medium text-foreground">All caught up</p>
              <p class="mt-1 text-xs text-text-muted">No tasks assigned to you right now</p>
            </div>
          </div>
        </section>

        <section v-if="!isHidden('deadlines')" class="studio-card lg:col-span-2">
          <header class="px-6 pb-2 pt-6">
            <h2 class="flex items-center gap-2 text-[15px] font-semibold text-foreground">
              <span class="studio-section-icon"><Clock :size="14" class="text-amber-500" /></span
              >Upcoming Deadlines
            </h2>
          </header>
          <div class="divide-y divide-border-subtle px-6 pb-6">
            <NuxtLink
              v-for="deadline in deadlines"
              :key="deadline.id"
              :to="`/projects/${deadline.projectId}`"
              class="group flex items-center gap-3 py-3"
            >
              <span
                class="flex h-10 w-10 shrink-0 flex-col items-center justify-center rounded-xl"
                :class="
                  dueDays(deadline.dueDate) <= 3
                    ? 'bg-red-500/10 text-red-500'
                    : dueDays(deadline.dueDate) <= 7
                      ? 'bg-amber-500/10 text-amber-500'
                      : 'bg-emerald-500/10 text-emerald-500'
                "
                ><strong class="text-sm leading-none">{{ dueDays(deadline.dueDate) }}</strong
                ><small class="mt-0.5 text-[9px] font-medium">days</small></span
              >
              <span class="min-w-0 flex-1"
                ><strong
                  class="block truncate text-sm font-medium text-foreground group-hover:text-accent-brand"
                  >{{ deadline.name }}</strong
                ><small class="block truncate text-xs text-text-muted">{{
                  deadline.projectName
                }}</small></span
              ><ChevronRight :size="14" class="text-text-faint opacity-0 group-hover:opacity-100" />
            </NuxtLink>
            <div v-if="!deadlines.length" class="py-12 text-center">
              <Clock :size="40" class="mx-auto text-text-faint/20" />
              <p class="mt-3 text-sm text-text-muted">No upcoming deadlines</p>
            </div>
          </div>
        </section>
      </div>

      <div class="grid grid-cols-1 gap-5 lg:grid-cols-5">
        <section v-if="!isHidden('activity')" class="studio-card lg:col-span-2">
          <header class="px-6 pb-2 pt-6">
            <h2 class="flex items-center gap-2 text-[15px] font-semibold text-foreground">
              <span class="studio-section-icon"><Activity :size="14" /></span>Activity
            </h2>
          </header>
          <div class="divide-y divide-border-subtle px-6 pb-6">
            <div
              v-for="item in activity.slice(0, 6)"
              :key="item.id"
              class="flex items-start gap-3.5 py-3.5"
            >
              <div class="relative">
                <span
                  class="grid h-8 w-8 place-items-center rounded-full bg-secondary text-[10px] font-semibold text-foreground"
                  >{{ initials(item.userName || 'DevFathom') }}</span
                ><span
                  class="absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full border-2 border-card bg-accent-brand"
                />
              </div>
              <div class="min-w-0 flex-1">
                <p class="text-sm leading-relaxed text-text-muted">
                  <strong class="text-foreground">{{ item.userName || 'DevFathom' }}</strong>
                  {{ item.message.toLowerCase() }}
                </p>
                <p class="mt-0.5 text-[11px] text-text-faint">{{ relativeTime(item.createdAt) }}</p>
              </div>
            </div>
            <p v-if="!activity.length" class="py-12 text-center text-sm text-text-muted">
              No recent activity
            </p>
          </div>
        </section>

        <section v-if="!isHidden('projects')" class="lg:col-span-3">
          <h2 class="mb-4 flex items-center gap-2 px-1 text-[15px] font-semibold text-foreground">
            <span class="studio-section-icon"><FolderKanban :size="14" /></span>Active Projects
          </h2>
          <div class="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <NuxtLink
              v-for="project in projects"
              :key="project.id"
              :to="`/projects/${project.id}`"
              class="studio-project-card group cursor-pointer border border-border-subtle bg-card p-5 transition-all"
            >
              <div class="flex items-start justify-between gap-3">
                <div class="min-w-0 space-y-1">
                  <h3
                    class="truncate text-sm font-semibold text-foreground group-hover:text-accent-brand"
                  >
                    {{ project.name }}
                  </h3>
                  <p class="truncate text-xs text-text-muted">
                    {{
                      project.client?.name ||
                      (project.type === 'INTERNAL' ? 'Internal Product' : '')
                    }}
                  </p>
                </div>
                <span
                  class="inline-flex shrink-0 items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-medium"
                  :class="projectStatus(project.status).badge"
                  ><i
                    class="h-1.5 w-1.5 rounded-full"
                    :class="projectStatus(project.status).dot"
                  />{{ project.status.replace('_', ' ') }}</span
                >
              </div>
              <div class="mt-5 flex items-center justify-between">
                <div class="flex -space-x-2">
                  <span
                    v-for="member in project.members.slice(0, 4)"
                    :key="member.user.id"
                    class="grid h-7 w-7 place-items-center rounded-full border-2 border-card bg-secondary text-[10px] font-semibold text-foreground"
                    :title="member.user.name"
                    >{{ member.user.name[0] }}</span
                  ><span
                    v-if="project.members.length > 4"
                    class="grid h-7 w-7 place-items-center rounded-full border-2 border-card bg-secondary text-[10px] font-semibold text-text-muted"
                    >+{{ project.members.length - 4 }}</span
                  >
                </div>
                <ArrowUpRight
                  :size="16"
                  class="text-text-faint opacity-0 group-hover:text-accent-brand group-hover:opacity-100"
                />
              </div>
            </NuxtLink>
            <div v-if="!projects.length" class="studio-card col-span-full py-12 text-center">
              <FolderKanban :size="40" class="mx-auto text-text-faint/20" />
              <p class="mt-3 text-sm text-text-muted">No active projects yet</p>
            </div>
          </div>
        </section>
      </div>
    </template>
  </div>
</template>
