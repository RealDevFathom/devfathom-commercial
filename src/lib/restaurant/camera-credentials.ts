import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const VERSION = 'v1';

function keyFromBase64(key: string): Buffer {
  const decoded = Buffer.from(key, 'base64');
  if (decoded.length !== 32) throw new Error('Camera credential key must decode to 32 bytes');
  return decoded;
}

export function sealCameraCredential(value: string, base64Key: string): string {
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', keyFromBase64(base64Key), nonce);
  const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return [
    VERSION,
    nonce.toString('base64url'),
    cipher.getAuthTag().toString('base64url'),
    encrypted.toString('base64url'),
  ].join('.');
}

export function unsealCameraCredential(sealed: string, base64Key: string): string {
  const [version, nonce, tag, encrypted] = sealed.split('.');
  if (version !== VERSION || !nonce || !tag || !encrypted)
    throw new Error('Invalid sealed camera credential');
  const decipher = createDecipheriv(
    'aes-256-gcm',
    keyFromBase64(base64Key),
    Buffer.from(nonce, 'base64url')
  );
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([
    decipher.update(Buffer.from(encrypted, 'base64url')),
    decipher.final(),
  ]).toString('utf8');
}

export function serializeCameraCredentialWrite<T extends { sealedValue?: unknown }>(
  row: T
): Omit<T, 'sealedValue'> {
  const { sealedValue: _sealedValue, ...safe } = row;
  void _sealedValue;
  return safe;
}
