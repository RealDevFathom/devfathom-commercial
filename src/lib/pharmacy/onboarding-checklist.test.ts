import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { VERTICALS } from '@/lib/vertical-catalog';

import {
  PHARMACY_GATE_GUIDANCE,
  checklistItemForGate,
  pharmacyActivationSummary,
  pharmacyOnboardingChecklist,
} from './onboarding-checklist';
import {
  PHARMACY_ONBOARDING_STEPS,
  evaluateReadiness,
  pharmacyOnboardingStep,
  type PharmacyGateClaim,
  type PharmacyOnboardingGate,
  type PharmacyReadinessEvidence,
} from './onboarding';

const EVIDENCE_BACKED = PHARMACY_ONBOARDING_STEPS.filter((step) => step.evidenceBacked);
const ATTESTED = PHARMACY_ONBOARDING_STEPS.filter((step) => !step.evidenceBacked);

/** A claim that satisfies the attestation rule (evidence reference + actor). */
function attested(gate: PharmacyOnboardingGate): PharmacyGateClaim {
  return {
    gate,
    status: 'PASSED',
    evidenceRef: `board-minute-${gate}`,
    actorId: 'user_1',
    recordedAt: new Date('2026-09-02T00:00:00.000Z'),
  };
}

const ALL_EVIDENCE: PharmacyReadinessEvidence = Object.fromEntries(
  EVIDENCE_BACKED.map((step) => [step.gate, true])
);

describe('pharmacy onboarding checklist', () => {
  it('renders one row per PRD §6.1 step, in walk order, with no gate identifier on show', () => {
    const readiness = evaluateReadiness('org_1', [], {});
    const checklist = pharmacyOnboardingChecklist(readiness);

    expect(checklist.items).toHaveLength(12);
    expect(checklist.items.map((item) => item.step)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12,
    ]);
    for (const item of checklist.items) {
      expect(item.label).toBe(pharmacyOnboardingStep(item.key as PharmacyOnboardingGate).label);
      // No surface prints the enum: neither the label nor the guidance line may
      // contain it (UX rule 1 / "no raw IDs").
      expect(`${item.label} ${item.why}`).not.toContain(item.key);
      expect(item.why.length).toBeGreaterThan(0);
    }
  });

  it('states Needs you with the action, and Done with the evidence, for the same gate', () => {
    const step = pharmacyOnboardingStep('PREMISES_AND_LICENCES');
    const unmet = checklistItemForGate({
      ...step,
      status: 'NOT_STARTED',
      claimedStatus: 'NOT_STARTED',
      evidenceRef: null,
      actorId: null,
      recordedAt: null,
      downgradeReason: null,
    });
    const met = checklistItemForGate({
      ...step,
      status: 'PASSED',
      claimedStatus: 'PASSED',
      evidenceRef: null,
      actorId: null,
      recordedAt: null,
      downgradeReason: null,
    });

    expect(unmet.state).toBe('NEEDS_YOU');
    expect(unmet.why).toBe(PHARMACY_GATE_GUIDANCE.PREMISES_AND_LICENCES.todo);
    expect(unmet.blocksActivation).toBe(true);
    expect(met.state).toBe('DONE');
    expect(met.why).toBe(PHARMACY_GATE_GUIDANCE.PREMISES_AND_LICENCES.done);
    expect(met.blocksActivation).toBe(false);
  });

  it('names an expired licence date in the blocked premises and licences step', () => {
    const readiness = evaluateReadiness('org_1', [], {});
    const checklist = pharmacyOnboardingChecklist(readiness, {
      at: new Date('2026-10-21T00:00:00.000Z'),
      licenceValidTo: new Date('2026-10-20T00:00:00.000Z'),
    });

    expect(checklist.items.find((item) => item.key === 'PREMISES_AND_LICENCES')).toMatchObject({
      state: 'NEEDS_YOU',
      why: 'The branch licence expired on 2026-10-20. Record a current licence on the branch regulatory profile.',
    });
  });

  it('names the date as soon as the licence reaches its exclusive valid-to boundary', () => {
    const readiness = evaluateReadiness('org_1', [], {});
    const checklist = pharmacyOnboardingChecklist(readiness, {
      at: new Date('2026-10-21T00:00:00.000Z'),
      licenceValidTo: new Date('2026-10-21T00:00:00.000Z'),
    });

    expect(checklist.items.find((item) => item.key === 'PREMISES_AND_LICENCES')?.why).toBe(
      'The branch licence expired on 2026-10-21. Record a current licence on the branch regulatory profile.'
    );
  });

  it('tells the operator their own claim did not stand, rather than repeating the to-do', () => {
    // A PASSED claim on an evidence-backed gate the data contradicts.
    const evidenceAbsent = evaluateReadiness('org_1', [attested('MEDICINE_CATALOG_READINESS')], {
      MEDICINE_CATALOG_READINESS: false,
    });
    const row = pharmacyOnboardingChecklist(evidenceAbsent).items.find(
      (item) => item.key === 'MEDICINE_CATALOG_READINESS'
    );
    expect(row?.state).toBe('NEEDS_YOU');
    expect(row?.why).toContain('You marked this done');

    // A PASSED claim on an attested gate with no evidence reference behind it.
    const bareClaim = evaluateReadiness(
      'org_1',
      [{ gate: 'ORG_TYPE', status: 'PASSED', evidenceRef: null, actorId: null }],
      {}
    );
    const bare = pharmacyOnboardingChecklist(bareClaim).items.find(
      (item) => item.key === 'ORG_TYPE'
    );
    expect(bare?.state).toBe('NEEDS_YOU');
    expect(bare?.why).toContain('without an evidence reference');
  });

  it('offers the attestation control only where a claim is what the gate takes', () => {
    const checklist = pharmacyOnboardingChecklist(evaluateReadiness('org_1', [], {}));
    const attestable = checklist.items.filter((item) => item.attestable).map((item) => item.key);
    const derived = checklist.items.filter((item) => !item.attestable).map((item) => item.key);

    expect(attestable).toEqual(ATTESTED.map((step) => step.gate));
    // Offering "mark as done" on a gate the evaluator answers from data would be
    // exactly the seed-can-fake-readiness move PLAT-03 exists to prevent.
    expect(derived).toEqual(EVIDENCE_BACKED.map((step) => step.gate));
  });

  it('links only to pages that exist in this build, and never to a bare identifier', () => {
    const checklist = pharmacyOnboardingChecklist(evaluateReadiness('org_1', [], {}));
    for (const item of checklist.items) {
      // A row either links somewhere real with a label, or links nowhere at all.
      // A half-link (href with no label, or the reverse) renders as a dead end.
      expect(Boolean(item.href)).toBe(Boolean(item.linkLabel));
      if (item.href) expect(item.href.startsWith('/')).toBe(true);
    }
    const licences = checklist.items.find((item) => item.key === 'PREMISES_AND_LICENCES');
    expect(licences?.href).toBe('/pharmacy/regulatory');
  });

  it('counts and blocks from the evaluator, not from a second derivation', () => {
    const claims = ATTESTED.map((step) => attested(step.gate));
    const ready = evaluateReadiness('org_1', claims, ALL_EVIDENCE);
    const checklist = pharmacyOnboardingChecklist(ready);

    expect(checklist.ready).toBe(true);
    expect(checklist.doneCount).toBe(12);
    expect(checklist.totalCount).toBe(12);
    expect(checklist.blocking).toEqual([]);
    expect(pharmacyActivationSummary(checklist)).toBe(
      'Every readiness step is done. This pharmacy can be activated.'
    );
  });

  it('names the blocking steps in the activation sentence, singular and plural', () => {
    const oneShort = evaluateReadiness(
      'org_1',
      ATTESTED.map((step) => attested(step.gate)),
      { ...ALL_EVIDENCE, OPENING_STOCK_READINESS: false }
    );
    const single = pharmacyOnboardingChecklist(oneShort);
    expect(single.blocking.map((item) => item.key)).toEqual(['OPENING_STOCK_READINESS']);
    expect(pharmacyActivationSummary(single)).toBe(
      'Activation is refused until this step is done: Opening stock readiness.'
    );

    const nothingDone = pharmacyOnboardingChecklist(evaluateReadiness('org_1', [], {}));
    const summary = pharmacyActivationSummary(nothingDone);
    expect(summary).toContain('these 12 steps are done');
    // Long lists are truncated so the sentence stays a sentence; the rows
    // beneath it carry the full list.
    expect(summary).toContain('and 9 more');
  });
});

