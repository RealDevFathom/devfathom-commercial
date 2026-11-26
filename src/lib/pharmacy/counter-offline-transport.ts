/**
 * DEV-957 phase 1: the counter browser's calls to `/api/pharmacy/counter/*`.
 *
 * The device credential is the httpOnly cookie the browser attaches by itself;
 * this code never sets an Authorization header and never sees the secret,
 * except in `bindCounterBrowser`, which hands the just-enrolled secret to the
 * server exactly once so it can set that cookie. The terminal session token
 * returned by `establish` is passed in and out, and the caller keeps it in
 * memory only. Same-origin fetches, so the browser sends this site's Origin.
 */

export class CounterRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string
  ) {
    super(code);
    this.name = 'CounterRequestError';
  }
}

async function counterPost(
  path: string,
  body: unknown,
  sessionToken?: string,
  method: 'POST' | 'DELETE' = 'POST'
): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(path, {
      method,
      credentials: 'same-origin',
      cache: 'no-store',
      headers: {
        'content-type': 'application/json',
        ...(sessionToken ? { 'x-terminal-session': sessionToken } : {}),
      },
      body: method === 'POST' ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new CounterRequestError(0, 'offline');
  }
  let parsed: unknown = null;
  try {
    parsed = await response.json();
  } catch {
    parsed = null;
  }
  if (!response.ok) {
    const code =
      parsed &&
      typeof parsed === 'object' &&
      typeof (parsed as { error?: unknown }).error === 'string'
        ? (parsed as { error: string }).error
        : 'unexpected_response';
    throw new CounterRequestError(response.status, code);
  }
  return parsed;
}

export type CounterBinding = {
  device: { id: string; name: string; branchId: string; organizationId: string };
};
export type CounterEstablished = {
  sessionToken: string;
  device: { id: string; branchId: string; organizationId: string };
  snapshotPublicKey: string;
  credential?: { expiresAt: string; expired: boolean; renewDue: boolean };
};
export type CounterSignedSnapshot = {
  id?: string;
  envelope: import('./offline-snapshot-envelope').OfflineSnapshotEnvelope;
  signature: string;
  payload: unknown;
};

// Established in this tab only. The server rechecks the actor, branch and current device key.
let approvalSession: { deviceId: string; sessionToken: string } | undefined;

export function counterApprovalHeaders(
  operations: readonly { type: string; path: string }[]
): Record<string, string> {
  if (
    !approvalSession ||
    !operations.some((op) => op.type === 'mutation' && op.path.startsWith('pharmacySales.'))
  )
    return {};
  return {
    'x-pharmacy-approval-device': approvalSession.deviceId,
    'x-terminal-session': approvalSession.sessionToken,
  };
}

/** Sets the httpOnly device cookie for the secret enrol/rotate just returned. */
export async function bindCounterBrowser(secret: string): Promise<CounterBinding> {
  approvalSession = undefined;
  return (await counterPost('/api/pharmacy/counter/bind', { secret })) as CounterBinding;
}

/** Clears this browser's device cookie. */
export async function unbindCounterBrowser(): Promise<void> {
  approvalSession = undefined;
  await counterPost('/api/pharmacy/counter/bind', null, undefined, 'DELETE');
}

export async function establishCounterSession(): Promise<CounterEstablished> {
  approvalSession = undefined;
  const result = (await counterPost('/api/pharmacy/counter/establish', {})) as CounterEstablished;
  if (!result || typeof result.sessionToken !== 'string' || !result.device)
    throw new CounterRequestError(502, 'unexpected_response');
  approvalSession = { deviceId: result.device.id, sessionToken: result.sessionToken };
  return result;
}

export async function fetchCounterSnapshots(
  sessionToken: string
): Promise<{ snapshots: CounterSignedSnapshot[]; publicKey: string }> {
  const result = (await counterPost('/api/pharmacy/counter/snapshot', {}, sessionToken)) as {
    snapshots?: unknown;
    publicKey?: unknown;
  };
  if (!Array.isArray(result?.snapshots) || typeof result.publicKey !== 'string')
    throw new CounterRequestError(502, 'unexpected_response');
  return { snapshots: result.snapshots as CounterSignedSnapshot[], publicKey: result.publicKey };
}

/**
 * DEV-957 phase 2: rotate this counter's own device secret before it expires. The server
 * sets the new httpOnly cookie and returns the secret once, for the signing key only.
 */
export async function renewCounterCredential(
  sessionToken: string
): Promise<{ secret: string; credentialExpiresAt: string }> {
  const result = (await counterPost('/api/pharmacy/counter/renew', {}, sessionToken)) as {
    secret?: unknown;
    credentialExpiresAt?: unknown;
  };
  if (typeof result?.secret !== 'string' || typeof result.credentialExpiresAt !== 'string')
    throw new CounterRequestError(502, 'unexpected_response');
  return { secret: result.secret, credentialExpiresAt: result.credentialExpiresAt };
}

export function reserveCounterReceipts(sessionToken: string, size: number): Promise<unknown> {
  return counterPost('/api/pharmacy/counter/lease', { size }, sessionToken);
}

export function grantCounterQuota(
  sessionToken: string,
  input: { inventoryLotId: string; stockLocationId: string; units: number }
): Promise<unknown> {
  return counterPost('/api/pharmacy/counter/quota', input, sessionToken);
}

/** One plain sentence for each answer the counter can get while setting up offline mode. */
export function counterSetupMessage(error: unknown): string {
  const code = error instanceof CounterRequestError ? error.code : 'unexpected_response';
  switch (code) {
    case 'offline':
      return 'The server cannot be reached. Offline mode keeps the last price list this counter checked.';
    case 'unauthorized_device':
      return 'The server no longer accepts this computer as a counter. A manager can enrol it again in Settings, Counter computers.';
    case 'device_revoked':
      return 'A manager revoked this counter, so its offline data was deleted from this computer and it can no longer sell offline. A manager can enrol it again in Settings, Counter computers.';
    case 'device_credential_expired':
      return "This counter's credential expired, so it gets no new price list, receipt numbers or stock for offline selling. A manager can renew it in Settings, Counter computers (Rotate credential).";
    case 'unauthorized':
      return 'You are signed out. Sign in again to set up offline mode.';
    case 'forbidden':
    case 'branch_forbidden':
      return 'Your account cannot use the counter at this branch, so offline mode is not set up for you.';
    case 'module_disabled':
      return 'The pharmacy counter is not part of this workspace plan.';
    case 'origin_denied':
      return 'This request did not come from this site, so it was refused.';
    case 'rate_limited':
      return 'Too many counter requests in a minute. Wait a minute, then try again.';
    case 'session_unavailable':
      return 'Offline mode is not configured on this server yet. Ask DevFathom support.';
    case 'QUOTA_EXCEEDS_ON_HAND':
      return 'Another counter already holds that stock, so it was not granted to this one.';
    case 'invalid_terminal_session':
      return 'The counter session ended. Reload the page to start it again.';
    default:
      return 'The server did not accept the request. Nothing was changed on this computer.';
  }
}
