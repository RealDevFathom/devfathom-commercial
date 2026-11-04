/**
 * DEV-751 — shared fixtures for the pharmacy procedure runner tests. The tRPC
 * mock itself lives in each test file (vi.mock is hoisted per file); this
 * module only builds data and a runner wrapper that keeps drafts like the
 * workspace does.
 */
import { useCallback, useState } from 'react';

import { EMPTY_DRAFT, type SopAccess, type StepDraft } from './sop-model';
import { SopRunner } from './sop-runner';

export const BRANCH = 'branch-1';
export const due = new Date('2026-11-04T04:00:00Z');
export const sentBackAt = new Date('2026-11-04T05:00:00Z');
export const REASON = 'The fridge reading is from yesterday. Link today’s reading.';

export function step(overrides: Record<string, unknown> = {}) {
  return {
    id: 'step-1',
    templateStepId: 'tstep-1',
    stepOrder: 1,
    title: 'Confirm the refrigerator temperature was recorded',
    instructions: null,
    requiresPhoto: false,
    requiresNote: false,
    requiresSignature: false,
    requiredRecordType: null,
    temperatureZone: null,
    completed: false,
    completedAt: null,
    completedByName: null,
    note: null,
    ...overrides,
  };
}

export function recordDetail(overrides: Record<string, unknown> = {}) {
  return {
    kind: 'TEMPERATURE_LOG',
    label: 'Vaccine fridge reading',
    value: '9.4 °C',
    location: 'Vaccine fridge',
    recordedAt: new Date('2026-11-04T04:30:00Z'),
    outOfRange: true,
    statusLabel: null,
    ...overrides,
  };
}

export function recordLink(overrides: Record<string, unknown> = {}) {
  return {
    id: 'link-1',
    occurrenceStepId: 'step-1',
    recordType: 'TEMPERATURE_LOG',
    recordId: 'temp-1',
    note: null,
    createdAt: new Date('2026-11-04T04:31:00Z'),
    linkedByStaffProfileId: 'sp',
    detail: recordDetail(),
    createdAfterLatestRejection: false,
    ...overrides,
  };
}

export function evidenceRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'ev-1',
    occurrenceStepId: 'step-1',
    mimeType: 'image/png; evidence=photo',
    sizeBytes: 10,
    storageRef: '/api/files/pharmacy-sop-1-abc.png',
    capturedAt: new Date('2026-11-04T04:20:00Z'),
    uploaderName: 'Asma',
    provenance: 'RECEIPT',
    capturedInPharmacy: true,
    createdAfterLatestRejection: false,
    ...overrides,
  };
}

export function occurrence(overrides: Record<string, unknown> = {}) {
  return {
    id: 'occ-1',
    status: 'IN_PROGRESS',
    businessDate: new Date('2026-11-04T00:00:00Z'),
    dueAt: due,
    windowEndsAt: new Date('2026-11-04T08:00:00Z'),
    startedAt: due,
    claimedAt: null,
    submittedAt: null,
    resolvedAt: null,
    ownerName: 'Asma',
    claimedByName: null,
    overdue: false,
    template: { id: 'tpl', name: 'Pharmacy — temperature log', category: 'Storage' },
    pack: null,
    poolRoleKey: null,
    viewer: { isOwner: true, canClaim: false, canVerify: false },
    steps: [step()],
    evidence: [],
    recordLinks: [],
    rework: { latestRejection: null, notes: [] },
    verifications: [],
    auditTrail: [],
    ...overrides,
  };
}

/** Two done steps, sent back once, started again: the rework state. */
export function reworkOccurrence(overrides: Record<string, unknown> = {}) {
  return occurrence({
    status: 'IN_PROGRESS',
    steps: [
      step({
        requiredRecordType: 'TEMPERATURE_LOG',
        completed: true,
        completedAt: due,
        completedByName: 'Asma',
      }),
      step({
        id: 'step-2',
        templateStepId: 'tstep-2',
        stepOrder: 2,
        title: 'Record any excursion and the corrective action taken, or confirm none',
        requiresNote: true,
        completed: true,
        completedAt: due,
        completedByName: 'Asma',
        note: 'Moved stock to the backup fridge.',
      }),
    ],
    recordLinks: [recordLink()],
    verifications: [
      {
        id: 'ver-1',
        action: 'REJECT',
        reason: REASON,
        createdAt: sentBackAt,
        actorName: 'Bilal',
      },
    ],
    rework: {
      latestRejection: { reason: REASON, createdAt: sentBackAt, reviewerName: 'Bilal' },
      notes: [],
    },
    ...overrides,
  });
}

export const OWNER_ACCESS = {
  canComplete: true,
  canVerify: false,
  canManage: false,
  organizationTimezone: null,
} as unknown as SopAccess;

export const REVIEWER_ACCESS = {
  canComplete: false,
  canVerify: true,
  canManage: false,
  organizationTimezone: null,
} as unknown as SopAccess;

/** The runner with drafts kept in state, as the workspace keeps them. */
export function RunnerHarness({
  access = OWNER_ACCESS,
  from = 'work',
  onBack = () => undefined,
  onNotice = () => undefined,
}: {
  access?: SopAccess;
  from?: 'work' | 'review';
  onBack?: () => void;
  onNotice?: (notice: { tone: 'success' | 'danger'; text: string }) => void;
}) {
  const [drafts, setDrafts] = useState<Record<string, StepDraft>>({});
  const draftFor = useCallback((key: string) => drafts[key] ?? EMPTY_DRAFT, [drafts]);
  const setDraft = useCallback(
    (key: string, patch: Partial<StepDraft>) =>
      setDrafts((current) => ({
        ...current,
        [key]: { ...(current[key] ?? EMPTY_DRAFT), ...patch },
      })),
    []
  );
  const clearDraft = useCallback(
    (key: string) =>
      setDrafts((current) => {
        const next = { ...current };
        delete next[key];
        return next;
      }),
    []
  );
  return (
    <SopRunner
      pharmacyBranchId={BRANCH}
      timezone="Asia/Karachi"
      occurrenceId="occ-1"
      access={access}
      from={from}
      draftFor={draftFor}
      setDraft={setDraft}
      clearDraft={clearDraft}
      onBack={onBack}
      onNotice={onNotice}
    />
  );
}
