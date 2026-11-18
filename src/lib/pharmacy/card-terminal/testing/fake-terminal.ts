import type {
  CardTerminalAdapter,
  TerminalChargeRequest,
  TerminalResponse,
  TerminalStatusRequest,
} from '../contract';

/**
 * DEV-743: a scripted fake terminal for tests. No SDK, no device, no network, no money.
 * It is marked simulated, so admission refuses it in production, and it refuses to be built
 * in a production process at all.
 */

export type ScriptedAnswer =
  | TerminalResponse
  | { kind: 'THROW'; message: string }
  /** Never answers until the caller's signal aborts (a timeout). */
  | { kind: 'HANG' };

export type FakeTerminal = CardTerminalAdapter & {
  readonly charges: TerminalChargeRequest[];
  readonly queries: TerminalStatusRequest[];
  scriptCharge(...answers: ScriptedAnswer[]): void;
  scriptQuery(...answers: ScriptedAnswer[]): void;
};

export function createFakeTerminal(name = 'FAKE_TERMINAL'): FakeTerminal {
  if (process.env.NODE_ENV === 'production')
    throw new Error('The fake card terminal is never available in production.');
  const chargeScript: ScriptedAnswer[] = [];
  const queryScript: ScriptedAnswer[] = [];
  const charges: TerminalChargeRequest[] = [];
  const queries: TerminalStatusRequest[] = [];

  const answer = (script: ScriptedAnswer[], signal: AbortSignal): Promise<TerminalResponse> => {
    const next = script.shift() ?? {
      kind: 'ERROR',
      code: 'UNSCRIPTED',
      reachedTerminal: 'UNKNOWN',
    };
    if (next.kind === 'THROW') return Promise.reject(new Error(next.message));
    if (next.kind === 'HANG')
      return new Promise((_, reject) =>
        signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
      );
    return Promise.resolve(next);
  };

  return {
    name,
    simulated: true,
    charges,
    queries,
    scriptCharge: (...answers) => chargeScript.push(...answers),
    scriptQuery: (...answers) => queryScript.push(...answers),
    startCharge: (request, signal) => {
      charges.push({ ...request });
      return answer(chargeScript, signal);
    },
    queryStatus: (request, signal) => {
      queries.push({ ...request });
      return answer(queryScript, signal);
    },
  };
}
