import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, test } from 'vitest';
import ts from 'typescript';

const seed = readFileSync(resolve(process.cwd(), 'scripts/seed-pharmacy-e2e.ts'), 'utf8');
const source = ts.createSourceFile('seed-pharmacy-e2e.ts', seed, ts.ScriptTarget.Latest, true);

function seedFunction(name: string) {
  const declaration = source.statements.find(
    (node): node is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(node) && node.name?.text === name
  );
  if (!declaration?.body) throw new Error(`Missing seed function: ${name}`);
  return declaration;
}

describe('Pharmacy E2E seed', () => {
  test('grants the cashier the canonical counter capability', () => {
    const capabilities: string[] = [];
    const visit = (node: ts.Node) => {
      if (ts.isStringLiteral(node)) capabilities.push(node.text);
      ts.forEachChild(node, visit);
    };
    visit(seedFunction('seedCashier'));

    expect(capabilities).toContain('pharmacy:counter');
    expect(capabilities).not.toContain('pharmacy.counter');
  });
});
