/**
 * In-memory stand-in for the one statement `authenticateOperator` uses to charge
 * a PIN/badge attempt (DEV-1055): the atomic `UPDATE restaurant_operator_credentials
 * … RETURNING id`. Unit suites that fake the database call this from their
 * `$queryRaw` so the durable counter on their fake credential row moves exactly
 * as PostgreSQL would move it. The real statement, its row lock and its
 * behaviour under concurrency are covered by `operator-lockout-race.db.test.ts`.
 */
export type FakeOperatorCredentialRow = {
  id: string;
  failedAttempts: number;
  lockedUntil: Date | null;
  revokedAt?: Date | null;
};

export function isOperatorAttemptCharge(query: TemplateStringsArray): boolean {
  return query.join('').includes('UPDATE restaurant_operator_credentials');
}

/**
 * Apply the charge to the fake row named by the statement's parameters, in the
 * order the statement binds them: (max, lockUntil, max, now, credentialId, now).
 * Returns the `RETURNING id` rows: empty when the credential is locked, revoked
 * or absent.
 */
export function applyOperatorAttemptCharge(
  findRow: (credentialId: string) => FakeOperatorCredentialRow | null | undefined,
  values: readonly unknown[]
): { id: string }[] {
  const [maxFailedAttempts, lockUntilUtc, , nowUtc, credentialId] = values as [
    number,
    string,
    number,
    string,
    string,
  ];
  const row = findRow(credentialId);
  const now = new Date(nowUtc);
  if (!row || (row.revokedAt ?? null) !== null) return [];
  if (row.lockedUntil !== null && row.lockedUntil.getTime() > now.getTime()) return [];
  if (row.failedAttempts + 1 >= maxFailedAttempts) {
    row.failedAttempts = 0;
    row.lockedUntil = new Date(lockUntilUtc);
  } else {
    row.failedAttempts += 1;
    row.lockedUntil = null;
  }
  return [{ id: row.id }];
}
