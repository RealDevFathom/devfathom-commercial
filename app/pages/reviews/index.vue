<script setup lang="ts">
import {
  CheckCircle2,
  ChevronLeft,
  ClipboardList,
  Lock,
  Plus,
  Star,
  Unlock,
  UserPlus,
} from 'lucide-vue-next';
import type { Review, ReviewCycle, TeamMember } from '~/types/firm';

useHead({ title: 'Reviews · DevFathom Hub' });

const api = useFirm();
const { user } = useAuth();
const {
  pending: actionPending,
  error: actionError,
  success: actionSuccess,
  clear: clearAction,
  run: runAction,
} = useFirmAction();
const manager = computed(() => ['ADMIN', 'HR'].includes(user.value?.role || ''));
const tab = ref<'cycles' | 'mine'>('cycles');
const reviews = ref<Review[]>([]);
const cycles = ref<ReviewCycle[]>([]);
const team = ref<TeamMember[]>([]);
const loading = ref(true);
const error = ref('');
const cycleOpen = ref(false);
const reviewOpen = ref<Review | null>(null);
const selectedCycleId = ref<string | null>(null);
const cycle = reactive({ name: '', start_date: '', end_date: '' });
const assignment = reactive({ cycleId: '', subject_id: '', reviewer_id: '' });
const reviewDraft = reactive({ rating: 3, strengths: '', improvements: '', comments: '' });

async function load(showSpinner = true) {
  if (showSpinner) loading.value = true;
  error.value = '';
  try {
    reviews.value = await api.reviews();
    if (manager.value) {
      [cycles.value, team.value] = await Promise.all([api.cycles(), api.team()]);
    }
  } catch (caught: any) {
    error.value = caught?.data?.detail || 'The review register is unavailable.';
  } finally {
    loading.value = false;
  }
}

await load();

async function createCycle() {
  if (!manager.value) return;
  const result = await runAction(
    'Creating review cycle…',
    async () => {
      const created = await api.createCycle({
        ...cycle,
        start_date: new Date(cycle.start_date).toISOString(),
        end_date: new Date(cycle.end_date).toISOString(),
      });
      await load(false);
      return created;
    },
    { success: 'Review cycle created.', error: 'The review cycle could not be created.' }
  );
  if (!result) return;
  cycleOpen.value = false;
  Object.assign(cycle, { name: '', start_date: '', end_date: '' });
}

async function submitReview() {
  if (!reviewOpen.value) return;
  const result = await runAction(
    'Submitting review…',
    async () => {
      const submitted = await api.submitReview(reviewOpen.value!.id, { ...reviewDraft });
      await load(false);
      return submitted;
    },
    { success: 'Review submitted.', error: 'The review could not be submitted.' }
  );
  if (!result) return;
  reviewOpen.value = null;
  Object.assign(reviewDraft, { rating: 3, strengths: '', improvements: '', comments: '' });
}

async function assignReview() {
  if (!manager.value) return;
  const result = await runAction(
    'Assigning reviewer…',
    async () => {
      const assigned = await api.assignReview(
        assignment.cycleId,
        assignment.subject_id,
        assignment.reviewer_id
      );
      await load(false);
      return assigned;
    },
    { success: 'Reviewer assigned.', error: 'The reviewer could not be assigned.' }
  );
  if (!result) return;
  Object.assign(assignment, { cycleId: assignment.cycleId, subject_id: '', reviewer_id: '' });
}

async function changeCycle(item: ReviewCycle) {
  if (!manager.value) return;
  const action = item.status === 'OPEN' ? 'close' : 'reopen';
  await runAction(
    action === 'close' ? 'Closing review cycle…' : 'Reopening review cycle…',
    async () => {
      const updated = await api.changeCycle(item.id, action);
      await load(false);
      return updated;
    },
    {
      success: action === 'close' ? 'Review cycle closed.' : 'Review cycle reopened.',
      error: `The review cycle could not be ${action === 'close' ? 'closed' : 'reopened'}.`,
    }
  );
}

