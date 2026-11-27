import { createHash, createSign, randomBytes, X509Certificate } from 'node:crypto';

import { normalizeLoyaltyCardCode } from '@/lib/pharmacy/loyalty-card-code';
import { WALLET_ALIAS_PATTERN } from './alias';
import type { AppleWalletCredentials } from './apple-config';

const SERIAL_PATTERN = /^wps_[0-9a-hjkmnp-tv-z]{26}$/;
const TOKEN_PATTERN = /^wpa_[0-9a-hjkmnp-tv-z]{26}(?:\.DFLC[A-Z2-7]{26})?$/;
const MAX_BALANCE = 2_147_483_647;
const CROCKFORD_ALPHABET = '0123456789abcdefghjkmnpqrstvwxyz';

function encode128(bytes: Buffer) {
  const bits = Array.from(bytes, (byte) => byte.toString(2).padStart(8, '0'))
    .join('')
    .padStart(130, '0');
  let value = '';
  for (let index = 0; index < bits.length; index += 5)
    value += CROCKFORD_ALPHABET[Number.parseInt(bits.slice(index, index + 5), 2)];
  return value;
}

export function mintAppleAuthenticationToken() {
  return `wpa_${encode128(randomBytes(16))}`;
}

export function hashAppleAuthenticationToken(token: string) {
  safeString(token, TOKEN_PATTERN, 'pass authentication token');
  return createHash('sha256').update(token).digest('hex');
}

export type ApplePassJson = {
  formatVersion: 1;
  passTypeIdentifier: string;
  serialNumber: string;
  teamIdentifier: string;
  organizationName: 'DevFathom';
  description: string;
  authenticationToken: string;
  webServiceURL: string;
  backgroundColor?: string;
  foregroundColor?: string;
  storeCard: { primaryFields: { key: 'balance'; label: string; value: number }[] };
  barcodes: {
    format: 'PKBarcodeFormatQR';
    message: string;
    messageEncoding: 'iso-8859-1';
    altText: string;
  }[];
};

function safeString(value: string, pattern: RegExp, label: string) {
  if (!pattern.test(value)) throw new Error(`Invalid ${label} for Apple Wallet issuance.`);
  return value;
}

