import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { buildWalletFiles } from './issue';
import { createGoogleWalletClient } from './google';
import { sendApplePassPush } from './apple-apns';
import { cardDesignInput } from './design';
import { issuePharmacyWalletCardPreview } from '../pharmacy/loyalty-wallet-pass';

const privateFields = {
  name: 'Synthetic Shopper',
  phone: '+923000000001',
  purchase: 'receipt-canary',
  medicine: 'medicine-canary',
  health: 'health-canary',
};
const card = {
  ...privateFields,
  alias: 'DFLCABCDEFGHIJKLMNOPQRSTUVWXYZ',
  balance: -2,
  passes: [
    { platform: 'APPLE' as const, serialNumber: 'wps_' + '0'.repeat(26) },
    { platform: 'GOOGLE' as const, serialNumber: 'wps_' + '1'.repeat(26) },
  ],
};
const design = {
  programDisplayName: 'Shop rewards',
  googleClassSuffix: 'wgc_' + '0'.repeat(26),
  backgroundColor: '#223344',
  foregroundColor: '#ffffff',
  logoPng: null,
};
function testGoogle() {
  const key = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey;
  return {
    issuerId: '1234567890123456789',
    clientEmail: 'issuer@example.test',
    privateKey: key.export({ format: 'pem', type: 'pkcs8' }).toString(),
    tokenUri: 'https://oauth2.googleapis.com/token',
  };
}
it('keeps personal fields out of TEST JSON, signed Google objects, balance patches and Apple pushes', async () => {
  const test = (
    await buildWalletFiles({
      card,
      design,
      runtime: { mode: 'TEST' },
      origin: 'https://wallet.example.test',
    })
  ).files;
  expect(test.apple).toHaveProperty('barcodes.0.message', card.alias);
  expect(test.google).toHaveProperty('loyaltyPoints.balance.int', -2);
  const google = testGoogle();
  const transport = vi.fn(async (url: string, req: RequestInit) => {
    if (url.includes('oauth2'))
      return Response.json({ access_token: randomUUID(), expires_in: 3600 });
    return req.method === 'GET' ? new Response(null, { status: 404 }) : Response.json({});
  });
  const live = await buildWalletFiles({
    card,
    design,
    runtime: { mode: 'LIVE', google },
    origin: 'https://wallet.example.test',
    transport,
  });
  const jwt = live.files.googleUrl!.split('/').at(-1)!;
  const claims = JSON.parse(Buffer.from(jwt.split('.')[1]!, 'base64url').toString());
  const object = claims.payload.loyaltyObjects[0];
  expect(Object.keys(object).sort()).toEqual([
    'barcode',
    'classId',
    'id',
    'loyaltyPoints',
    'state',
  ]);
  expect(object.barcode.value).toBe(card.alias);
  const client = createGoogleWalletClient({ credentials: google, transport });
  await client.patchLoyaltyObjectBalance({
    serialNumber: card.passes[1]!.serialNumber,
    balance: -2,
    signedBalance: true,
  });
  expect(JSON.parse(transport.mock.calls.at(-1)![1].body as string)).toEqual({
    loyaltyPoints: { balance: { int: -2 } },
  });
  const appleTransport = vi.fn(async (_request: { body: string }) => ({ status: 200 }));
  await sendApplePassPush({
    credentials: {
      privateKeyPem: generateKeyPairSync('ec', { namedCurve: 'P-256' })
        .privateKey.export({ format: 'pem', type: 'pkcs8' })
        .toString(),
      teamIdentifier: 'TEST000000',
      keyIdentifier: 'TEST000001',
      passTypeIdentifier: 'pass.test.synthetic',
    },
    pushToken: 'synthetic',
    transport: appleTransport,
  });
  expect(appleTransport.mock.calls[0]![0].body).toBe('{}');
  for (const value of Object.values(privateFields))
    expect(
      JSON.stringify([
        test,
        object,
        ...transport.mock.calls
          .filter(([url]) => !url.includes('oauth2'))
          .map(([, init]) => init.body),
      ])
    ).not.toContain(value);
});
it('keeps provider echoes out of diagnostics', async () => {
  const canary = Object.values(privateFields).join('/');
  const client = createGoogleWalletClient({
    credentials: testGoogle(),
    transport: async () => Response.json({ error: { message: canary } }, { status: 403 }),
  });
  const error = await client.getAccessToken().catch((e: Error) => e);
  expect(error).toBeInstanceOf(Error);
  expect((error as Error).message).not.toContain(canary);
});
it('refuses links disguised as programme names and non-design fields', () => {
  const input = {
    programDisplayName: 'shop.example.test',
    backgroundColor: '#000000',
    foregroundColor: '#ffffff',
    enabled: true,
  };
  expect(cardDesignInput.safeParse(input).success).toBe(false);
  for (const key of ['promotion', 'link', 'notificationText'])
    expect(
      cardDesignInput.safeParse({ ...input, programDisplayName: 'Shop', [key]: 'canary' }).success
    ).toBe(false);
});
it('keeps unsigned staff downloads behind the business switch', async () => {
  for (const config of [null, { enabled: false }]) {
    const db = { walletTenantConfig: { findUnique: vi.fn().mockResolvedValue(config) } };
    expect(
      await issuePharmacyWalletCardPreview(db as never, 'synthetic', {
        customerId: 'customer',
        code: card.alias,
      })
    ).toBeUndefined();
  }
});
