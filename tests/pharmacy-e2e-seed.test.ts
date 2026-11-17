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
  test('removes the legacy dotted cashier capability', () => {
    const legacyDeletes: string[] = [];
    const visit = (node: ts.Node) => {
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === 'deleteMany'
      ) {
        const collectStrings = (child: ts.Node) => {
          if (ts.isStringLiteral(child)) legacyDeletes.push(child.text);
          ts.forEachChild(child, collectStrings);
        };
        node.arguments.forEach(collectStrings);
      }
      ts.forEachChild(node, visit);
    };
    visit(seedFunction('seedCashier'));

    expect(legacyDeletes).toContain('pharmacy.counter');
  });

  test('grants the cashier the canonical counter capability', () => {
    const grantedCapabilities: string[] = [];
    const visit = (node: ts.Node) => {
      if (ts.isForOfStatement(node)) {
        // The seed's `as const` wraps the tuple array in an assertion node.
        const expression = ts.isAsExpression(node.expression)
          ? node.expression.expression
          : node.expression;
        if (ts.isArrayLiteralExpression(expression)) {
          for (const tuple of expression.elements) {
            if (!ts.isArrayLiteralExpression(tuple)) continue;
            const capability = tuple.elements[1];
            if (capability && ts.isStringLiteral(capability))
              grantedCapabilities.push(capability.text);
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(seedFunction('seedCashier'));

    expect(grantedCapabilities).toEqual(['pharmacy:counter', 'pharmacy:orders']);
  });
  test('only ever names the dotted counter capability to delete it', () => {
    const dotted: string[] = [];
    const visit = (node: ts.Node) => {
      if (
        (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) &&
        /^(pharmacy|reports)\.[a-z*-]+$/.test(node.text)
      ) {
        dotted.push(node.text);
      }
      ts.forEachChild(node, visit);
    };
    visit(source);

    // The single allowed mention is the repair delete in seedCashier (asserted above).
    expect(dotted).toEqual(['pharmacy.counter']);
  });

  test('the administrator fixture carries the canonical counter capability', () => {
    const declaration = source.statements
      .filter(ts.isVariableStatement)
      .flatMap((statement) => [...statement.declarationList.declarations])
      .find((d) => ts.isIdentifier(d.name) && d.name.text === 'PHARMACY_E2E_ADMIN_CAPABILITIES');
    const initializer = declaration?.initializer;
    const array =
      initializer && ts.isAsExpression(initializer) ? initializer.expression : initializer;
    if (!array || !ts.isArrayLiteralExpression(array)) {
      throw new Error('Missing PHARMACY_E2E_ADMIN_CAPABILITIES');
    }
    const capabilities = array.elements.filter(ts.isStringLiteral).map((e) => e.text);

    expect(capabilities).toContain('pharmacy:counter');
    expect(capabilities).not.toContain('pharmacy.counter');
  });
});
