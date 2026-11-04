import type {
  CardTerminalProvider,
  ProviderSettlementRecord,
  TerminalCapability,
  TerminalResponse,
} from '../contract';

/**
 * TEST ONLY. A scripted, in-process card terminal for the DEV-743 mocked suites.
 * No network, no device, no SDK, no credentials. It is `simulated`, so admission
 * refuses it in production even if someone lists its name.
 *
 * Each dispatch or status call takes the next scripted step for that operation:
 * a response, 'HANG' (never resolves; exercises the timeout) or 'THROW'.
 */
export type ScriptStep = TerminalResponse | 'HANG' | 'THROW';

export function createScriptedTerminal(options: {
  name?: string;
  capabilities?: readonly TerminalCapability[];
  claimCertified?: boolean;
  sale?: ScriptStep[];
  status?: ScriptStep[];
  voidSale?: ScriptStep[];
  refundSale?: ScriptStep[];
  report?: ProviderSettlementRecord[];
}) {
  const queues = {
    sale: [...(options.sale ?? [])],
    status: [...(options.status ?? [])],
    voidSale: [...(options.voidSale ?? [])],
    refundSale: [...(options.refundSale ?? [])],
  };
  const calls: { method: string; request: Record<string, unknown> }[] = [];

  function next(queue: keyof typeof queues, signal: AbortSignal): Promise<TerminalResponse> {
    const step = queues[queue].shift();
    if (step === undefined) return Promise.reject(new Error(`No scripted ${queue} step left.`));
    if (step === 'THROW') return Promise.reject(new Error('Scripted provider failure.'));
    if (step === 'HANG')
      return new Promise((_, reject) => {
        signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      });
    return Promise.resolve(step);
  }

  const capabilities = options.capabilities ?? [
    'SALE',
    'STATUS',
    'VOID',
    'REFUND',
    'SETTLEMENT_REPORT',
  ];

  const provider: CardTerminalProvider = {
    name: options.name ?? 'SCRIPTED_TERMINAL',
    capabilities,
    certification: options.claimCertified
      ? { status: 'CLAIMED_CERTIFIED', evidenceRef: 'test-only-no-real-certification' }
      : { status: 'UNCERTIFIED' },
    simulated: true,
    startSale(request, signal) {
      calls.push({ method: 'startSale', request: { ...request } });
      return next('sale', signal);
    },
    queryStatus(request, signal) {
      calls.push({ method: 'queryStatus', request: { ...request } });
      return next('status', signal);
    },
    voidSale(request, signal) {
      calls.push({ method: 'voidSale', request: { ...request } });
      return next('voidSale', signal);
    },
    refundSale(request, signal) {
      calls.push({ method: 'refundSale', request: { ...request } });
      return next('refundSale', signal);
    },
    async settlementReport(request) {
      calls.push({ method: 'settlementReport', request: { ...request } });
      return structuredClone(options.report ?? []);
    },
  };

  return {
    provider,
    calls,
    count: (method: string) => calls.filter((call) => call.method === method).length,
    push(queue: keyof typeof queues, ...steps: ScriptStep[]) {
      queues[queue].push(...steps);
    },
  };
}

/** Test admission that lists the scripted terminal. Never used outside tests. */
export const TEST_ONLY_ADMISSION = Object.freeze({
  admittedProviders: Object.freeze(['SCRIPTED_TERMINAL']),
});
