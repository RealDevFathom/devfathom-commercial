/**
 * UI copy guard.
 *
 * Collects user-facing strings from .tsx sources (JSX text, string literals that flow into JSX,
 * and copy-like object fields such as `title`, `label`, `eyebrow`) and reports internal codes,
 * raw database table names, permission keys, ISO timestamps and developer jargon that must not
 * reach users. Code comments, class names, hrefs, keys and other non-visible attributes are
 * ignored.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

import ts from 'typescript';

export type CopyRule = {
  id: string;
  pattern: RegExp;
  message: string;
  /** Attributes where the rule does not apply (e.g. a format hint in a placeholder). */
  skipAttributes?: string[];
};

/** Rules applied to every user-facing string in src/app and src/components. */
export const GLOBAL_RULES: CopyRule[] = [
  {
    id: 'requirement-code',
    pattern: /\b(?:PLAT|INV|PUR|POS|CRM|RX|RPT|SAFE|AI)-[A-Z]?\d{2}\b/,
    message: 'internal requirement code (e.g. INV-06, POS-02, CRM-L01)',
  },
  {
    id: 'table-name',
    pattern: /\b(?:pharmacy|finance)_[a-z]+(?:_[a-z]+)*\b/,
    message: 'raw database table name',
  },
  {
    id: 'permission-key',
    pattern: /\b(?:reports|pharmacy|finance|inventory|purchasing):[a-z_]+\b/i,
    message: 'permission key / internal tag (e.g. REPORTS:FINANCIAL)',
  },
  {
    id: 'iso-timestamp',
    // Machine timestamps as stored/serialized (fractional seconds or a Z suffix). Format hints
    // for typed inputs that need an offset are not flagged here.
    pattern: /\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z\b|\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d+/,
    message: 'raw ISO timestamp',
    // A placeholder showing the format a typed instant must use is guidance, not a timestamp.
    skipAttributes: ['placeholder'],
  },
  {
    id: 'release-hedge',
    pattern: /not available in this release/i,
    message: "release hedge ('Not available in this release')",
  },
  {
    id: 'dev-note',
    pattern: /anomaly reader caps/i,
    message: 'developer implementation note',
  },
];

/** Plain-language rules for pharmacy screens (owner, cashier and pharmacist views). */
export const PHARMACY_JARGON_RULES: CopyRule[] = [
  { id: 'fefo', pattern: /\bFEFO\b/, message: "jargon 'FEFO' (say 'earliest expiry first')" },
  { id: 'ledger-projection', pattern: /ledger projection/i, message: "jargon 'ledger projection'" },
  { id: 'canonical-unit', pattern: /canonical units?/i, message: "jargon 'canonical units'" },
  { id: 'pack-hierarchy', pattern: /pack hierarchy/i, message: "jargon 'pack hierarchy'" },
  { id: 'capture-shortfall', pattern: /capture shortfall/i, message: "jargon 'Capture shortfall'" },
  { id: 'original-custody', pattern: /original custody/i, message: "jargon 'Original custody'" },
  { id: 'sign-to-release', pattern: /sign to release/i, message: "jargon 'Sign to release'" },
  {
    id: 'orderable-suppliers',
    pattern: /orderable suppliers?/i,
    message: "jargon 'orderable suppliers'",
  },
];

/** Attributes whose values are never shown to users. */
const NON_VISIBLE_ATTRIBUTES = new Set([
  'className',
  'href',
  'key',
  'id',
  'htmlFor',
  'name',
  'type',
  'value',
  'defaultValue',
  'role',
  'src',
  'method',
  'action',
  'target',
  'rel',
  'autoComplete',
  'inputMode',
  'pattern',
  'form',
  'variant',
  'size',
  'tone',
  'side',
  'align',
  'accept',
  'encType',
  'lang',
  'dir',
  'style',
]);

