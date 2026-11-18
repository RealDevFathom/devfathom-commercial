import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import ts from 'typescript';
import { describe, expect, test } from 'vitest';

import { PHARMACY_SOP_TEMPLATE_GRANTS } from '@/lib/vertical-catalog';

import { PHARMACY_E2E } from './e2e/pharmacy-counter-fixture';

/**
 * DEV-751 — the procedures (SOP) browser lane: a separate manager and
 * pharmacist on explicit grants, seeded outside the staging demo, and the spec
 * run on both a desktop and a phone project.
 */

const read = (file: string) => readFileSync(resolve(process.cwd(), file), 'utf8');

describe('pharmacy procedures browser lane', () => {
  const sop = PHARMACY_E2E.sop;

  test('the manager and the pharmacist are two people with explicit, non-wildcard grants', () => {
    expect(sop.managerId).not.toBe(sop.pharmacistId);
    expect(sop.managerEmail).not.toBe(sop.pharmacistEmail);
    expect(sop.managerRoleId).not.toBe(sop.pharmacistRoleId);
    for (const capability of [...sop.managerCapabilities, ...sop.pharmacistCapabilities]) {
      expect(capability).not.toMatch(/\*/);
    }
    // The same grants the pharmacy role templates give a manager and a pharmacist doer.
    expect([...sop.managerCapabilities].sort()).toEqual(
      [...PHARMACY_SOP_TEMPLATE_GRANTS.manager!].sort()
    );
    expect(sop.pharmacistCapabilities).toContain('sop:complete');
    // The qualified-person procedure role refuses anyone without the exact dispense grant.
    expect(sop.pharmacistCapabilities).toContain('pharmacy:dispense');
    expect(sop.pharmacistCapabilities).not.toContain('sop:manage');
  });

  test('the seed creates the team on the e2e workspace only, never on the staging demo', () => {
    const source = ts.createSourceFile(
      'seed-pharmacy-e2e.ts',
      read('scripts/seed-pharmacy-e2e.ts'),
      ts.ScriptTarget.Latest,
      true
    );
    const main = source.statements.find(
      (node): node is ts.FunctionDeclaration =>
        ts.isFunctionDeclaration(node) && node.name?.text === 'main'
    );
    expect(main?.body).toBeTruthy();
    const guarded: string[] = [];
    const visit = (node: ts.Node) => {
      if (
        ts.isIfStatement(node) &&
        node.expression.getText(source) === '!stagingDemo' &&
        node.thenStatement.getText(source).includes('seedSopTeam(')
      ) {
        guarded.push(node.getText(source));
      }
      ts.forEachChild(node, visit);
    };
    visit(main!);
    expect(guarded).toHaveLength(1);
  });

  test('the spec runs on a desktop and a phone project, and the counter project skips it', () => {
    const config = read('playwright.pharmacy-counter.config.ts');
    expect(config).toMatch(/testMatch: \[[^\]]*'pharmacy-sop\.spec\.ts'/);
    expect(config).toMatch(
      /name: 'pharmacy-sop-desktop',\s*testMatch: 'pharmacy-sop\.spec\.ts',\s*use: \{ \.\.\.devices\['Desktop Chrome'\] \}/
    );
    expect(config).toMatch(
      /name: 'pharmacy-sop-mobile',\s*testMatch: 'pharmacy-sop\.spec\.ts',\s*use: \{ \.\.\.devices\['Pixel 7'\] \}/
    );
    expect(config).toMatch(
      /name: 'pharmacy-counter-serial',\s*testIgnore: 'pharmacy-sop\.spec\.ts'/
    );
  });

  test('the spec covers interrupted uploads, retries and back navigation', () => {
    const spec = read('tests/e2e/pharmacy-sop.spec.ts');
    // Dropped before the server, and dropped after the server saved it.
    expect(spec).toContain("route.abort('connectionreset')");
    expect(spec).toContain('await route.fetch()');
    expect(spec).toContain("name: 'Retry upload'");
    // Browser Back and the in-app link.
    expect(spec).toContain('page.goBack()');
    expect(spec).toContain('Back to today');
    // DEVFATHOM-STUDIO §12 matrix.
    for (const width of ['375', '768', '1024', '1440']) expect(spec).toContain(`width: ${width}`);
    expect(spec).toContain("['light', 'dark']");
    expect(spec).toContain("['no-preference', 'reduce']");
  });
});
