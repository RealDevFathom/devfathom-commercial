/**
 * PART A — file every /BUGS.md finding as a GitHub Issue in WhatTheStack1/DevFathom-Hub.
 *
 * Idempotent: creates the label taxonomy + "QA Remediation" milestone (skip if present),
 * and one issue per BUG-ID (skip if an issue whose title already contains "(BUG-ID)" exists).
 * Writes scripts/.qa-gh-map.json mapping BUG-ID -> { number, url, status }.
 *
 * Auth: uses the `gh` CLI (already authenticated). No secrets are written to disk.
 * Run:  bun scripts/create-github-issues.ts
 */
import { execFileSync } from 'node:child_process';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  TICKETS,
  ticketTitle,
  renderBody,
  SEV_LABEL,
  MILESTONE,
  moduleLabels,
} from './qa-lib';

const REPO = 'WhatTheStack1/DevFathom-Hub';
const MAP_PATH = join(import.meta.dir, '.qa-gh-map.json');

function gh(args: string[], opts: { allowFail?: boolean } = {}): string {
  try {
    return execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  } catch (e: any) {
    if (opts.allowFail) return `__ERR__:${(e.stderr || e.message || '').toString().trim()}`;
    throw e;
  }
}

// ── 1. Label taxonomy (idempotent via --force) ────────────────────────────────
function ensureLabel(name: string, color: string, description: string) {
  const r = gh(
    ['label', 'create', name, '--repo', REPO, '--color', color, '--description', description, '--force'],
    { allowFail: true }
  );
  if (r.startsWith('__ERR__')) console.warn(`  ! label ${name}: ${r.slice(8)}`);
}

console.log('1/4 Ensuring label taxonomy…');
const SEV_COLORS: Record<string, string> = {
  critical: 'B60205',
  high: 'D93F0B',
  medium: 'FBCA04',
  low: '0E8A16',
};
for (const [s, c] of Object.entries(SEV_COLORS)) ensureLabel(`severity:${s}`, c, `QA severity: ${s}`);
const TYPE_COLORS: Record<string, string> = {
  security: '5319E7',
  functional: '1D76DB',
  data: '006B75',
  ux: 'C2E0C6',
  performance: 'D4C5F9',
};
for (const [t, c] of Object.entries(TYPE_COLORS)) ensureLabel(`type:${t}`, c, `Defect type: ${t}`);
for (const m of moduleLabels()) ensureLabel(`module:${m}`, 'C5DEF5', `Module: ${m}`);
ensureLabel('bug', 'D73A4A', "Something isn't working");
ensureLabel('qa', '0052CC', 'Filed by the QA engagement');

// ── 2. Milestone (idempotent) ─────────────────────────────────────────────────
console.log('2/4 Ensuring milestone…');
const existingMs = gh(['api', `repos/${REPO}/milestones`, '--jq', '.[].title'], { allowFail: true });
if (!existingMs.split('\n').includes(MILESTONE)) {
  const r = gh(
    [
      'api', `repos/${REPO}/milestones`, '-f', `title=${MILESTONE}`, '-f', 'state=open',
      '-f', 'description=Remediation of defects filed from /BUGS.md by the QA engagement (June 2026).',
    ],
    { allowFail: true }
  );
  console.log(r.startsWith('__ERR__') ? `  ! milestone: ${r.slice(8)}` : `  + created milestone "${MILESTONE}"`);
} else {
  console.log(`  = milestone "${MILESTONE}" already exists`);
}

// ── 3. Existing-issue index for idempotency ───────────────────────────────────
console.log('3/4 Indexing existing issues…');
const existingJson = gh(
  ['issue', 'list', '--repo', REPO, '--state', 'all', '--limit', '500', '--json', 'number,title,url'],
  { allowFail: true }
);
let existing: { number: number; title: string; url: string }[] = [];
try {
  existing = existingJson.startsWith('__ERR__') ? [] : JSON.parse(existingJson);
} catch {
  existing = [];
}
const findExisting = (id: string) => existing.find((i) => i.title.includes(`(${id})`));

// ── 4. Create issues ──────────────────────────────────────────────────────────
console.log(`4/4 Filing ${TICKETS.length} issues…`);
const tmp = mkdtempSync(join(tmpdir(), 'qa-gh-'));
const map: Record<string, { number: number | null; url: string | null; status: string; error?: string }> = {};
let created = 0, skipped = 0, failed = 0;

for (const t of TICKETS) {
  const found = findExisting(t.id);
  if (found) {
    map[t.id] = { number: found.number, url: found.url, status: 'Skipped-existing' };
    skipped++;
    console.log(`  = ${t.id} exists as #${found.number} (skip)`);
    continue;
  }
  const title = ticketTitle(t);
  const bodyFile = join(tmp, `${t.id}.md`);
  writeFileSync(bodyFile, renderBody(t));
  const labels = [`severity:${SEV_LABEL[t.severity]}`, `type:${t.typeLabel}`, `module:${t.moduleLabel}`, 'bug', 'qa'];
  const args = ['issue', 'create', '--repo', REPO, '--title', title, '--body-file', bodyFile, '--milestone', MILESTONE];
  for (const l of labels) args.push('--label', l);
  const out = gh(args, { allowFail: true });
  if (out.startsWith('__ERR__')) {
    map[t.id] = { number: null, url: null, status: 'Failed', error: out.slice(8) };
    failed++;
    console.log(`  ✗ ${t.id} FAILED: ${out.slice(8).split('\n')[0]}`);
  } else {
    const url = out.split('\n').find((l) => l.includes('/issues/')) || out;
    const num = Number(url.trim().split('/').pop());
    map[t.id] = { number: Number.isFinite(num) ? num : null, url: url.trim(), status: 'Created' };
    created++;
    console.log(`  + ${t.id} -> #${num}`);
  }
}

writeFileSync(MAP_PATH, JSON.stringify(map, null, 2));
console.log(`\nGitHub: created=${created} skipped=${skipped} failed=${failed} (total ${TICKETS.length})`);
console.log(`Map written to ${MAP_PATH}`);
if (failed) process.exitCode = 1;
