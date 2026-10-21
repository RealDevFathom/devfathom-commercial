/**
 * PLAT-03 — the gate evaluation rules, without a database.
 *
 * What is being pinned here is the *downgrade* behaviour, because that is the
 * whole of the PRD acceptance criterion "seed data cannot fake readiness". The
 * database half — that the downgrade also happens when the claim is a real row
 * and the evidence is a real query — is in `onboarding.db.test.ts`.
 */
import { describe, expect, it } from 'vitest';

import {
  evaluateGate,
  evaluateReadiness,
  pharmacyOnboardingStep,
  PHARMACY_ONBOARDING_STEPS,
  type PharmacyGateClaim,
  type PharmacyOnboardingGate,
} from './onboarding';

const ALL_GATES = PHARMACY_ONBOARDING_STEPS.map((step) => step.gate);

/** A claim recorded properly: status, evidence, actor and time all present. */
function attested(
  gate: PharmacyOnboardingGate,
  status: PharmacyGateClaim['status'] = 'PASSED'
): PharmacyGateClaim {
  return {
    gate,
    status,
    evidenceRef: `evidence://${gate}`,
    actorId: 'user_owner',
    recordedAt: new Date('2026-09-02T00:00:00.000Z'),
  };
}

/** Every evidence-backed gate answered "yes". */
const ALL_EVIDENCE = Object.fromEntries(
  PHARMACY_ONBOARDING_STEPS.filter((step) => step.evidenceBacked).map((step) => [step.gate, true])
);

describe('PLAT-03 onboarding step catalog', () => {
  it('is the twelve steps of PRD §6.1, in order and without gaps', () => {
    expect(PHARMACY_ONBOARDING_STEPS).toHaveLength(12);
    expect(PHARMACY_ONBOARDING_STEPS.map((step) => step.step)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12,
    ]);
    expect(ALL_GATES).toEqual([
      'ORG_TYPE',
      'LEGAL_BUSINESS',
      'LAUNCH_JURISDICTION',
      'PREMISES_AND_LICENCES',
      'BRANCHES_AND_LOCATIONS',
      'COMMERCIAL_PACKAGE',
      'OWNER_AND_ROLE_TEMPLATES',
      'MEDICINE_CATALOG_READINESS',
      'OPENING_STOCK_READINESS',
      'PARTIES_AND_BALANCES',
      'DEVICES_AND_DOCUMENTS',
      'READINESS_AND_PARALLEL_RUN',
    ]);
  });

  it('treats every step as P0, so none of them can be skipped at activation', () => {
    expect(PHARMACY_ONBOARDING_STEPS.every((step) => step.p0)).toBe(true);
  });

  it('marks exactly the six gates that have backing data today', () => {
    expect(
      PHARMACY_ONBOARDING_STEPS.filter((step) => step.evidenceBacked).map((step) => step.gate)
    ).toEqual([
      'PREMISES_AND_LICENCES',
      'COMMERCIAL_PACKAGE',
      'OWNER_AND_ROLE_TEMPLATES',
      'MEDICINE_CATALOG_READINESS',
      'OPENING_STOCK_READINESS',
      'PARTIES_AND_BALANCES',
    ]);
  });

  it('rejects an unknown gate rather than treating it as a passing step', () => {
    expect(() => pharmacyOnboardingStep('NOT_A_GATE' as PharmacyOnboardingGate)).toThrow(
      /Unknown pharmacy onboarding gate/
    );
  });
});

describe('PLAT-03 evaluateGate — evidence-backed gates', () => {
  const step = pharmacyOnboardingStep('OPENING_STOCK_READINESS');

  it('passes on the evidence alone, with no claim recorded at all', () => {
    const result = evaluateGate(step, undefined, true);
    expect(result.status).toBe('PASSED');
    expect(result.claimedStatus).toBe('NOT_STARTED');
    expect(result.downgradeReason).toBeNull();
  });

  it('downgrades a PASSED claim the evidence contradicts to FAILED', () => {
    const result = evaluateGate(step, attested('OPENING_STOCK_READINESS'), false);
    expect(result.status).toBe('FAILED');
    expect(result.claimedStatus).toBe('PASSED');
    expect(result.downgradeReason).toBe('EVIDENCE_ABSENT');
  });

  it('downgrades a fully attested PASSED claim too — attestation is not evidence', () => {
    // The claim carries an evidence reference, an actor and a time, which is
    // everything an attested gate needs. It is still refused, because for this
    // gate the platform can check, and the check says no.
    const result = evaluateGate(step, attested('OPENING_STOCK_READINESS'), false);
    expect(result.status).toBe('FAILED');
  });

  it('leaves a not-yet-claimed gate alone rather than inventing a failure', () => {
    const result = evaluateGate(step, { gate: step.gate, status: 'IN_PROGRESS' }, false);
    expect(result.status).toBe('IN_PROGRESS');
    expect(result.downgradeReason).toBeNull();
  });

  it('treats a missing evidence answer as "not satisfied", never as "assume yes"', () => {
    expect(evaluateGate(step, attested('OPENING_STOCK_READINESS'), null).status).toBe('FAILED');
  });
});

