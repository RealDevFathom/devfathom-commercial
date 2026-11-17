import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';
import ts from 'typescript';

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    return entry.isDirectory()
      ? sources(path)
      : entry.name.endsWith('.tsx') && !entry.name.includes('.test.')
        ? [path]
        : [];
  });
}

describe('pharmacy accessibility floor', () => {
  it('keeps pharmacy component and route typography at least 12px', () => {
    const files = ['src/components/pharmacy', 'src/app/(app)/pharmacy'].flatMap(sources);
    const offenders = files.flatMap((file) =>
      [...readFileSync(file, 'utf8').matchAll(/text-\[([\d.]+)(px|rem)\]/g)]
        .filter((match) => Number(match[1]) * (match[2] === 'rem' ? 16 : 1) < 12)
        .map((match) => `${file}: ${match[0]}`)
    );
    expect(offenders).toEqual([]);
  });

  it('has no fixed sub-44px counter button or input classes', () => {
    const src = readFileSync('src/components/pharmacy/counter/counter-console.tsx', 'utf8');
    expect(src.match(/className="[^"]*\bh-(?:[1-9]|10)\b[^"]*"/g) ?? []).toEqual([]);
  });

  it('keeps counter recovery buttons touch-sized in error states', () => {
    const offenders: string[] = [];
    for (const name of ['counter-receipt-view', 'counter-return-panel']) {
      const file = `src/components/pharmacy/counter/${name}.tsx`;
      const source = ts.createSourceFile(
        file,
        readFileSync(file, 'utf8'),
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.TSX
      );
      function visit(node: ts.Node) {
        if (
          (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) &&
          node.tagName.getText(source) === 'Button'
        ) {
          const props = node.attributes.properties.filter(ts.isJsxAttribute);
          const size = props
            .find((prop) => prop.name.getText(source) === 'size')
            ?.initializer?.getText(source);
          const classes =
            props
              .find((prop) => prop.name.getText(source) === 'className')
              ?.initializer?.getText(source) ?? '';
          if (size !== '"touch"' && !/\b(?:min-h|h)-(?:1[1-9]|[2-9]\d)\b/.test(classes)) {
            offenders.push(
              `${file}:${source.getLineAndCharacterOfPosition(node.getStart()).line + 1}`
            );
          }
        }
        ts.forEachChild(node, visit);
      }
      visit(source);
    }
    expect(offenders).toEqual([]);
  });

  it('keeps shared pharmacy metadata at the same 12px floor, including portals', () => {
    const styles = readFileSync('src/app/globals.css', 'utf8');
    expect(styles).toMatch(
      /\.pharmacy-workspace :is\(\[data-slot='status-pill'\], \[data-slot='eyebrow'\]\)\s*\{\s*font-size: var\(--text-xs\);/
    );
    const layout = readFileSync('src/app/(app)/pharmacy/layout.tsx', 'utf8');
    expect(layout).toContain('pharmacy-workspace contents');
    for (const file of [
      'counter-console',
      'counter-return-panel',
      'counter-open-bills',
      'counter-khata-payment-panel',
      'counter-sign-out',
      'counter-void-dialog',
    ]) {
      expect(readFileSync(`src/components/pharmacy/counter/${file}.tsx`, 'utf8')).toContain(
        'pharmacy-workspace'
      );
    }
  });

  it('gives counter recovery navigation links 44px targets', () => {
    const offenders: string[] = [];
    for (const name of ['counter-console', 'counter-rx-panel']) {
      const file = `src/components/pharmacy/counter/${name}.tsx`;
      const text = readFileSync(file, 'utf8');
      const source = ts.createSourceFile(
        file,
        text,
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.TSX
      );
      const linkClass = text.match(/const LINK_CLASS\s*=\s*'([^']+)'/)?.[1] ?? '';
      function visit(node: ts.Node) {
        if (
          (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) &&
          node.tagName.getText(source) === 'Link'
        ) {
          const classes =
            node.attributes.properties
              .filter(ts.isJsxAttribute)
              .find((prop) => prop.name.getText(source) === 'className')
              ?.initializer?.getText(source) ?? '';
          if (
            !/\b(?:min-h|h)-(?:1[1-9]|[2-9]\d)\b/.test(classes.replace('LINK_CLASS', linkClass))
          ) {
            offenders.push(
              `${file}:${source.getLineAndCharacterOfPosition(node.getStart()).line + 1}`
            );
          }
        }
        ts.forEachChild(node, visit);
      }
      visit(source);
    }
    expect(offenders).toEqual([]);
  });

  it('provides counter skip destinations without nesting another main landmark', () => {
    const src = readFileSync('src/components/pharmacy/counter/counter-console.tsx', 'utf8');
    expect(src).toContain('href="#counter-scan-search"');
    expect(src).toContain('href="#counter-bill-total"');
    expect(src).toContain('id="counter-bill-total"');
    expect(src).not.toMatch(/<main\b/);
    const shell = readFileSync('src/components/layout/app-shell.tsx', 'utf8');
    expect(shell).toContain('href="#main-content"');
    expect(shell).toContain('<main');
    expect(shell).toContain('id="main-content"');
  });
});