/** Object-literal property names that carry display copy. */
const COPY_PROPERTIES = new Set([
  'title',
  'label',
  'description',
  'eyebrow',
  'why',
  'detail',
  'details',
  'hint',
  'helper',
  'helperText',
  'message',
  'placeholder',
  'subtitle',
  'summary',
  'caption',
  'requirement',
  'reason',
  'tooltip',
  'empty',
  'emptyText',
  'note',
  'body',
  'heading',
  'cta',
  'actionLabel',
]);

/** Calls whose string arguments are class names or identifiers, never copy. */
const NON_COPY_CALLS = new Set(['cn', 'clsx', 'cva', 'twMerge', 'require', 'import']);

export type CopyString = { text: string; line: number; attribute?: string };

function isNonVisibleAttribute(name: string): boolean {
  return (
    NON_VISIBLE_ATTRIBUTES.has(name) ||
    name.startsWith('data-') ||
    name.startsWith('on') ||
    name.endsWith('ClassName') ||
    name.endsWith('Href') ||
    name.endsWith('Id')
  );
}

function calleeName(call: ts.CallExpression): string | null {
  const callee = call.expression;
  if (ts.isIdentifier(callee)) return callee.text;
  if (ts.isPropertyAccessExpression(callee)) return callee.name.text;
  return null;
}

/** Decide whether a string literal node ends up in front of a user. */
function jsxAttributeOf(node: ts.Node): string | undefined {
  let current: ts.Node | undefined = node.parent;
  while (current && !ts.isFunctionLike(current) && !ts.isSourceFile(current)) {
    if (ts.isJsxAttribute(current)) return current.name.getText();
    current = current.parent;
  }
  return undefined;
}

function literalIsUserFacing(node: ts.Node): boolean {
  let current: ts.Node | undefined = node.parent;
  let insideJsxExpression = false;
  while (current) {
    if (ts.isCallExpression(current)) {
      const name = calleeName(current);
      if (name && NON_COPY_CALLS.has(name)) return false;
    }
    if (ts.isJsxAttribute(current)) {
      const attrName = current.name.getText();
      return !isNonVisibleAttribute(attrName);
    }
    if (ts.isJsxExpression(current)) insideJsxExpression = true;
    if (ts.isPropertyAssignment(current) && !insideJsxExpression) {
      const key = current.name;
      const keyText =
        ts.isIdentifier(key) || ts.isStringLiteral(key) ? key.text : key.getText();
      return COPY_PROPERTIES.has(keyText);
    }
    if (
      ts.isJsxElement(current) ||
      ts.isJsxSelfClosingElement(current) ||
      ts.isJsxFragment(current)
    ) {
      return insideJsxExpression;
    }
    if (
      ts.isFunctionLike(current) ||
      ts.isSourceFile(current) ||
      ts.isImportDeclaration(current) ||
      ts.isExportDeclaration(current)
    ) {
      return false;
    }
    current = current.parent;
  }
  return false;
}

