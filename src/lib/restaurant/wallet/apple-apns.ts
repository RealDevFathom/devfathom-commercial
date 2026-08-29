import { createSign } from 'node:crypto';
import { connect, constants } from 'node:http2';

export type AppleApnsCredentials = {
  privateKeyPem: string;
  keyIdentifier: string;
  teamIdentifier: string;
  passTypeIdentifier: string;
};

export class AppleApnsError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
    readonly invalidPushToken: boolean,
    readonly status: number | null = null
  ) {
    super(message);
    this.name = 'AppleApnsError';
  }
}

export type AppleApnsTransport = (input: {
  path: string;
  headers: Record<string, string>;
  body: string;
}) => Promise<{ status: number }>;

const defaultTransport: AppleApnsTransport = ({ path, headers, body }) =>
  new Promise((resolve, reject) => {
    const client = connect('https://api.push.apple.com');
    client.once('error', reject);
    const request = client.request({
      [constants.HTTP2_HEADER_METHOD]: 'POST',
      [constants.HTTP2_HEADER_PATH]: path,
      ...headers,
    });
    request.once('response', (responseHeaders) => {
      const status = Number(responseHeaders[constants.HTTP2_HEADER_STATUS] ?? 500);
      request.resume();
      request.once('end', () => {
        client.close();
        resolve({ status });
      });
    });
    request.once('error', (error) => {
      client.close();
      reject(error);
    });
    request.end(body);
  });

const base64url = (value: Buffer | string) =>
  (typeof value === 'string' ? Buffer.from(value) : value).toString('base64url');

export function buildAppleApnsJwt(credentials: AppleApnsCredentials, now = new Date()) {
  if (
    !/^[A-Z0-9]{10}$/.test(credentials.teamIdentifier) ||
    !/^[A-Z0-9]{10}$/.test(credentials.keyIdentifier)
  )
    throw new AppleApnsError('Apple APNs public issuer identifiers are invalid.', false, false);
  const header = base64url(JSON.stringify({ alg: 'ES256', kid: credentials.keyIdentifier }));
  const claims = base64url(
    JSON.stringify({ iss: credentials.teamIdentifier, iat: Math.floor(now.getTime() / 1000) })
  );
  let signature: Buffer;
  try {
    signature = createSign('SHA256')
      .update(`${header}.${claims}`)
      .sign({ key: credentials.privateKeyPem, dsaEncoding: 'ieee-p1363' });
  } catch {
    throw new AppleApnsError('The Apple APNs signing key is invalid.', false, false);
  }
  return `${header}.${claims}.${base64url(signature)}`;
}

export async function sendApplePassPush(input: {
  credentials: AppleApnsCredentials;
  pushToken: string;
  transport?: AppleApnsTransport;
  now?: Date;
}) {
  if (!/^[A-Za-z0-9_-]{1,256}$/.test(input.pushToken))
    throw new AppleApnsError('The Apple APNs push token is invalid.', false, true);
  const response = await (input.transport ?? defaultTransport)({
    path: `/3/device/${encodeURIComponent(input.pushToken)}`,
    headers: {
      authorization: `bearer ${buildAppleApnsJwt(input.credentials, input.now)}`,
      'apns-topic': input.credentials.passTypeIdentifier,
      'apns-push-type': 'background',
      'content-type': 'application/json',
    },
    body: '{}',
  });
  if (response.status >= 200 && response.status < 300) return;
  const invalid = response.status === 410;
  throw new AppleApnsError(
    `Apple APNs pass update failed with HTTP ${response.status}.`,
    response.status === 429 || response.status >= 500,
    invalid,
    response.status
  );
}
