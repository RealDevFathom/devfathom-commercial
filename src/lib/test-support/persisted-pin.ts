import { expect } from 'vitest';

// Audit rows can contain generated IDs with these digits. Check every serialized field and
// reject credential keys as well, even if a credential was written with a different value.
export function expectNoPersistedPin(value: unknown, pin: string): void {
  JSON.parse(JSON.stringify(value), (key: string, field: unknown) => {
    expect(key).not.toMatch(
      /^(?:pin|managerPin|approvingSecret|pinCredential|witnessPin|controlledWitness)$/i
    );
    expect(field).not.toBe(pin);
    expect(field).not.toBe(Number(pin));
    return field;
  });
}
