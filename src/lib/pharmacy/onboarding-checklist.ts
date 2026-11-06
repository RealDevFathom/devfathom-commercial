/**
 * PLAT-03 presentation contract — turns the twelve evaluated readiness gates of
 * {@link ./onboarding} into the checklist an operator reads on the pharmacy
 * workspace home, and into the sentence the activation status panel shows.
 *
 * Kept separate from the evaluator, and pure, for three reasons:
 *
 * - the evaluator answers "is this gate satisfied", which is a regulated
 *   question; this module answers "what should the operator do next", which is a
 *   product question, and the two must be free to change independently;
 * - UX rule 13 requires a precondition to be a checklist of rows with links,
 *   never one sentence, so the copy that names the fix lives beside the gate it
 *   belongs to rather than inside a page; and
 * - the rendering component is shared with the restaurant vertical (WHA-1195),
 *   so it must be handed already-resolved rows and never reach for a gate enum.
 *
 * On links: a row links only to a surface that exists in this build. UX rule 12
 * forbids dead ends, and a link into a 404 is a worse dead end than a row that
 * states plainly who delivers the step. Gates whose console has not shipped
 * therefore carry `href: null` and a `why` that names the next action.
 */
import type { PharmacyGateResult, PharmacyOnboardingGate, PharmacyReadiness } from './onboarding';

/**
 * A checklist row's disposition, in the operator's language rather than the
 * evaluator's.
 *
 * `OPTIONAL` never occurs for pharmacy — every PRD §6.1 step is P0 — but the
 * shared component renders all three, so the mapping states it explicitly
 * instead of leaving the restaurant reuse to rediscover it.
 */
export type ReadinessChecklistState = 'DONE' | 'NEEDS_YOU' | 'OPTIONAL';

export type ReadinessChecklistItem = {
  /** Stable row identity for keys, anchors and test locators. Not shown. */
  key: string;
  /** 1-based position in the onboarding walk. */
  step: number;
  label: string;
  state: ReadinessChecklistState;
  /** One line: how it was satisfied, or exactly what to do next. */
  why: string;
  /** The page that clears this step, when one exists in this build. */
  href: string | null;
  linkLabel: string | null;
  /** True when leaving this row unresolved refuses activation. */
  blocksActivation: boolean;
  /**
   * True when the operator may clear this row by recording an attestation on
   * the checklist itself — the gates with no backing surface to derive from.
   */
  attestable: boolean;
};

type GateGuidance = {
  /** Shown while the gate is unsatisfied. Names the action, not the state. */
  todo: string;
  /** Shown once the gate is satisfied. Names the evidence, not "OK". */
  done: string;
  href: string | null;
  linkLabel: string | null;
};

/**
 * One line of guidance per gate. Wording rules: name the action and where it
 * happens, never an identifier (UX rule 1), and never the gate enum (UX rule:
 * no raw IDs).
 */
export const PHARMACY_GATE_GUIDANCE: Record<PharmacyOnboardingGate, GateGuidance> = {
  ORG_TYPE: {
    todo: 'Confirm this workspace operates as a pharmacy, and record where that decision is written down.',
    done: 'Recorded as a pharmacy workspace.',
    href: null,
    linkLabel: null,
  },
  LEGAL_BUSINESS: {
    todo: 'Confirm the registered legal name and business details on the organization page, then record the reference.',
    done: 'Legal business details confirmed.',
    href: '/organization',
    linkLabel: 'Open organization',
  },
  LAUNCH_JURISDICTION: {
    todo: 'Choose the province you are launching in on the branch regulatory profile, then record the decision.',
    done: 'Launch province recorded.',
    href: '/pharmacy/regulatory',
    linkLabel: 'Open regulatory profile',
  },
  PREMISES_AND_LICENCES: {
    todo: 'Add a branch regulatory profile with a valid licence and a qualified person whose cover is in date.',
    done: 'A branch holds a licence and qualified-person cover that are valid today.',
    href: '/pharmacy/regulatory',
    linkLabel: 'Open regulatory profile',
  },
  BRANCHES_AND_LOCATIONS: {
    todo: 'Record that every branch and its stock locations exist, naming where the layout is documented.',
    done: 'Branches and stock locations recorded.',
    href: '/pharmacy/inventory',
    linkLabel: 'Create or review stock locations',
  },
  COMMERCIAL_PACKAGE: {
    todo: 'This workspace has no pharmacy package. Your DevFathom account manager assigns it; the platform team cannot be replaced by a setting here.',
    done: 'A pharmacy package is assigned to this workspace.',
    href: null,
    linkLabel: null,
  },
  OWNER_AND_ROLE_TEMPLATES: {
    todo: 'The pharmacy role templates are missing. They are created with the workspace, so ask your DevFathom account manager to re-run provisioning.',
    done: 'Owner and the pharmacy role templates are in place.',
    href: '/organization',
    linkLabel: 'Open organization',
  },
  MEDICINE_CATALOG_READINESS: {
    todo: 'Publish a medicine, then attach the barcode printed on its pack so opening stock can be imported by barcode.',
    done: 'A published medicine has a pack with a barcode.',
    href: '/pharmacy/medicines',
    linkLabel: 'Set up medicines and packs',
  },
  OPENING_STOCK_READINESS: {
    todo: 'Receive opening stock against at least one lot, so the ledger starts from a counted position.',
    done: 'Opening stock has been received into the ledger.',
    href: '/pharmacy/purchasing/receiving',
    linkLabel: 'Receive opening stock',
  },
  PARTIES_AND_BALANCES: {
    todo: 'Add at least one authorized, active supplier so purchasing and returns have a counterparty.',
    done: 'An authorized supplier is on file.',
    href: '/pharmacy/purchasing/suppliers',
    linkLabel: 'Set up suppliers',
  },
  DEVICES_AND_DOCUMENTS: {
    todo: 'Record the counters, printers and document templates this pharmacy will use, naming where they are listed.',
    done: 'Devices and document templates recorded.',
    href: null,
    linkLabel: null,
  },
  READINESS_AND_PARALLEL_RUN: {
    todo: 'Record the parallel-run result that shows the pharmacy is ready to go live.',
    done: 'Parallel run recorded as complete.',
    href: '/pharmacy/counter',
    linkLabel: 'Open pharmacy counter',
  },
};

