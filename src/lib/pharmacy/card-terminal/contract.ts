import 'server-only';

/**
 * DEV-743 — provider-agnostic pharmacy card-terminal contract.
 *
 * This file is the integration boundary. A future provider adapter (SDK, local
 * device protocol or cloud terminal API) implements `CardTerminalProvider`. No
 * provider is bound in this repository: the admission list below is empty and
 * frozen, so every integrated card path fails closed with UNCERTIFIED_PROVIDER.
 *
 * Card data never crosses this boundary into DevFathom. A provider returns only an
 * opaque provider reference, an approval code, and optionally brand and last four.
 * PAN, CVV, track, PIN and expiry stay on the certified terminal.
 *
 * This is NOT the manual "received externally" card tender (DEV-713, provider
 * `MANUAL_TERMINAL`). That tender records a payment a standalone terminal already
 * took. This seam drives a terminal and owns the outcome of the charge.
 */

export type TerminalCapability = 'SALE' | 'STATUS' | 'VOID' | 'REFUND' | 'SETTLEMENT_REPORT';

export type TerminalOperationKind = 'SALE' | 'VOID' | 'REFUND';

/**
 * A provider's own certification claim. It is informational only: admission is
 * decided by `TerminalAdmission`, never by what the provider says about itself.
 */
export type TerminalCertificationClaim =
  { status: 'UNCERTIFIED' } | { status: 'CLAIMED_CERTIFIED'; evidenceRef: string };

/** What a provider returns for a dispatch or a status query. */
export type TerminalResponse =
  | {
      kind: 'APPROVED';
      providerRef: string;
      amountMinor: number;
      approvalCode?: string;
      cardBrand?: string;
      last4?: string;
    }
  | { kind: 'DECLINED'; declineCode: string }
  /** The terminal accepted the request and the cardholder is still interacting. */
  | { kind: 'PENDING' }
  /** Only from `queryStatus`: the provider confirms it has no record of the operation. */
  | { kind: 'NOT_FOUND' }
  /**
   * The provider reports an error. `reachedTerminal: false` is a positive statement
   * that the request never left DevFathom or was refused before any card prompt. Any
   * other value is treated as an uncertain outcome.
   */
  | { kind: 'ERROR'; code: string; reachedTerminal: false | 'UNKNOWN' };

export type TerminalSaleRequest = {
  /** Stable, unique per operation. The provider must treat it as its idempotency key. */
  operationRef: string;
  terminalId: string;
  amountMinor: number;
  currency: string;
};

export type TerminalReversalRequest = TerminalSaleRequest & {
  /** The provider reference of the approved SALE being voided or refunded. */
  priorProviderRef: string;
};

export type TerminalStatusRequest = {
  operationRef: string;
  terminalId: string;
  kind: TerminalOperationKind;
};

/** One line of a provider settlement or batch report (for reconciliation). */
export type ProviderSettlementRecord = {
  providerRef: string;
  kind: TerminalOperationKind;
  amountMinor: number;
  /** For VOID/REFUND: the SALE they reverse. */
  priorProviderRef?: string;
  operationRef?: string;
};

export interface CardTerminalProvider {
  /** Upper-case provider identifier. Reserved names are refused (see admission). */
  readonly name: string;
  readonly capabilities: readonly TerminalCapability[];
  readonly certification: TerminalCertificationClaim;
  /** Set by mocks and simulators. A simulated provider is never admitted in production. */
  readonly simulated?: true;
  startSale(request: TerminalSaleRequest, signal: AbortSignal): Promise<TerminalResponse>;
  queryStatus(request: TerminalStatusRequest, signal: AbortSignal): Promise<TerminalResponse>;
  voidSale?(request: TerminalReversalRequest, signal: AbortSignal): Promise<TerminalResponse>;
  refundSale?(request: TerminalReversalRequest, signal: AbortSignal): Promise<TerminalResponse>;
  settlementReport?(
    request: { terminalId: string; businessDate: string },
    signal: AbortSignal
  ): Promise<ProviderSettlementRecord[]>;
}

/**
 * Provider names already used by other pharmacy payment paths. A terminal provider
 * may not reuse them, so tenders, refunds and reconciliation can always tell an
 * integrated terminal charge from a manual or sandbox one.
 */
export const RESERVED_PROVIDER_NAMES: readonly string[] = Object.freeze([
  'MOCK',
  'MANUAL_TERMINAL',
  'MANUAL_MERCHANT',
  'LOCAL_TOKEN_SANDBOX',
]);

export type TerminalAdmission = {
  /** Provider names a human approver admitted after certification evidence review. */
  readonly admittedProviders: readonly string[];
};

/**
 * The production admission list. EMPTY BY DESIGN (DEV-743): binding a provider,
 * handling its credentials, touching a real device or claiming certification needs
 * explicit written authorization first. Adding a name here is that binding step and
 * must happen in its own reviewed change, with the certification evidence linked.
 */
export const PRODUCTION_TERMINAL_ADMISSION: TerminalAdmission = Object.freeze({
  // A frozen array, not a Set: Object.freeze does not stop Set.prototype.add.
  admittedProviders: Object.freeze([] as string[]),
});

export type TerminalAdmissionRefusal =
  | 'RESERVED_PROVIDER_NAME'
  | 'INVALID_PROVIDER_NAME'
  | 'SIMULATED_PROVIDER_IN_PRODUCTION'
  | 'NOT_ADMITTED'
  | 'NO_CERTIFICATION_CLAIM';

/**
 * Whether the provider may move real money. A self-declared certification claim is
 * necessary but never sufficient; the name must also be on the admission list.
 *
 * In a production process the built-in list and the real environment always apply,
 * whatever admission or environment a caller passes. Injection exists for tests only.
 */
export function terminalAdmissionRefusal(
  provider: Pick<CardTerminalProvider, 'name' | 'certification' | 'simulated'>,
  requestedAdmission: TerminalAdmission = PRODUCTION_TERMINAL_ADMISSION,
  requestedEnvironment: string | undefined = process.env.NODE_ENV
): TerminalAdmissionRefusal | null {
  const production = process.env.NODE_ENV === 'production';
  const admission = production ? PRODUCTION_TERMINAL_ADMISSION : requestedAdmission;
  const environment = production ? 'production' : requestedEnvironment;
  if (!/^[A-Z][A-Z0-9_]{1,47}$/.test(provider.name)) return 'INVALID_PROVIDER_NAME';
  if (RESERVED_PROVIDER_NAMES.includes(provider.name)) return 'RESERVED_PROVIDER_NAME';
  if (provider.simulated && environment === 'production') return 'SIMULATED_PROVIDER_IN_PRODUCTION';
  if (provider.certification.status !== 'CLAIMED_CERTIFIED') return 'NO_CERTIFICATION_CLAIM';
  if (!admission.admittedProviders.includes(provider.name)) return 'NOT_ADMITTED';
  return null;
}

export function providerSupports(provider: CardTerminalProvider, capability: TerminalCapability) {
  if (!provider.capabilities.includes(capability)) return false;
  if (capability === 'VOID') return typeof provider.voidSale === 'function';
  if (capability === 'REFUND') return typeof provider.refundSale === 'function';
  if (capability === 'SETTLEMENT_REPORT') return typeof provider.settlementReport === 'function';
  return true;
}