describe('PLAT-03 evaluateGate — attested gates', () => {
  const step = pharmacyOnboardingStep('LEGAL_BUSINESS');

  it('accepts a PASSED claim that names its evidence and its actor', () => {
    const result = evaluateGate(step, attested('LEGAL_BUSINESS'), null);
    expect(result.status).toBe('PASSED');
    expect(result.downgradeReason).toBeNull();
  });

  it('refuses a bare seeded PASSED with no evidence reference', () => {
    const result = evaluateGate(
      step,
      { gate: 'LEGAL_BUSINESS', status: 'PASSED', actorId: 'seed', recordedAt: new Date() },
      null
    );
    expect(result.status).toBe('NOT_STARTED');
    expect(result.downgradeReason).toBe('ATTESTATION_INCOMPLETE');
  });

  it('refuses a PASSED whose evidence reference is only whitespace', () => {
    const result = evaluateGate(
      step,
      {
        gate: 'LEGAL_BUSINESS',
        status: 'PASSED',
        evidenceRef: '   ',
        actorId: 'seed',
        recordedAt: new Date(),
      },
      null
    );
    expect(result.status).toBe('NOT_STARTED');
    expect(result.downgradeReason).toBe('ATTESTATION_INCOMPLETE');
  });

  it('refuses a PASSED with evidence but no actor', () => {
    const result = evaluateGate(
      step,
      { gate: 'LEGAL_BUSINESS', status: 'PASSED', evidenceRef: 'file://x', recordedAt: new Date() },
      null
    );
    expect(result.status).toBe('NOT_STARTED');
    expect(result.downgradeReason).toBe('ATTESTATION_INCOMPLETE');
  });

  it('keeps a FAILED claim as FAILED — the downgrade rule never upgrades', () => {
    expect(evaluateGate(step, attested('LEGAL_BUSINESS', 'FAILED'), null).status).toBe('FAILED');
  });
});

describe('PLAT-03 evaluateReadiness', () => {
  it('is not ready on an organization with nothing recorded, and says so gate by gate', () => {
    const readiness = evaluateReadiness('org_1', [], {});
    expect(readiness.ready).toBe(false);
    expect(readiness.blocking).toEqual(ALL_GATES);
    expect(readiness.gates.every((gate) => gate.status === 'NOT_STARTED')).toBe(true);
  });

  it('is ready only when every P0 gate passes', () => {
    const claims = ALL_GATES.map((gate) => attested(gate));
    const readiness = evaluateReadiness('org_1', claims, ALL_EVIDENCE);
    expect(readiness.blocking).toEqual([]);
    expect(readiness.ready).toBe(true);
  });

  it('refuses readiness when one evidence-backed gate loses its data', () => {
    const claims = ALL_GATES.map((gate) => attested(gate));
    const readiness = evaluateReadiness('org_1', claims, {
      ...ALL_EVIDENCE,
      PARTIES_AND_BALANCES: false,
    });
    expect(readiness.ready).toBe(false);
    expect(readiness.blocking).toEqual(['PARTIES_AND_BALANCES']);
    const gate = readiness.gates.find((one) => one.gate === 'PARTIES_AND_BALANCES')!;
    expect(gate.status).toBe('FAILED');
    expect(gate.downgradeReason).toBe('EVIDENCE_ABSENT');
  });

  it('cannot be reached by seeding every gate PASSED with no evidence at all', () => {
    // The shape a bulk seed or a bootstrap script would produce: twelve rows,
    // status PASSED, nothing else. None of it counts.
    const seeded = ALL_GATES.map((gate) => ({ gate, status: 'PASSED' as const }));
    const readiness = evaluateReadiness('org_1', seeded, {});
    expect(readiness.ready).toBe(false);
    expect(readiness.blocking).toEqual(ALL_GATES);
    expect(readiness.gates.filter((gate) => gate.status === 'PASSED')).toEqual([]);
  });

  it('reports blocking gates in walk order, so the operator is told where to resume', () => {
    const readiness = evaluateReadiness('org_1', [attested('ORG_TYPE')], {
      COMMERCIAL_PACKAGE: true,
    });
    expect(readiness.blocking[0]).toBe('LEGAL_BUSINESS');
    expect(readiness.blocking).not.toContain('ORG_TYPE');
    expect(readiness.blocking).not.toContain('COMMERCIAL_PACKAGE');
  });
});
