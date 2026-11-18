/**
 * DEV-743: the provider-neutral pharmacy card-terminal contract.
 *
 * A future provider adapter (SDK, local device protocol or cloud terminal API) implements
 * `CardTerminalAdapter`. No provider or device is chosen in this repository: that waits for a
 * named proposal and a real-device test. The production admission list below is empty and
 * frozen, so every integrated terminal path fails closed with UNCERTIFIED_PROVIDER.
 *
 * Card data never crosses this boundary into DevFathom. An adapter returns only an opaque
 * provider reference, an approval code and, optionally, the brand and last four digits.
 *
 * This is NOT the manual "received externally" Card tender (DEV-713, provider
 * `MANUAL_TERMINAL`) or the manual Wallet tenders. Those record a payment a standalone device
 * already took and never use this contract.
 */

/** What an adapter returns for a charge or a status query. */
export type TerminalResponse =
  | {
      kind: 'APPROVED';
      providerRef: string;
      amountMinor: number;
      approvalCode?: string;
      cardBrand?: string;
      cardLast4?: string;
    }
  | { kind: 'DECLINED'; declineCode: string }
  /** The terminal took the request and the cardholder is still interacting. */
  | { kind: 'PENDING' }
  /** Only from `queryStatus`: the provider has no record of the operation. */
  | { kind: 'NOT_FOUND' }
  /**
   * The provider reports an error. `reachedTerminal: false` positively states the request never
   * left DevFathom or was refused before any card prompt. Anything else is an uncertain outcome.
   */
  | { kind: 'ERROR'; code: string; reachedTerminal: false | 'UNKNOWN' };

export type TerminalChargeRequest = {
  /** Stable and unique per attempt. The provider must use it as its idempotency key. */
  operationRef: string;
  terminalId: string;
  amountMinor: number;
  currency: string;
};

export type TerminalStatusRequest = { operationRef: string; terminalId: string };

export interface CardTerminalAdapter {
  /** Upper-case provider identifier, stored on the attempt and the tender. */
  readonly name: string;
  /** Set by fakes and simulators. A simulated adapter is never admitted in production. */
  readonly simulated?: true;
  startCharge(request: TerminalChargeRequest, signal: AbortSignal): Promise<TerminalResponse>;
  queryStatus(request: TerminalStatusRequest, signal: AbortSignal): Promise<TerminalResponse>;
}

/**
 * Provider names other pharmacy payment paths already use. A terminal adapter may not reuse
 * them, so a terminal tender can always be told apart from manual, sandbox or prepaid tenders.
 * The migration's provider check holds the same list.
 */
export const RESERVED_PROVIDER_NAMES: readonly string[] = Object.freeze([
  'MOCK',
  'MANUAL_TERMINAL',
  'MANUAL_MERCHANT',
  'LOCAL_TOKEN_SANDBOX',
  'CUSTOMER_PREPAID',
]);

export type TerminalAdmission = { readonly admittedProviders: readonly string[] };

/**
 * The production admission list. EMPTY BY DESIGN: binding a provider, handling its credentials,
 * touching a real device or claiming certification needs a named proposal, a real-device test
 * and explicit approval first. Adding a name here is that binding step, in its own reviewed
 * change with the certification evidence linked.
 */
export const PRODUCTION_TERMINAL_ADMISSION: TerminalAdmission = Object.freeze({
  admittedProviders: Object.freeze([] as string[]),
});

export type TerminalAdmissionRefusal =
  | 'INVALID_PROVIDER_NAME'
  | 'RESERVED_PROVIDER_NAME'
  | 'SIMULATED_PROVIDER_IN_PRODUCTION'
  | 'NOT_ADMITTED';

/**
 * Whether the adapter may drive a terminal. A production process always uses the built-in list
 * and the real environment, whatever a caller passes: injection exists for tests only.
 */
export function terminalAdmissionRefusal(
  adapter: Pick<CardTerminalAdapter, 'name' | 'simulated'>,
  requestedAdmission: TerminalAdmission = PRODUCTION_TERMINAL_ADMISSION,
  environment: string | undefined = process.env.NODE_ENV
): TerminalAdmissionRefusal | null {
  const production = process.env.NODE_ENV === 'production' || environment === 'production';
  const admission = production ? PRODUCTION_TERMINAL_ADMISSION : requestedAdmission;
  if (!/^[A-Z][A-Z0-9_]{1,47}$/.test(adapter.name)) return 'INVALID_PROVIDER_NAME';
  if (RESERVED_PROVIDER_NAMES.includes(adapter.name)) return 'RESERVED_PROVIDER_NAME';
  if (adapter.simulated && production) return 'SIMULATED_PROVIDER_IN_PRODUCTION';
  if (!admission.admittedProviders.includes(adapter.name)) return 'NOT_ADMITTED';
  return null;
}
