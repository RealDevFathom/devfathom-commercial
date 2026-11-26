import { expect } from 'vitest';

const stripRandomTokens = (text: string) =>
  text.replace(/[\w-]{10,}/g, (token) => (/[a-z]/i.test(token) ? '' : token));

const generatedId = /^(?:c[a-z0-9]{24,25}|[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})$/i;
const reviewBranchId = /^ct_branch_review_[a-f0-9]{10}_\d+$/;

// Exempt only a whole generated ID in an ID field, or a known fixture value in its
// expected field. Do not remove ID-looking words from notes, errors or serialized input.
export function expectNoPersistedPin(
  value: unknown,
  pin: string,
  fixtureIds: Readonly<Record<string, readonly string[]>> = {}
): void {
  JSON.parse(JSON.stringify(value), (key: string, field: unknown) => {
    expect(key).not.toMatch(
      /^(?:pin|managerPin|approvingSecret|pinCredential|witnessPin|controlledWitness)$/i
    );
    expect(key).not.toContain(pin);
    expect(field).not.toBe(pin);
    expect(field).not.toBe(Number(pin));
    if (typeof field === 'string') {
      const isGeneratedId = /^(?:id|.*Id)$/.test(key) && generatedId.test(field);
      const isReviewBranchId = key === 'branchId' && reviewBranchId.test(field);
      const isFixtureId = Object.hasOwn(fixtureIds, key) && fixtureIds[key]!.includes(field);
      expect(
        isGeneratedId || isReviewBranchId || isFixtureId ? stripRandomTokens(field) : field
      ).not.toContain(pin);
    }
    return field;
  });
}
