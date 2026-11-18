import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import ts from 'typescript';
import { describe, expect, test } from 'vitest';

const read = (path: string) => readFileSync(resolve(process.cwd(), path), 'utf8');
const SCRIPTS = ['scripts/dev503-synthetic-medicines.ts', 'scripts/dev503-measure-page-loads.ts'];

/** Index of the first top-level statement that calls `name()`, or -1. */
function topLevelCallIndex(source: ts.SourceFile, name: string) {
  return source.statements.findIndex((statement) => {
    let found = false;
    const visit = (node: ts.Node) => {
      if (
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === name
      )
        found = true;
      if (!found && !ts.isFunctionLike(node)) ts.forEachChild(node, visit);
    };
    visit(statement);
    return found;
  });
}

describe('DEV-503 measurement tooling', () => {
  for (const path of SCRIPTS) {
    test(`${path} refuses anything but the guarded disposable E2E database at load`, () => {
      const text = read(path);
      const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
      expect(text).toMatch(
        /import \{ pharmacyE2eEnvironment \} from '\.\/pharmacy-e2e-environment';/
      );
      const guard = topLevelCallIndex(source, 'pharmacyE2eEnvironment');
      expect(guard).toBeGreaterThanOrEqual(0);
      // The guard runs before the script's work is defined or started.
      expect(guard).toBeLessThan(topLevelCallIndex(source, 'main'));
    });
  }

  test('the report labels its figures as local synthetic data', () => {
    const report = read('docs/qa/dev-503/performance.md');
    expect(report).toContain('local, synthetic data, not staging');
    for (const result of ['base-dd75b2e4', 'develop-064e8ba0', 'experiment-counter-prefetch']) {
      const json = JSON.parse(read(`docs/qa/dev-503/results/${result}.json`)) as {
        note: string;
        runs: number;
      };
      expect(json.note).toBe('local, synthetic data, not staging');
      expect(json.runs).toBeGreaterThanOrEqual(7);
    }
  });
});
