import 'server-only';

import { createHash, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { withPlatformDb, withTenantDb } from '@/lib/tenancy/scoped-db';
import { consumeBoundedBody, readBoundedJson } from '@/lib/http/read-bounded-body';
import { clientIp, rateLimit } from '@/lib/rate-limit';
import { loyaltyBalance } from '@/lib/restaurant/loyalty';
import { walletAliasFingerprint } from './alias';
import { APPLE_WALLET_SETTING_KEYS, loadAppleWalletCredentials } from './apple-config';
import { buildApplePassJson, buildPkpass } from './apple-pass';

const EMPTY_401 = () => new Response(null, { status: 401 });
const EMPTY_200 = () => new Response(null, { status: 200 });
const ID_PATTERN = /^[A-Za-z0-9._-]{1,256}$/;

function equalHash(token: string, expected: string) {
  const actual = Buffer.from(createHash('sha256').update(token).digest('hex'));
  const wanted = Buffer.from(expected);
  return actual.length === wanted.length && timingSafeEqual(actual, wanted);
}

function authToken(request: Request) {
  const value = request.headers.get('authorization') ?? '';
  return value.startsWith('ApplePass ') ? value.slice('ApplePass '.length) : null;
}

async function platformPass(serialNumber: string) {
  if (!ID_PATTERN.test(serialNumber)) return null;
  return withPlatformDb((db) =>
    db.walletPass.findUnique({
      where: { serialNumber },
      select: {
        id: true,
        organizationId: true,
        loyaltyAccountId: true,
        customerId: true,
        appleAuthTokenHash: true,
        status: true,
        contentRevision: true,
        updatedAt: true,
      },
    })
  );
}

async function authenticate(request: Request, passTypeIdentifier: string, serialNumber: string) {
  const pass = await platformPass(serialNumber);
  const token = authToken(request);
  if (!pass || !token || !pass.appleAuthTokenHash || pass.status !== 'ACTIVE') return null;
  const configured = await withPlatformDb((db) =>
    db.platformSetting.findUnique({ where: { key: APPLE_WALLET_SETTING_KEYS.passTypeIdentifier } })
  );
  if (configured?.value !== passTypeIdentifier || !equalHash(token, pass.appleAuthTokenHash))
    return null;
  return { pass, token };
}

function admitted(request: Request, serialNumber?: string) {
  return Promise.all([
    rateLimit(`wallet-apple:ip:${clientIp(request)}`, 120, 60_000),
    serialNumber
      ? rateLimit(`wallet-apple:serial:${walletAliasFingerprint(serialNumber)}`, 60, 60_000)
      : Promise.resolve({ ok: true, retryAfter: 0, remaining: 0 }),
  ]).then(([ip, serial]) => {
    const blocked = !ip.ok ? ip : !serial.ok ? serial : null;
    return blocked
      ? new Response(null, { status: 429, headers: { 'Retry-After': String(blocked.retryAfter) } })
      : null;
  });
}

export async function registerApplePass(
  request: Request,
  input: { deviceLibraryIdentifier: string; passTypeIdentifier: string; serialNumber: string }
) {
  const limited = await admitted(request, input.serialNumber);
  if (limited) return limited;
  if (!ID_PATTERN.test(input.deviceLibraryIdentifier)) return EMPTY_401();
  const authenticated = await authenticate(request, input.passTypeIdentifier, input.serialNumber);
  if (!authenticated) return EMPTY_401();
  const inputBody = await readBoundedJson(request, 2 * 1024).catch(() => null);
  if (inputBody?.tooLarge) return new Response(null, { status: 413 });
  const body = inputBody?.value as { pushToken?: unknown } | null | undefined;
  if (!body || typeof body.pushToken !== 'string' || !ID_PATTERN.test(body.pushToken))
    return new Response(null, { status: 400 });
  const created = await withTenantDb(authenticated.pass.organizationId, async (db) => {
    const existing = await db.walletPassRegistration.findUnique({
      where: {
        passId_deviceLibraryIdentifier: {
          passId: authenticated.pass.id,
          deviceLibraryIdentifier: input.deviceLibraryIdentifier,
        },
      },
      select: { id: true },
    });
    await db.walletPassRegistration.upsert({
      where: {
        passId_deviceLibraryIdentifier: {
          passId: authenticated.pass.id,
          deviceLibraryIdentifier: input.deviceLibraryIdentifier,
        },
      },
      create: {
        passId: authenticated.pass.id,
        deviceLibraryIdentifier: input.deviceLibraryIdentifier,
        pushToken: body.pushToken as string,
      },
      update: { pushToken: body.pushToken as string },
    });
    return !existing;
  });
  return new Response(null, { status: created ? 201 : 200 });
}

export async function unregisterApplePass(
  request: Request,
  input: { deviceLibraryIdentifier: string; passTypeIdentifier: string; serialNumber: string }
) {
  const limited = await admitted(request, input.serialNumber);
  if (limited) return limited;
  const authenticated = await authenticate(request, input.passTypeIdentifier, input.serialNumber);
  if (!authenticated) return EMPTY_401();
  await withTenantDb(authenticated.pass.organizationId, (db) =>
    db.walletPassRegistration.deleteMany({
      where: {
        passId: authenticated.pass.id,
        deviceLibraryIdentifier: input.deviceLibraryIdentifier,
      },
    })
  );
  return EMPTY_200();
}

export async function listUpdatedApplePasses(
  request: Request,
  input: { deviceLibraryIdentifier: string; passTypeIdentifier: string }
) {
  const limited = await admitted(request);
  if (limited) return limited;
  if (!ID_PATTERN.test(input.deviceLibraryIdentifier)) return new Response(null, { status: 204 });
  const configured = await withPlatformDb((db) =>
    db.platformSetting.findUnique({ where: { key: APPLE_WALLET_SETTING_KEYS.passTypeIdentifier } })
  );
  if (configured?.value !== input.passTypeIdentifier) return new Response(null, { status: 204 });
  const sinceRaw = new URL(request.url).searchParams.get('passesUpdatedSince');
  const since = sinceRaw === null ? -1 : Number.parseInt(sinceRaw, 10);
  if (!Number.isInteger(since)) return new Response(null, { status: 400 });
  const registrations = await withPlatformDb((db) =>
    db.walletPassRegistration.findMany({
      where: {
        deviceLibraryIdentifier: input.deviceLibraryIdentifier,
        pass: { platform: 'APPLE', status: 'ACTIVE', contentRevision: { gt: since } },
      },
      select: { pass: { select: { serialNumber: true, contentRevision: true } } },
    })
  );
  if (!registrations.length) return new Response(null, { status: 204 });
  const lastUpdated = String(Math.max(...registrations.map(({ pass }) => pass.contentRevision)));
  return Response.json({
    serialNumbers: registrations.map(({ pass }) => pass.serialNumber),
    lastUpdated,
  });
}

export async function sendUpdatedApplePass(
  request: Request,
  input: { passTypeIdentifier: string; serialNumber: string }
) {
  const limited = await admitted(request, input.serialNumber);
  if (limited) return limited;
  const authenticated = await authenticate(request, input.passTypeIdentifier, input.serialNumber);
  if (!authenticated) return EMPTY_401();
  const modified = request.headers.get('if-modified-since');
  if (
    modified &&
    new Date(modified).getTime() >= Math.floor(authenticated.pass.updatedAt.getTime() / 1000) * 1000
  )
    return new Response(null, { status: 304 });
  const [credentials, projection] = await Promise.all([
    loadAppleWalletCredentials({
      readSetting: (key) =>
        withPlatformDb((db) => db.platformSetting.findUnique({ where: { key } })),
    }),
    withTenantDb(authenticated.pass.organizationId, async (db) => {
      const [config, alias, balance] = await Promise.all([
        db.walletTenantConfig.findUnique({
          where: { organizationId: authenticated.pass.organizationId },
        }),
        db.customerIdentifier.findFirst({
          where: { customerId: authenticated.pass.customerId, kind: 'WALLET' },
          select: { normalizedValue: true },
        }),
        loyaltyBalance(db, authenticated.pass.loyaltyAccountId),
      ]);
      return { config, alias: alias?.normalizedValue, balance };
    }),
  ]);
  if (!projection.config || !projection.alias) return EMPTY_401();
  const passJson = buildApplePassJson({
    credentials,
    serialNumber: input.serialNumber,
    authenticationToken: authenticated.token,
    alias: projection.alias,
    balance: projection.balance,
    programDisplayName: projection.config.programDisplayName,
    webServiceUrl: `https://wallet.${process.env.PLATFORM_BASE_DOMAIN}/api/wallet/apple`,
    backgroundColor: projection.config.backgroundColor,
    foregroundColor: projection.config.foregroundColor,
  });
  const icon = await readFile(path.join(process.cwd(), 'public/favicon.png'));
  const archive = buildPkpass(passJson, credentials, { 'icon.png': icon });
  return new Response(new Uint8Array(archive), {
    headers: {
      'Content-Type': 'application/vnd.apple.pkpass',
      'Last-Modified': authenticated.pass.updatedAt.toUTCString(),
      'Cache-Control': 'no-store',
    },
  });
}

export async function acceptAppleLogs(request: Request) {
  const gate = await rateLimit(`wallet-apple:log:ip:${clientIp(request)}`, 600, 60_000);
  if (!gate.ok) {
    return new Response(null, { status: 429, headers: { 'Retry-After': String(gate.retryAfter) } });
  }
  // Apple log entries can echo pass payloads. Never retain or reflect the body.
  const withinLimit = await consumeBoundedBody(request, 64_000).catch(() => true);
  if (!withinLimit) return new Response(null, { status: 413 });
  return EMPTY_200();
}
