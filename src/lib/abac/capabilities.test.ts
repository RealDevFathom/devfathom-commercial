import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { PHARMACY_ROLE_TEMPLATES } from '@/lib/vertical-catalog';
import { capabilityMatches } from './capabilities';
import { ALL_ACTIONS } from './policies';

export const intendedPharmacyGrants = {
  owner: ['pharmacy:*', 'reports:operational', 'reports:financial'],
  'owner-operator': [
    'reports:operational',
    'reports:financial',
    'pharmacy:orders',
    'pharmacy:dispense',
    'pharmacy:catalogue-review',
    'pharmacy:safety',
  ],
  pharmacist: ['pharmacy:dispense', 'pharmacy:safety', 'pharmacy:catalogue-review'],
  manager: ['pharmacy:manage', 'pharmacy:orders'],
  cashier: ['pharmacy:counter', 'pharmacy:orders'],
  procurement: ['pharmacy:procurement'],
  inventory: ['pharmacy:inventory'],
  finance: ['reports:financial'],
  auditor: ['reports:operational'],
};

describe('canonical capability contract (#130)', () => {
  it('grants exactly the intended actions to every pharmacy template', () => {
    expect(Object.fromEntries(PHARMACY_ROLE_TEMPLATES.map((r) => [r.key, r.capabilities]))).toEqual(
      intendedPharmacyGrants
    );
    for (const role of PHARMACY_ROLE_TEMPLATES) {
      for (const grant of role.capabilities) {
        expect(
          grant === 'pharmacy:*' || ALL_ACTIONS.includes(grant as (typeof ALL_ACTIONS)[number])
        ).toBe(true);
      }
    }
    expect(
      intendedPharmacyGrants.cashier.some((g) => capabilityMatches(g, 'pharmacy:procurement'))
    ).toBe(false);
  });

  it.each([
    'pharmacy.*',
    'pharmacy.dispense',
    'pharmacy:*:*',
    'pharmacy:dis*',
    'pharmacy:',
    ':*',
    '*:*',
    ' pharmacy:*',
    'pharmacy:*\n',
  ])('ignores malformed grant %j', (grant) => {
    for (const action of [...ALL_ACTIONS, grant])
      expect(capabilityMatches(grant, action)).toBe(false);
  });
  it('matches only exact actions, * and namespace:*', () => {
    expect(capabilityMatches('*', 'pharmacy:dispense')).toBe(true);
    expect(capabilityMatches('pharmacy:*', 'pharmacy:dispense')).toBe(true);
    expect(capabilityMatches('pharmacy:*', 'reports:financial')).toBe(false);
    expect(capabilityMatches('pharmacy:dispense', 'pharmacy:safety')).toBe(false);
    expect(capabilityMatches('*', 'pharmacy.dispense')).toBe(false);
  });

  it('enumerates every checked action across all tRPC routers, including dynamic unions', () => {
    const files = readdirSync('src/server/routers', { recursive: true })
      .filter(
        (f): f is string => typeof f === 'string' && f.endsWith('.ts') && !f.endsWith('.test.ts')
      )
      .map((f) => path.resolve('src/server/routers', f));
    // Resolve literal unions locally, without loading the entire application and Prisma.
    // Action is the real catalogue; unresolved/dynamic strings fail the assertion below.
    const options = { noResolve: true, target: ts.ScriptTarget.ESNext };
    const host = ts.createCompilerHost(options);
    const originalGetSourceFile = host.getSourceFile.bind(host);
    host.getSourceFile = (file, languageVersion, onError, shouldCreateNewSourceFile) => {
      if (!files.includes(file)) return originalGetSourceFile(file, languageVersion, onError, shouldCreateNewSourceFile);
      const source = ts.createSourceFile(
        file,
        readFileSync(file, 'utf8'),
        ts.ScriptTarget.Latest,
        true
      );
      const body = source.statements
        .filter((n) => !ts.isImportDeclaration(n))
        .map((n) => n.getFullText(source))
        .join('\n');
      return ts.createSourceFile(
        file,
        `type Action = ${ALL_ACTIONS.map((a) => JSON.stringify(a)).join(' | ')};\n${body}`,
        ts.ScriptTarget.Latest,
        true
      );
    };
    const program = ts.createProgram(files, options, host);
    const checker = program.getTypeChecker();
    const checked = new Set<string>();
    for (const file of files) {
      const source = program.getSourceFile(file)!;
      const visit = (node: ts.Node) => {
        if (ts.isCallExpression(node)) {
          const name = node.expression.getText(source);
          const index = name === 'can' ? 1 : name === 'capabilityProcedure' ? 0 : -1;
          if (index >= 0) {
            const arg = node.arguments[index];
            expect(arg, `${file}: missing action`).toBeDefined();
            const type = checker.getTypeAtLocation(arg);
            const variants = type.isUnion() ? type.types : [type];
            for (const variant of variants) {
              expect(
                variant.isStringLiteral(),
                `${file}: unresolved action ${arg.getText(source)}`
              ).toBe(true);
              if (variant.isStringLiteral()) {
                expect(ALL_ACTIONS, `${file}: ${variant.value}`).toContain(variant.value);
                checked.add(variant.value);
              }
            }
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(source);
    }
    expect(checked).toContain('pharmacy:dispense');
    expect(checked).toContain('pharmacy:procurement');
    expect(checked.size).toBeGreaterThan(30);
  }, 60_000);
});
