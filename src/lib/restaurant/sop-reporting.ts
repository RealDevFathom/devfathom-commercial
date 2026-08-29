export type SopReportOccurrence = {
  id: string;
  status: string;
  dueAt: Date;
  windowEndsAt: Date;
  submittedAt: Date | null;
  resolvedAt: Date | null;
  assignedStaff: { id: string; displayName: string; user: { department: string } | null } | null;
  claimedBy: { id: string; displayName: string; user: { department: string } | null } | null;
  steps: Array<{
    completed: boolean;
    completedBy: { id: string; displayName: string; user: { department: string } | null } | null;
  }>;
  evidence: Array<{ id: string }>;
  verifications: Array<{ action: string }>;
  escalationEvents: Array<{ kind: string }>;
};

export type SopReportSummary = {
  total: number;
  outcomes: Record<string, number>;
  onTime: number;
  late: number;
  withProof: number;
  verified: number;
  escalated: number;
  performanceScore: number;
  attribution: Array<{
    staffProfileId: string;
    displayName: string;
    department: string | null;
    owned: number;
    completed: number;
  }>;
};

const TERMINAL = new Set(['VERIFIED', 'WAIVED', 'MISSED']);

/** SOP-3-compatible score: terminal outcomes earn 100 on-time, 75 late, 50 waived, 0 missed. */
export function sopPerformancePoints(row: SopReportOccurrence): number {
  if (row.status === 'MISSED') return 0;
  if (row.status === 'WAIVED') return 50;
  if (row.status !== 'VERIFIED') return 0;
  return row.resolvedAt && row.resolvedAt <= row.windowEndsAt ? 100 : 75;
}

export function summarizeSopReport(rows: readonly SopReportOccurrence[]): SopReportSummary {
  const outcomes: Record<string, number> = {};
  const people = new Map<string, SopReportSummary['attribution'][number]>();
  let onTime = 0;
  let late = 0;
  let withProof = 0;
  let verified = 0;
  let escalated = 0;
  let points = 0;

  const touch = (
    person: { id: string; displayName: string; user: { department: string } | null },
    field: 'owned' | 'completed'
  ) => {
    const current = people.get(person.id) ?? {
      staffProfileId: person.id,
      displayName: person.displayName,
      department: person.user?.department ?? null,
      owned: 0,
      completed: 0,
    };
    current[field] += 1;
    people.set(person.id, current);
  };

  for (const row of rows) {
    outcomes[row.status] = (outcomes[row.status] ?? 0) + 1;
    const terminalAt = row.resolvedAt ?? row.submittedAt;
    if (TERMINAL.has(row.status) && terminalAt) {
      if (terminalAt <= row.windowEndsAt) onTime += 1;
      else late += 1;
    }
    if (row.evidence.length > 0) withProof += 1;
    if (row.verifications.some((item) => item.action === 'VERIFY')) verified += 1;
    if (row.escalationEvents.some((item) => item.kind === 'FIRED')) escalated += 1;
    points += sopPerformancePoints(row);

    const owner = row.assignedStaff ?? row.claimedBy;
    if (owner) touch(owner, 'owned');
    const completers = new Map(
      row.steps.flatMap((step) =>
        step.completed && step.completedBy ? [[step.completedBy.id, step.completedBy] as const] : []
      )
    );
    for (const completer of completers.values()) touch(completer, 'completed');
  }

  return {
    total: rows.length,
    outcomes,
    onTime,
    late,
    withProof,
    verified,
    escalated,
    performanceScore: rows.length ? Math.round(points / rows.length) : 0,
    attribution: [...people.values()].sort((a, b) => a.displayName.localeCompare(b.displayName)),
  };
}