/** Extract user-facing strings from a .tsx source. */
export function extractCopyStrings(source: string, fileName = 'file.tsx'): CopyString[] {
  const sourceFile = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const out: CopyString[] = [];
  const push = (node: ts.Node, text: string, attribute?: string) => {
    const trimmed = text.replace(/\s+/g, ' ').trim();
    if (!trimmed) return;
    const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
    out.push({ text: trimmed, line: line + 1, attribute });
  };

  const visit = (node: ts.Node) => {
    if (ts.isJsxText(node)) {
      push(node, node.text);
    } else if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      if (literalIsUserFacing(node)) push(node, node.text, jsxAttributeOf(node));
    } else if (ts.isTemplateExpression(node)) {
      if (literalIsUserFacing(node)) {
        push(
          node,
          [node.head.text, ...node.templateSpans.map((span) => span.literal.text)].join(' … '),
          jsxAttributeOf(node)
        );
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return out;
}

export type CopyViolation = { file: string; line: number; rule: string; text: string };

/**
 * `.toISOString()` whose result is rendered as JSX text (directly or through a template
 * literal). Attribute values such as `dateTime`, `value` or `key` are allowed.
 */
export function findRenderedIsoCalls(source: string, fileName = 'file.tsx'): CopyString[] {
  const sourceFile = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const out: CopyString[] = [];
  const visit = (node: ts.Node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === 'toISOString' &&
      node.arguments.length === 0
    ) {
      let current: ts.Node = node;
      let parent: ts.Node | undefined = node.parent;
      let rendered = false;
      while (parent) {
        if (ts.isJsxAttribute(parent) || ts.isFunctionLike(parent) || ts.isSourceFile(parent)) break;
        if (ts.isPropertyAccessExpression(parent) && parent.expression === current) break; // .slice(), .replace()
        if (ts.isCallExpression(parent) && parent.arguments.includes(current as ts.Expression)) break;
        if (ts.isJsxExpression(parent) && (ts.isJsxElement(parent.parent) || ts.isJsxFragment(parent.parent))) {
          rendered = true;
          break;
        }
        current = parent;
        parent = parent.parent;
      }
      if (rendered) {
        const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
        out.push({ text: node.getText(sourceFile), line: line + 1 });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return out;
}

export function findViolations(
  file: string,
  source: string,
  rules: CopyRule[]
): CopyViolation[] {
  const violations: CopyViolation[] = [];
  for (const { text, line, attribute } of extractCopyStrings(source, file)) {
    for (const rule of rules) {
      if (attribute && rule.skipAttributes?.includes(attribute)) continue;
      if (rule.pattern.test(text)) violations.push({ file, line, rule: rule.id, text });
    }
  }
  for (const { text, line } of findRenderedIsoCalls(source, file)) {
    violations.push({ file, line, rule: 'iso-timestamp', text });
  }
  return violations;
}

export function listSourceFiles(root: string, extensions: string[]): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      if (entry === 'node_modules' || entry === 'generated' || entry === '__tests__') continue;
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        walk(full);
      } else if (
        extensions.some((ext) => entry.endsWith(ext)) &&
        !/\.(test|spec|stories)\.tsx?$/.test(entry) &&
        !entry.endsWith('.d.ts')
      ) {
        out.push(full);
      }
    }
  };
  walk(root);
  return out;
}

const PHARMACY_SCOPES = [
  ['src', 'app', '(app)', 'pharmacy'].join(sep),
  ['src', 'components', 'pharmacy'].join(sep),
  ['src', 'app', '(app)', 'dashboard', 'pharmacy-'].join(sep),
];

export function isPharmacyScreen(repoRelativePath: string): boolean {
  return PHARMACY_SCOPES.some((scope) => repoRelativePath.startsWith(scope));
}

export function scanRepository(repoRoot: string): CopyViolation[] {
  const files = [
    ...listSourceFiles(join(repoRoot, 'src', 'app'), ['.tsx']),
    ...listSourceFiles(join(repoRoot, 'src', 'components'), ['.tsx']),
  ];
  return files.flatMap((full) => {
    const rel = relative(repoRoot, full);
    const rules = isPharmacyScreen(rel) ? [...GLOBAL_RULES, ...PHARMACY_JARGON_RULES] : GLOBAL_RULES;
    return findViolations(rel, readFileSync(full, 'utf8'), rules);
  });
}

/** Phrases that must not appear anywhere in shipped source, including server-built copy in src/lib. */
export const BANNED_SOURCE_PHRASES = [/not available in this release/i, /anomaly reader caps/i];

export function scanBannedPhrases(repoRoot: string): CopyViolation[] {
  const files = listSourceFiles(join(repoRoot, 'src'), ['.ts', '.tsx']);
  const violations: CopyViolation[] = [];
  for (const full of files) {
    const lines = readFileSync(full, 'utf8').split('\n');
    lines.forEach((text, index) => {
      for (const pattern of BANNED_SOURCE_PHRASES) {
        if (pattern.test(text)) {
          violations.push({
            file: relative(repoRoot, full),
            line: index + 1,
            rule: String(pattern),
            text: text.trim(),
          });
        }
      }
    });
  }
  return violations;
}

export function formatViolations(violations: CopyViolation[]): string {
  return violations.map((v) => `${v.file}:${v.line} [${v.rule}] ${v.text}`).join('\n');
}
