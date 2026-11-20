import type { PharmacyCardTerminalAttemptStatus } from '@/generated/prisma/enums';

/**
 * DEV-743: what the counter shows for a card-terminal payment attempt. Client-safe: it carries
 * the attempt's state and truncated card evidence only, never the provider reference, the
 * terminal id or anything a provider returned beyond the brand and last four digits.
 */
export type CardTerminalCounterPhase =
  /** Committed, not yet sent to the terminal. */
  | 'SENDING'
  /** Sent: the cardholder is still at the terminal. */
  | 'PENDING'
  /** No answer, a timeout or an error: the customer may or may not have been charged. */
  | 'UNKNOWN'
  /** Approved, and the payment is being recorded on the bill. */
  | 'RECORDING'
  | 'PAID'
  | 'DECLINED'
  /** Closed before it was sent: nothing was charged. */
  | 'NOT_SENT'
  /** Charged or possibly charged, and a manager or owner must review it. */
  | 'MANUAL_REVIEW'
  | 'REVERSED';

export type CardTerminalCounterView = {
  attemptKey: string;
  phase: CardTerminalCounterPhase;
  amountMinor: number;
  currency: string;
  /** The sale stays held: no other payment may be taken on it. */
  open: boolean;
  /** A status query can move this attempt on (never a new charge). */
  canCheckStatus: boolean;
  statusChecks: number;
  cardBrand: string | null;
  cardLast4: string | null;
  declineCode: string | null;
  reviewReason: string | null;
  /**
   * The terminal reported a charge reference (never shown). A review of such an attempt cannot be
   * recorded as "nothing was charged".
   */
  chargeReported: boolean;
};

/**
 * Whether the signed-in person may resolve this attempt's review (MANUAL_REVIEW only). The server
 * checks again on resolve. `selfResolve`: they took this charge, and nobody else could resolve it
 * at this branch, so the solo rule lets them with their PIN. `askName`: someone who can resolve
 * it, when the person took the charge and may not.
 */
export type CardTerminalReviewAccess = {
  mayResolve: boolean;
  selfResolve: boolean;
  askName: string | null;
};

const PHASES: Record<PharmacyCardTerminalAttemptStatus, CardTerminalCounterPhase> = {
  CREATED: 'SENDING',
  SENT: 'PENDING',
  UNKNOWN: 'UNKNOWN',
  APPROVED: 'RECORDING',
  SETTLED: 'PAID',
  DECLINED: 'DECLINED',
  ABANDONED: 'NOT_SENT',
  MANUAL_REVIEW: 'MANUAL_REVIEW',
  REVERSED: 'REVERSED',
};

const OPEN: readonly PharmacyCardTerminalAttemptStatus[] = [
  'CREATED',
  'SENT',
  'UNKNOWN',
  'APPROVED',
  'MANUAL_REVIEW',
];
/** The states `recoverCardTerminalAttempt` acts on. Manual review waits for a person. */
const CHECKABLE: readonly PharmacyCardTerminalAttemptStatus[] = [
  'CREATED',
  'SENT',
  'UNKNOWN',
  'APPROVED',
];

export function cardTerminalCounterView(attempt: {
  attemptKey: string;
  status: PharmacyCardTerminalAttemptStatus;
  amountMinor: number;
  currency: string;
  statusChecks: number;
  cardBrand: string | null;
  cardLast4: string | null;
  declineCode: string | null;
  reviewReason: string | null;
  providerRef: string | null;
}): CardTerminalCounterView {
  return {
    attemptKey: attempt.attemptKey,
    phase: PHASES[attempt.status],
    amountMinor: attempt.amountMinor,
    currency: attempt.currency,
    open: OPEN.includes(attempt.status),
    canCheckStatus: CHECKABLE.includes(attempt.status),
    statusChecks: attempt.statusChecks,
    cardBrand: attempt.cardBrand,
    cardLast4: attempt.cardLast4,
    declineCode: attempt.declineCode,
    reviewReason: attempt.status === 'MANUAL_REVIEW' ? attempt.reviewReason : null,
    chargeReported: attempt.providerRef !== null,
  };
}
