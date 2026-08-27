import { randomBytes } from 'node:crypto';
import { describe, expect, test } from 'vitest';

import {
  sealCameraCredential,
  serializeCameraCredentialWrite,
  unsealCameraCredential,
} from './camera-credentials';

describe('camera credential sealing', () => {
  test('round-trips under authenticated encryption', () => {
    const key = randomBytes(32).toString('base64');
    const sealed = sealCameraCredential('operator:password', key);
    expect(sealed).not.toContain('operator:password');
    expect(unsealCameraCredential(sealed, key)).toBe('operator:password');
  });

  test('sealed material is absent from serialized read shapes', () => {
    const safe = serializeCameraCredentialWrite({
      id: 'cred-1',
      sealedValue: 'ciphertext',
      version: 1,
    });
    expect(JSON.stringify(safe)).not.toContain('ciphertext');
    expect(safe).toEqual({ id: 'cred-1', version: 1 });
  });
});