describe('fresh Pharmacy setup destinations', () => {
  it('links stock-location creation without changing branch attestation or readiness', () => {
    const pending = pharmacyOnboardingChecklist(evaluateReadiness('org', [], {})).items.find(
      (item) => item.key === 'BRANCHES_AND_LOCATIONS'
    );
    expect(pending).toMatchObject({
      href: '/pharmacy/inventory',
      linkLabel: 'Create or review stock locations',
      attestable: true,
      state: 'NEEDS_YOU',
      blocksActivation: true,
    });
    const recorded = pharmacyOnboardingChecklist(
      evaluateReadiness('org', [attested('BRANCHES_AND_LOCATIONS')], {})
    ).items.find((item) => item.key === 'BRANCHES_AND_LOCATIONS');
    expect(recorded).toMatchObject({
      href: '/pharmacy/inventory',
      attestable: true,
      state: 'DONE',
      blocksActivation: false,
    });
  });

  it('connects derived catalog, stock and supplier gates without turning them into attestations', () => {
    const items = pharmacyOnboardingChecklist(evaluateReadiness('org', [], {})).items;
    for (const [key, href] of [
      ['MEDICINE_CATALOG_READINESS', '/pharmacy/medicines'],
      ['OPENING_STOCK_READINESS', '/pharmacy/inventory/import'],
      ['PARTIES_AND_BALANCES', '/pharmacy/purchasing/suppliers'],
    ]) {
      expect(items.find((item) => item.key === key)).toMatchObject({
        href,
        attestable: false,
        state: 'NEEDS_YOU',
      });
    }
    expect(VERTICALS.PHARMACY.firstRunChecklist.find((item) => item.key === 'catalog')?.href).toBe(
      '/pharmacy'
    );
  });

  it('offers the existing counter without replacing parallel-run evidence with a click', () => {
    const item = pharmacyOnboardingChecklist(evaluateReadiness('org', [], {})).items.find(
      (row) => row.key === 'READINESS_AND_PARALLEL_RUN'
    );
    expect(item).toMatchObject({
      href: '/pharmacy/counter',
      linkLabel: 'Open pharmacy counter',
      attestable: true,
      state: 'NEEDS_YOU',
      blocksActivation: true,
    });
  });

  it('offers catalog, receiving and canonical setup links from empty inventory', () => {
    const page = readFileSync('src/app/(app)/pharmacy/inventory/page.tsx', 'utf8');
    const empty = page.slice(
      page.indexOf('No available lots yet.'),
      page.indexOf('No available lots yet.') + 1100
    );
    for (const href of ['/pharmacy/medicines', '/pharmacy/purchasing/receiving', '/pharmacy']) {
      expect(empty).toContain(`href="${href}"`);
    }
  });
});