function openReview(review: Review) {
  Object.assign(reviewDraft, {
    rating: review.rating || 3,
    strengths: review.strengths || '',
    improvements: review.improvements || '',
    comments: review.comments || '',
  });
  reviewOpen.value = review;
}

const date = (value: string) =>
  new Intl.DateTimeFormat('en', { dateStyle: 'medium' }).format(new Date(value));
const selectedCycle = computed(() =>
  cycles.value.find((item) => item.id === selectedCycleId.value)
);
const cycleReviews = computed(() =>
  reviews.value.filter((review) => review.cycleId === selectedCycleId.value)
);
const assignedToMe = computed(() =>
  reviews.value.filter((review) => review.reviewerId === user.value?.id)
);
const toComplete = computed(() =>
  assignedToMe.value.filter((review) => review.status !== 'SUBMITTED')
);
const submittedByMe = computed(() =>
  assignedToMe.value.filter((review) => review.status === 'SUBMITTED')
);
const aboutMe = computed(() =>
  reviews.value.filter(
    (review) => review.subjectId === user.value?.id && review.status === 'SUBMITTED'
  )
);
const initials = (name: string) =>
  name
    .split(' ')
    .map((part) => part[0])
    .join('')
    .slice(0, 2)
    .toUpperCase();
</script>

