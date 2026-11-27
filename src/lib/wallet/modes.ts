import 'server-only';
import type { AppleWalletCredentials } from './apple-config';
import type { AppleApnsCredentials } from './apple-apns';
import { parseServiceAccount, type GoogleWalletCredentials } from './google-config';

export type WalletRuntime = {
  mode: 'TEST' | 'DEMO' | 'LIVE';
  google?: GoogleWalletCredentials;
  apple?: AppleWalletCredentials;
  apns?: AppleApnsCredentials;
  demoPhones?: string[];
  tokenKey?: string;
};
export function walletRuntime(
  env: Record<string, string | undefined> = process.env
): WalletRuntime {
  const mode = env.WALLET_MODE;
  if (mode !== 'DEMO' && mode !== 'LIVE') return { mode: 'TEST' };
  const issuerId = env['WALLET_GOOGLE_' + mode + '_ISSUER_ID'],
    account = env['WALLET_GOOGLE_' + mode + '_SERVICE_ACCOUNT'];
  let google: GoogleWalletCredentials | undefined;
  if (issuerId && /^\d{10,25}$/.test(issuerId) && account) {
    try {
      const data = parseServiceAccount(account);
      if (data.tokenUri === 'https://oauth2.googleapis.com/token') google = { issuerId, ...data };
    } catch {
      /* Invalid material never reaches diagnostics or the provider. */
    }
  }
  const demoPhones = (env.WALLET_DEMO_TEST_PHONES ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => /^\+[1-9]\d{7,14}$/.test(s));
  if (mode === 'DEMO')
    return google && demoPhones.length ? { mode, google, demoPhones } : { mode: 'TEST' };
  const pem = (key: string) => env[key]?.replace(/\\n/g, '\n');
  const passCertificatePem = pem('WALLET_APPLE_PASS_CERT'),
    passPrivateKeyPem = pem('WALLET_APPLE_PASS_KEY'),
    wwdrCertificatePem = pem('WALLET_APPLE_WWDR_CERT');
  const passTypeIdentifier = env.WALLET_APPLE_PASS_TYPE,
    teamIdentifier = env.WALLET_APPLE_TEAM_ID;
  const tokenKey = env.AUTH_SECRET,
    keyIdentifier = env.WALLET_APPLE_APNS_KEY_ID,
    privateKeyPem = pem('WALLET_APPLE_APNS_KEY');
  if (
    passCertificatePem &&
    passPrivateKeyPem &&
    wwdrCertificatePem &&
    passTypeIdentifier?.startsWith('pass.') &&
    teamIdentifier &&
    /^[A-Z0-9]{10}$/.test(teamIdentifier) &&
    tokenKey &&
    keyIdentifier &&
    privateKeyPem
  ) {
    return {
      mode,
      google,
      tokenKey,
      apple: {
        passCertificatePem,
        passPrivateKeyPem,
        wwdrCertificatePem,
        passTypeIdentifier,
        teamIdentifier,
      },
      apns: { privateKeyPem, keyIdentifier, teamIdentifier, passTypeIdentifier },
    };
  }
  return google ? { mode, google } : { mode: 'TEST' };
}