/**
 * Why an operator's recorded PASSED did not stand. Shown instead of the plain
 * to-do line, because "you already ticked this" is the thing they need told.
 */
const DOWNGRADE_COPY: Record<NonNullable<PharmacyGateResult['downgradeReason']>, string> = {
  EVIDENCE_ABSENT:
    'You marked this done, but the underlying records do not show it yet, so it still counts as outstanding.',
  ATTESTATION_INCOMPLETE:
    'You marked this done without an evidence reference, so it still counts as outstanding. Record one below.',
};

export function checklistItemForGate(gate: PharmacyGateResult): ReadinessChecklistItem {
  const guidance = PHARMACY_GATE_GUIDANCE[gate.gate];
  const done = gate.status === 'PASSED';
  return {
    key: gate.gate,
    step: gate.step,
    label: gate.label,
    state: done ? 'DONE' : gate.p0 ? 'NEEDS_YOU' : 'OPTIONAL',
    why: done
      ? guidance.done
      : gate.downgradeReason
        ? DOWNGRADE_COPY[gate.downgradeReason]
        : guidance.todo,
    href: guidance.href,
    linkLabel: guidance.linkLabel,
    blocksActivation: gate.p0 && !done,
    // An evidence-backed gate is never attestable: recording a claim against it
    // is exactly the "seed data cannot fake readiness" move the evaluator
    // downgrades, so the surface must not offer it in the first place.
    attestable: !gate.evidenceBacked,
  };
}

export type PharmacyOnboardingChecklist = {
  items: readonly ReadinessChecklistItem[];
  doneCount: number;
  totalCount: number;
  /** Rows that refuse activation while they stand, in walk order. */
  blocking: readonly ReadinessChecklistItem[];
  ready: boolean;
};

export type PharmacyChecklistContext = {
  /** The end of the effective branch licence, when one is currently on file. */
  licenceValidTo?: Date | null;
  /** Shared clock for the evaluator and its explanatory copy. */
  at?: Date;
};

export function pharmacyOnboardingChecklist(
  readiness: PharmacyReadiness,
  context: PharmacyChecklistContext = {}
): PharmacyOnboardingChecklist {
  const items = readiness.gates.map((gate) => {
    const item = checklistItemForGate(gate);
    const at = context.at ?? new Date();
    if (
      gate.gate === 'PREMISES_AND_LICENCES' &&
      gate.status !== 'PASSED' &&
      context.licenceValidTo &&
      at >= context.licenceValidTo
    ) {
      return {
        ...item,
        why: `The branch licence expired on ${context.licenceValidTo.toISOString().slice(0, 10)}. Record a current licence on the branch regulatory profile.`,
      };
    }
    return item;
  });
  const blocking = items.filter((item) => item.blocksActivation);
  return {
    items,
    doneCount: items.filter((item) => item.state === 'DONE').length,
    totalCount: items.length,
    blocking,
    // Taken from the evaluator, not recomputed from the rows: readiness is its
    // answer to give, and a second derivation here could disagree with the one
    // activation actually enforces.
    ready: readiness.ready,
  };
}

/**
 * The activation status sentence, built from the same rows the checklist shows.
 *
 * Deliberately says how many steps block and names them; the panel renders the
 * rows themselves beneath it, per UX rule 13.
 */
export function pharmacyActivationSummary(checklist: PharmacyOnboardingChecklist): string {
  if (checklist.ready) {
    return 'Every readiness step is done. This pharmacy can be activated.';
  }
  const count = checklist.blocking.length;
  const names = checklist.blocking.map((item) => item.label);
  const listed =
    names.length > 3
      ? `${names.slice(0, 3).join(', ')} and ${names.length - 3} more`
      : names.join(', ');
  return `Activation is refused until ${count === 1 ? 'this step is' : `these ${count} steps are`} done: ${listed}.`;
}