<template>
  <section class="animate-fade-in space-y-6">
    <div>
      <h1 class="font-display text-2xl font-bold tracking-tight text-foreground">
        Performance Reviews
      </h1>
      <p class="mt-1.5 text-[15px] text-text-muted">
        {{
          manager
            ? 'Run review cycles, assign reviewers, and complete your own reviews.'
            : 'Reviews assigned to you and feedback shared about your work.'
        }}
      </p>
    </div>

    <nav
      v-if="manager"
      class="inline-flex h-8 w-fit items-center gap-0.5 rounded-lg bg-muted p-[3px] text-text-muted"
      aria-label="Review sections"
    >
      <button
        class="h-[26px] rounded-md px-1.5 py-0.5 text-sm font-medium"
        :class="tab === 'cycles' ? 'bg-card text-foreground shadow-sm' : 'hover:text-foreground'"
        @click="tab = 'cycles'"
      >
        Cycles
      </button>
      <button
        class="h-[26px] rounded-md px-1.5 py-0.5 text-sm font-medium"
        :class="tab === 'mine' ? 'bg-card text-foreground shadow-sm' : 'hover:text-foreground'"
        @click="tab = 'mine'"
      >
        My Reviews
      </button>
    </nav>

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

    <template v-else>
      <section v-if="manager && tab === 'cycles' && !selectedCycle" class="space-y-5">
        <div class="flex flex-wrap items-center justify-between gap-4">
          <p class="text-sm text-text-muted">
            {{
              cycles.length
                ? cycles.length + ' review cycle' + (cycles.length === 1 ? '.' : 's.')
                : 'No review cycles yet.'
            }}
          </p>
          <button
            class="studio-primary-button"
            :disabled="Boolean(actionPending)"
            @click="cycleOpen = true"
          >
            <Plus :size="16" /> New cycle
          </button>
        </div>

        <section class="overflow-hidden rounded-xl bg-card py-4 ring-1 ring-foreground/10">
          <div class="divide-y divide-border-subtle">
            <article
              v-for="item in cycles"
              :key="item.id"
              class="flex items-center gap-4 px-6 py-4"
            >
              <div class="min-w-0 flex-1">
                <button
                  class="block max-w-full truncate text-left text-sm font-semibold text-foreground transition-colors hover:text-primary"
                  @click="selectedCycleId = item.id"
                >
                  {{ item.name }}
                </button>
                <p class="text-xs text-text-muted">
                  {{ date(item.startDate) }} — {{ date(item.endDate) }} ·
                  {{ item.reviewCount }} review{{ item.reviewCount === 1 ? '' : 's' }}
                </p>
              </div>
              <span
                class="rounded-full px-2.5 py-1 text-[11px] font-medium"
                :class="
                  item.status === 'OPEN'
                    ? 'bg-emerald-500/10 text-emerald-500'
                    : 'bg-secondary text-text-muted'
                "
                >{{ item.status.charAt(0) + item.status.slice(1).toLowerCase() }}</span
              >
              <div class="flex flex-wrap gap-2">
                <button
                  class="flex items-center gap-1.5 rounded-lg px-3 py-2 text-xs font-medium text-text-muted transition-colors hover:bg-secondary hover:text-foreground"
                  :disabled="Boolean(actionPending)"
                  @click="changeCycle(item)"
                >
                  <Lock v-if="item.status === 'OPEN'" :size="14" />
                  <Unlock v-else :size="14" />
                  {{ item.status === 'OPEN' ? 'Close' : 'Reopen' }}
                </button>
              </div>
            </article>
            <DeliveryFieldState v-if="!cycles.length" empty="No review cycles have been created." />
          </div>
        </section>
      </section>

      <section v-else-if="manager && tab === 'cycles' && selectedCycle" class="space-y-5">
        <button
          class="inline-flex items-center gap-1 text-sm text-[var(--text-muted)] hover:text-[var(--foreground)]"
          @click="selectedCycleId = null"
        >
          <ChevronLeft :size="16" /> All cycles
        </button>
        <div class="flex flex-wrap items-center gap-3">
          <h2 class="text-lg font-semibold">{{ selectedCycle.name }}</h2>
          <span
            class="studio-status-pill"
            :data-tone="selectedCycle.status === 'OPEN' ? 'success' : 'neutral'"
            >{{ selectedCycle.status }}</span
          >
        </div>
        <form
          v-if="selectedCycle.status === 'OPEN'"
          class="space-y-3 rounded-xl bg-card p-5 ring-1 ring-primary/20"
          @submit.prevent="
            assignment.cycleId = selectedCycle.id;
            assignReview();
          "
        >
          <header class="flex items-center gap-2">
            <UserPlus :size="16" class="text-[var(--accent-brand)]" />
            <h3 class="text-sm font-semibold">Assign a reviewer</h3>
          </header>
          <div class="grid gap-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
            <label class="studio-field"
              >Subject<select v-model="assignment.subject_id" required>
                <option value="">Select person…</option>
                <option v-for="member in team" :key="member.id" :value="member.id">
                  {{ member.name }}
                </option>
              </select></label
            >
            <label class="studio-field"
              >Reviewer<select v-model="assignment.reviewer_id" required>
                <option value="">Select reviewer…</option>
                <option v-for="member in team" :key="member.id" :value="member.id">
                  {{ member.name }}
                </option>
              </select></label
            >
            <button class="studio-primary-button" :disabled="Boolean(actionPending)">
              <Plus :size="15" />
              {{ actionPending === 'Assigning reviewer…' ? 'Assigning…' : 'Assign' }}
            </button>
          </div>
        </form>
        <section class="overflow-hidden rounded-xl bg-card py-4 ring-1 ring-foreground/10">
          <header class="px-4 pb-2">
            <h3 class="text-[15px] font-semibold">Assigned reviews</h3>
          </header>
          <div class="divide-y divide-[var(--border-subtle)]">
            <article
              v-for="review in cycleReviews"
              :key="review.id"
              class="flex flex-wrap items-center gap-4 p-5"
            >
              <span
                class="grid size-9 place-items-center rounded-full bg-[var(--surface-sunken)] text-xs font-semibold"
                >{{ initials(review.subjectName) }}</span
              >
              <div>
                <strong class="block text-sm">{{ review.subjectName }}</strong
                ><small class="text-[10px] uppercase tracking-wider text-[var(--text-muted)]"
                  >subject</small
                >
              </div>
              <span class="text-xs text-[var(--text-muted)]">reviewed by</span>
              <span
                class="grid size-9 place-items-center rounded-full bg-[var(--surface-sunken)] text-xs font-semibold"
                >{{ initials(review.reviewerName) }}</span
              >
              <div>
                <strong class="block text-sm">{{ review.reviewerName }}</strong
                ><small class="text-[10px] uppercase tracking-wider text-[var(--text-muted)]"
                  >reviewer</small
                >
              </div>
              <span
                class="studio-status-pill ml-auto"
                :data-tone="review.status === 'SUBMITTED' ? 'success' : 'neutral'"
                >{{ review.status }}</span
              >
            </article>
            <DeliveryFieldState v-if="!cycleReviews.length" empty="No reviewers assigned yet." />
          </div>
        </section>
      </section>

      <div v-if="!manager || tab === 'mine'" class="space-y-6">
        <section class="overflow-hidden rounded-xl bg-card py-4 ring-1 ring-foreground/10">
          <header class="flex items-center gap-2 px-4 pb-2">
            <span class="grid size-7 place-items-center rounded-lg bg-amber-500/10 text-amber-600"
              ><ClipboardList :size="15"
            /></span>
            <h2 class="text-[15px] font-semibold text-[var(--foreground)]">Reviews to complete</h2>
          </header>
          <div class="divide-y divide-[var(--border-subtle)]">
            <article
              v-for="review in toComplete"
              :key="review.id"
              class="grid gap-4 p-5 sm:grid-cols-[44px_minmax(0,1fr)_auto] sm:items-center sm:p-6"
            >
              <span
                class="grid size-11 place-items-center rounded-full bg-[var(--foreground)] text-xs font-semibold text-[var(--primary-foreground)]"
              >
                {{ review.subjectName.slice(0, 2).toUpperCase() }}
              </span>
              <div>
                <strong class="text-sm font-semibold text-[var(--foreground)]">{{
                  review.subjectName
                }}</strong>
                <p class="mt-1 text-sm text-[var(--text-muted)]">
                  {{ review.cycleName }} · Reviewer {{ review.reviewerName }}
                </p>
                <span v-if="review.rating" class="mt-2 flex gap-0.5 text-amber-500">
                  <Star
                    v-for="number in review.rating"
                    :key="number"
                    :size="13"
                    fill="currentColor"
                  />
                </span>
              </div>
              <button
                class="studio-primary-button"
                :disabled="Boolean(actionPending)"
                @click="openReview(review)"
              >
                Fill review
              </button>
            </article>
            <DeliveryFieldState v-if="!toComplete.length" empty="Nothing waiting on you." />
          </div>
        </section>

        <section
          v-if="submittedByMe.length"
          class="overflow-hidden rounded-xl bg-card py-4 ring-1 ring-foreground/10"
        >
          <header class="flex items-center gap-2 px-4 pb-2">
            <span
              class="grid size-7 place-items-center rounded-lg bg-emerald-500/10 text-emerald-600"
              ><CheckCircle2 :size="15"
            /></span>
            <h2 class="text-[15px] font-semibold">Submitted by you</h2>
          </header>
          <article
            v-for="review in submittedByMe"
            :key="review.id"
            class="border-b border-[var(--border-subtle)] p-5 last:border-0"
          >
            <div class="flex items-center gap-3">
              <span
                class="grid size-9 place-items-center rounded-full bg-[var(--surface-sunken)] text-xs font-semibold"
                >{{ initials(review.subjectName) }}</span
              >
              <div>
                <strong class="text-sm">{{ review.subjectName }}</strong>
                <p class="text-xs text-[var(--text-muted)]">of · {{ review.cycleName }}</p>
              </div>
              <span v-if="review.rating" class="ml-auto flex text-amber-500"
                ><Star v-for="number in review.rating" :key="number" :size="13" fill="currentColor"
              /></span>
            </div>
          </article>
        </section>

        <section class="overflow-hidden rounded-xl bg-card py-4 ring-1 ring-foreground/10">
          <header class="flex items-center gap-2 px-4 pb-2">
            <span class="grid size-7 place-items-center rounded-lg bg-blue-500/10 text-blue-600"
              ><Star :size="15"
            /></span>
            <h2 class="text-[15px] font-semibold">Feedback about you</h2>
          </header>
          <article
            v-for="review in aboutMe"
            :key="review.id"
            class="space-y-3 border-b border-[var(--border-subtle)] p-5 last:border-0"
          >
            <div class="flex items-center gap-3">
              <span
                class="grid size-9 place-items-center rounded-full bg-[var(--surface-sunken)] text-xs font-semibold"
                >{{ initials(review.reviewerName) }}</span
              >
              <div>
                <strong class="text-sm">{{ review.reviewerName }}</strong>
                <p class="text-xs text-[var(--text-muted)]">by · {{ review.cycleName }}</p>
              </div>
              <span v-if="review.rating" class="ml-auto flex text-amber-500"
                ><Star v-for="number in review.rating" :key="number" :size="13" fill="currentColor"
              /></span>
            </div>
            <dl
              v-if="review.strengths || review.improvements || review.comments"
              class="grid gap-3 pl-12 text-sm"
            >
              <div v-if="review.strengths">
                <dt
                  class="text-[10px] font-semibold uppercase tracking-wider text-[var(--text-muted)]"
                >
                  Strengths
                </dt>
                <dd class="mt-1">{{ review.strengths }}</dd>
              </div>
              <div v-if="review.improvements">
                <dt
                  class="text-[10px] font-semibold uppercase tracking-wider text-[var(--text-muted)]"
                >
                  Areas to improve
                </dt>
                <dd class="mt-1">{{ review.improvements }}</dd>
              </div>
              <div v-if="review.comments">
                <dt
                  class="text-[10px] font-semibold uppercase tracking-wider text-[var(--text-muted)]"
                >
                  Comments
                </dt>
                <dd class="mt-1">{{ review.comments }}</dd>
              </div>
            </dl>
          </article>
          <DeliveryFieldState v-if="!aboutMe.length" empty="No submitted feedback yet." />
        </section>
      </div>
    </template>

    <DeliveryFieldDialog
      :open="cycleOpen"
      title="New review cycle"
      @close="!actionPending && (cycleOpen = false)"
    >
      <form class="studio-form-grid" @submit.prevent="createCycle">
        <FirmActionFeedback
          :busy="actionPending === 'Creating review cycle…'"
          :busy-label="actionPending"
          :error="actionError"
          @dismiss="clearAction"
        />
        <label>Name<input v-model="cycle.name" required /></label>
        <div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <label>Starts<input v-model="cycle.start_date" type="date" required /></label>
          <label>Ends<input v-model="cycle.end_date" type="date" required /></label>
        </div>
        <button class="studio-primary-button" :disabled="Boolean(actionPending)">
          {{ actionPending === 'Creating review cycle…' ? 'Creating…' : 'Create cycle' }}
        </button>
      </form>
    </DeliveryFieldDialog>

    <DeliveryFieldDialog
      :open="!!reviewOpen"
      :title="`Review ${reviewOpen?.subjectName || ''}`"
      @close="!actionPending && (reviewOpen = null)"
    >
      <form class="studio-form-grid" @submit.prevent="submitReview">
        <FirmActionFeedback
          :busy="actionPending === 'Submitting review…'"
          :busy-label="actionPending"
          :error="actionError"
          @dismiss="clearAction"
        />
        <label>
          Rating
          <select v-model.number="reviewDraft.rating">
            <option v-for="number in 5" :key="number" :value="number">{{ number }} / 5</option>
          </select>
        </label>
        <label>Strengths<textarea v-model="reviewDraft.strengths" rows="4" /></label>
        <label>Areas to improve<textarea v-model="reviewDraft.improvements" rows="4" /></label>
        <label>Comments<textarea v-model="reviewDraft.comments" rows="4" /></label>
        <button class="studio-primary-button" :disabled="Boolean(actionPending)">
          {{ actionPending === 'Submitting review…' ? 'Submitting…' : 'Submit review' }}
        </button>
      </form>
    </DeliveryFieldDialog>
  </section>
</template>
