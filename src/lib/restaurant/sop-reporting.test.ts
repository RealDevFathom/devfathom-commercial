import { describe, expect, it } from 'vitest';
import { summarizeSopReport, type SopReportOccurrence } from './sop-reporting';

const person = (id: string, department: string) => ({
  id,
  displayName: id,
  user: { department },
});

function row(patch: Partial<SopReportOccurrence>): SopReportOccurrence {
  return {
    id: 'occ',
    status: 'VERIFIED',
    dueAt: new Date('2026-08-20T09:00:00Z'),
    windowEndsAt: new Date('2026-08-20T10:00:00Z'),
    submittedAt: new Date('2026-08-20T09:30:00Z'),
    resolvedAt: new Date('2026-08-20T09:45:00Z'),
    assignedStaff: person('direct', 'OPERATIONS'),
    claimedBy: null,
    steps: [{ completed: true, completedBy: person('completer', 'OPERATIONS') }],
    evidence: [{ id: 'proof' }],
    verifications: [{ action: 'VERIFY' }],
    escalationEvents: [],
    ...patch,
  };
}

describe('summarizeSopReport', () => {
  it('reconciles outcomes, timeliness, proof, verification, escalation and score', () => {
    const result = summarizeSopReport([
      row({ id: 'on-time' }),
      row({
        id: 'late',
        resolvedAt: new Date('2026-08-20T10:01:00Z'),
        assignedStaff: null,
        claimedBy: person('claimant', 'SALES'),
        evidence: [],
        escalationEvents: [{ kind: 'FIRED' }],
      }),
      row({ id: 'missed', status: 'MISSED', resolvedAt: new Date('2026-08-20T11:00:00Z') }),
      row({ id: 'waived', status: 'WAIVED', verifications: [{ action: 'WAIVE' }] }),
    ]);

    expect(result).toMatchObject({
      total: 4,
      outcomes: { VERIFIED: 2, MISSED: 1, WAIVED: 1 },
      onTime: 2,
      late: 2,
      withProof: 3,
      verified: 3,
      escalated: 1,
      performanceScore: 56,
    });
    expect(result.attribution).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ staffProfileId: 'direct', owned: 3 }),
        expect.objectContaining({ staffProfileId: 'claimant', owned: 1 }),
        expect.objectContaining({ staffProfileId: 'completer', completed: 4 }),
      ])
    );
  });

  it('returns a zero score for an empty range', () => {
    expect(summarizeSopReport([])).toMatchObject({ total: 0, performanceScore: 0 });
  });
});
