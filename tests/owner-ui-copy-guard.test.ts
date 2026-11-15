// @vitest-environment node
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

/**
 * DEV-39: owners must never read internal requirement codes, release jargon or
 * developer notes on screen. Only user-facing text is checked — string literals,
 * template text and JSX text — so code comments may keep their traceability codes.
 */
const ROOT = path.resolve(__dirname, '..');
const UI_DIRS = ['src/app/(app)', 'src/components'];
const EXTRA_FILES = ['src/lib/pharmacy/daily-work-pack.ts'];

const REQUIREMENT_CODE = /\b(?:PLAT|INV|PUR|POS|CRM|FIN|RX|AI|RPT|HR|MKT)-\d{2}\b/;
const DEV_JARGON = [
  /Not available in this release/i,
  /\bISO UTC\b/,
  /\bUTC ISO\b/,
  /scope-payload/i,
  /\breader caps\b/i,
  /\bFEFO board\b/,
  /\borderable suppliers?\b/i,
  /\bgate the domain\b/i,
];
/** A raw permission key inside a sentence ("reports:financial is required"). A bare key is code. */
const PERMISSION_KEY_IN_PROSE =
  /\b[a-z]+:(?:read|write|financial|operational|manage|admin|create|update|delete|approve|export|view|rates)\b/;
const BARE_KEY = /^\s*[a-z_]+:[a-z_]+\s*$/;
/** A raw database table name such as finance_journal_lines or pharmacy_stock_signals. */
const TABLE_NAME = /\b(?:pharmacy|finance|restaurant|hotel|audit)_[a-z_]{3,}\b/;

function uiFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) out.push(...uiFiles(full));
    else if (/\.tsx$/.test(name) && !/\.(test|spec|stories)\.tsx$/.test(name)) out.push(full);
  }
  return out;
}

function userFacingText(file: string, content: string): { line: number; text: string }[] {
  const source = ts.createSourceFile(
    file,
    content,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  );
  const found: { line: number; text: string }[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) return;
    if (
      ts.isStringLiteral(node) ||
      ts.isNoSubstitutionTemplateLiteral(node) ||
      ts.isTemplateHead(node) ||
      ts.isTemplateMiddle(node) ||
      ts.isTemplateTail(node) ||
      ts.isJsxText(node)
    ) {
      const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
      found.push({ line, text: node.text });
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

const files = [
  ...UI_DIRS.flatMap((dir) => uiFiles(path.join(ROOT, dir))),
  ...EXTRA_FILES.map((file) => path.join(ROOT, file)),
];

/**
 * `.toISOString()` rendered as visible JSX content (a child expression, not an
 * attribute such as `dateTime`, `value` or `href`) shows owners a raw ISO stamp.
 */
function rawIsoInJsx(file: string, content: string): number[] {
  const source = ts.createSourceFile(
    file,
    content,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX
  );
  const lines: number[] = [];
  // A date-only slice (`.toISOString().slice(0, 10)`) is a calendar date, not a timestamp.
  // Nested JSX is checked on its own visit, so it is not descended into here.
  const callsToIso = (node: ts.Node): boolean => {
    if (ts.isJsxAttribute(node) || ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node))
      return false;
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === 'toISOString'
    ) {
      const sliced =
        ts.isPropertyAccessExpression(node.parent) && node.parent.name.text === 'slice';
      if (!sliced) return true;
    }
    return ts.forEachChild(node, callsToIso) === true;
  };
  const visit = (node: ts.Node) => {
    if (
      ts.isJsxExpression(node) &&
      (ts.isJsxElement(node.parent) || ts.isJsxFragment(node.parent)) &&
      node.expression &&
      callsToIso(node.expression)
    ) {
      lines.push(source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return lines;
}

function offenders(patterns: RegExp[], skip: (text: string) => boolean = () => false): string[] {
  return files.flatMap((file) =>
    userFacingText(file, readFileSync(file, 'utf8'))
      .filter(({ text }) => !skip(text) && patterns.some((pattern) => pattern.test(text)))
      .map(({ line, text }) => `${path.relative(ROOT, file)}:${line} ${JSON.stringify(text)}`)
  );
}

describe('owner UI copy guard', () => {
  it('scans the tenant UI', () => {
    expect(files.length).toBeGreaterThan(100);
  });

  it('shows no internal requirement codes (INV-06, PUR-07, FIN-02, RX-04 …) in UI text', () => {
    expect(offenders([REQUIREMENT_CODE])).toEqual([]);
  });

  it('shows no release or developer jargon in UI text', () => {
    expect(offenders(DEV_JARGON)).toEqual([]);
  });

  it('shows no raw permission keys or database table names in UI text', () => {
    expect(offenders([PERMISSION_KEY_IN_PROSE], (text) => BARE_KEY.test(text))).toEqual([]);
    expect(offenders([TABLE_NAME])).toEqual([]);
  });

  it('never renders a raw ISO timestamp as visible JSX content', () => {
    const found = files
      .filter((file) => file.endsWith('.tsx'))
      .flatMap((file) =>
        rawIsoInJsx(file, readFileSync(file, 'utf8')).map(
          (line) => `${path.relative(ROOT, file)}:${line}`
        )
      );
    expect(found).toEqual([]);
  });

  it('flags ISO text in JSX children but not in attributes', () => {
    const sample = `export const A = ({ d }: { d: Date }) => (
      <p><time dateTime={d.toISOString()}>{d.toISOString()}</time>{\`At \${d.toISOString()}\`}{d.toISOString().slice(0, 10)}</p>
    );`;
    expect(rawIsoInJsx('x.tsx', sample)).toEqual([2, 2]);
  });

  it('detects a code in an eyebrow but ignores the same code in a comment', () => {
    const sample = `// INV-06 traceability\nexport const A = () => <Card eyebrow="INV-06">{/* PUR-07 */}Stock</Card>;`;
    const texts = userFacingText('x.tsx', sample).map(({ text }) => text);
    expect(texts.filter((text) => REQUIREMENT_CODE.test(text))).toEqual(['INV-06']);
  });
});
