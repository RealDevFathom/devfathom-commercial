// Shared helpers for the migration order rules (QA-12 / DEV-813).
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

export const LEGACY_FILE = 'tests/fixtures/legacy-migration-names.txt';
export const LEDGER_FILE = 'tests/fixtures/new-migration-order.txt';

export const HOW_TO_FIX =
  'Append the new migration directory name at the END of ' +
  `${LEDGER_FILE}. If another migration landed first, re-stamp YOUR new migration ` +
  `later than it. Never sort, never insert in the middle, never edit ${LEGACY_FILE}.`;

export function parseList(text: string): string[] {
  return text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'));
}

export function readList(file: string): string[] {
  return parseList(readFileSync(file, 'utf8'));
}

/** A list on origin/develop; unavailable bases fail CI and are skipped locally. */
export function readBaseList(file: string): string[] | null {
  try {
    return parseList(
      execFileSync('git', ['show', `origin/develop:${file}`], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      })
    );
  } catch {
    if (process.env.CI) {
      throw new Error(
        `Cannot read origin/develop:${file}. Fetch origin develop before checking migrations.`
      );
    }
    return null;
  }
}

export function readBaseLedger(): string[] | null {
  return readBaseList(LEDGER_FILE);
}

/** Frozen lists cannot be extended, shortened, or reordered. */
export function isUnchanged(base: string[], current: string[]): boolean {
  return base.length === current.length && isAppendOnly(base, current);
}

/** True when `base` is an unchanged leading prefix of `current` (append-only). */
export function isAppendOnly(base: string[], current: string[]): boolean {
  return base.length <= current.length && base.every((name, i) => current[i] === name);
}