function color(value: string | null | undefined) {
  if (!value) return undefined;
  if (!/^#[0-9a-fA-F]{6}$/.test(value)) throw new Error('Invalid Apple Wallet color.');
  const [r, g, b] = [1, 3, 5].map((index) => Number.parseInt(value.slice(index, index + 2), 16));
  return `rgb(${r}, ${g}, ${b})`;
}

export function buildApplePassJson(input: {
  credentials: Pick<AppleWalletCredentials, 'passTypeIdentifier' | 'teamIdentifier'>;
  serialNumber: string;
  authenticationToken: string;
  alias: string;
  balance: number;
  programDisplayName: string;
  webServiceUrl: string;
  backgroundColor?: string | null;
  foregroundColor?: string | null;
}): ApplePassJson {
  safeString(input.serialNumber, SERIAL_PATTERN, 'pass serial');
  safeString(input.authenticationToken, TOKEN_PATTERN, 'pass authentication token');
  const pharmacy = normalizeLoyaltyCardCode(input.alias) === input.alias;
  if (!pharmacy) safeString(input.alias, WALLET_ALIAS_PATTERN, 'wallet alias');
  if (
    !Number.isInteger(input.balance) ||
    input.balance < (pharmacy ? -MAX_BALANCE : 0) ||
    input.balance > MAX_BALANCE
  )
    throw new Error('Invalid Apple Wallet balance.');
  const name = input.programDisplayName.trim();
  if (!name || name.length > 64) throw new Error('Invalid Apple Wallet program name.');
  const service = new URL(input.webServiceUrl);
  if (service.protocol !== 'https:' && service.hostname !== 'localhost')
    throw new Error('Apple Wallet web service must use HTTPS.');
  return {
    formatVersion: 1,
    passTypeIdentifier: input.credentials.passTypeIdentifier,
    serialNumber: input.serialNumber,
    teamIdentifier: input.credentials.teamIdentifier,
    organizationName: 'DevFathom',
    description: name,
    authenticationToken: input.authenticationToken,
    webServiceURL: service.toString().replace(/\/$/, ''),
    ...(color(input.backgroundColor) ? { backgroundColor: color(input.backgroundColor) } : {}),
    ...(color(input.foregroundColor) ? { foregroundColor: color(input.foregroundColor) } : {}),
    storeCard: { primaryFields: [{ key: 'balance', label: 'Points', value: input.balance }] },
    barcodes: [
      {
        format: 'PKBarcodeFormatQR',
        message: pharmacy ? input.alias : `DFW1:${input.alias}`,
        messageEncoding: 'iso-8859-1',
        altText: input.alias.slice(-4),
      },
    ],
  };
}

const derLength = (length: number) =>
  length < 128
    ? Buffer.from([length])
    : (() => {
        const bytes = [];
        for (let n = length; n; n >>= 8) bytes.unshift(n & 255);
        return Buffer.from([0x80 | bytes.length, ...bytes]);
      })();
const der = (tag: number, ...parts: Buffer[]) => {
  const body = Buffer.concat(parts);
  return Buffer.concat([Buffer.from([tag]), derLength(body.length), body]);
};
const seq = (...p: Buffer[]) => der(0x30, ...p);
const set = (...p: Buffer[]) => der(0x31, ...p);
const oid = (...arcs: number[]) => {
  const out = [arcs[0] * 40 + arcs[1]];
  for (const arc of arcs.slice(2)) {
    const s = [];
    for (let n = arc; ; n >>= 7) {
      s.unshift(n & 127);
      if (n < 128) break;
    }
    for (let i = 0; i < s.length - 1; i++) s[i] |= 128;
    out.push(...s);
  }
  return der(0x06, Buffer.from(out));
};
const integer = (value: number) => der(0x02, Buffer.from([value]));

function readNode(buffer: Buffer, offset = 0): { start: number; header: number; end: number } {
  let cursor = offset + 1;
  let length = buffer[cursor++];
  if (length & 0x80) {
    const count = length & 0x7f;
    length = 0;
    for (let i = 0; i < count; i++) length = length * 256 + buffer[cursor++];
  }
  return { start: offset, header: cursor, end: cursor + length };
}

function issuerAndSerial(cert: Buffer) {
  const root = readNode(cert);
  const tbs = readNode(cert, root.header);
  let at = tbs.header;
  let node = readNode(cert, at);
  if (cert[at] === 0xa0) {
    at = node.end;
    node = readNode(cert, at);
  }
  const serial = cert.subarray(node.start, node.end);
  at = node.end;
  at = readNode(cert, at).end;
  const issuerNode = readNode(cert, at);
  return seq(cert.subarray(issuerNode.start, issuerNode.end), serial);
}

/** Minimal CMS SignedData required by Wallet: detached SHA-1 signature plus signer and WWDR certs. */
export function signManifest(manifest: Buffer, credentials: AppleWalletCredentials): Buffer {
  const signer = new X509Certificate(credentials.passCertificatePem).raw;
  const wwdr = new X509Certificate(credentials.wwdrCertificatePem).raw;
  const signature = createSign('RSA-SHA1').update(manifest).sign(credentials.passPrivateKeyPem);
  const sha1 = seq(oid(1, 3, 14, 3, 2, 26), der(0x05));
  const rsa = seq(oid(1, 2, 840, 113549, 1, 1, 1), der(0x05));
  const signerInfo = seq(integer(1), issuerAndSerial(signer), sha1, rsa, der(0x04, signature));
  const signed = seq(
    integer(1),
    set(sha1),
    seq(oid(1, 2, 840, 113549, 1, 7, 1)),
    der(0xa0, signer, wwdr),
    set(signerInfo)
  );
  return seq(oid(1, 2, 840, 113549, 1, 7, 2), der(0xa0, signed));
}

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(data: Buffer) {
  let c = 0xffffffff;
  for (const byte of data) c = crcTable[(c ^ byte) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function zip(files: Record<string, Buffer>) {
  const locals: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const [name, data] of Object.entries(files)) {
    const n = Buffer.from(name);
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(n.length, 26);
    locals.push(local, n, data);
    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50);
    cen.writeUInt16LE(20, 4);
    cen.writeUInt16LE(20, 6);
    cen.writeUInt32LE(crc, 16);
    cen.writeUInt32LE(data.length, 20);
    cen.writeUInt32LE(data.length, 24);
    cen.writeUInt16LE(n.length, 28);
    cen.writeUInt32LE(offset, 42);
    central.push(cen, n);
    offset += local.length + n.length + data.length;
  }
  const c = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(c.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, c, end]);
}

export function buildPkpass(
  pass: ApplePassJson,
  credentials: AppleWalletCredentials,
  assets: Record<string, Buffer>
): Buffer {
  if (!assets['icon.png']) throw new Error('Apple Wallet pass requires icon.png.');
  const source = { ...assets, 'pass.json': Buffer.from(JSON.stringify(pass)) };
  const manifest = Buffer.from(
    JSON.stringify(
      Object.fromEntries(
        Object.entries(source).map(([name, data]) => [
          name,
          createHash('sha1').update(data).digest('hex'),
        ])
      )
    )
  );
  return zip({
    ...source,
    'manifest.json': manifest,
    signature: signManifest(manifest, credentials),
  });
}
