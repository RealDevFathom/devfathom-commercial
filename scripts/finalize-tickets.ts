/**
 * FINALIZE — cross-link both trackers and emit /TICKETS.md.
 *
 * 1. Re-renders each GitHub issue body to include the paired internal task id in
 *    its References (the internal task already carries the GitHub #/URL), so both
 *    sides reference each other + the shared BUG-ID. Idempotent (identical body on
 *    re-run).
 * 2. Writes /TICKETS.md: BUG-ID -> GitHub #/URL -> internal task id, with status.
 *
 * Run:  bun scripts/finalize-tickets.ts
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  TICKETS, ticketTitle, renderBody, SEV_PRIORITY,
  PROJECT_NAME, BOARD_NAME, TARGET_COLUMN, MILESTONE,
} from './qa-lib';

const REPO = 'WhatTheStack1/DevFathom-Hub';
const GH_MAP_PATH = join(import.meta.dir, '.qa-gh-map.json');
const INTERNAL_MAP_PATH = join(import.meta.dir, '.qa-internal-map.json');
const TICKETS_MD = join(import.meta.dir, '..', 'TICKETS.md');

const ghMap: Record<string, { number: number | null; url: string | null; status: string; error?: string }> =
  existsSync(GH_MAP_PATH) ? JSON.parse(readFileSync(GH_MAP_PATH, 'utf8')) : {};
const internalMap: Record<string, { taskId: string; status: string }> =
  existsSync(INTERNAL_MAP_PATH) ? JSON.parse(readFileSync(INTERNAL_MAP_PATH, 'utf8')) : {};

function gh(args: string[]): string {
  try {
    return execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  } catch (e: any) {
    return `__ERR__:${(e.stderr || e.message || '').toString().trim()}`;
  }
}

// 1. Back-link internal task id into each GitHub issue body.
console.log('Cross-linking GitHub issues with internal task ids…');
const tmp = mkdtempSync(join(tmpdir(), 'qa-link-'));
let linked = 0, linkFail = 0;
for (const t of TICKETS) {
  const ghRef = ghMap[t.id];
  const intRef = internalMap[t.id];
  if (!ghRef?.number || !intRef?.taskId) continue;
  const body = renderBody(t, { githubNumber: ghRef.number, githubUrl: ghRef.url ?? undefined, internalTaskId: intRef.taskId });
  const f = join(tmp, `${t.id}.md`);
  writeFileSync(f, body);
  const r = gh(['issue', 'edit', String(ghRef.number), '--repo', REPO, '--body-file', f]);
  if (r.startsWith('__ERR__')) { linkFail++; console.log(`  ✗ #${ghRef.number} (${t.id}): ${r.slice(8).split('\n')[0]}`); }
  else { linked++; }
}
console.log(`  linked=${linked} failed=${linkFail}`);

// 2. Emit /TICKETS.md
console.log('Writing /TICKETS.md…');
const rows = TICKETS.map((t) => {
  const g = ghMap[t.id] || {};
  const i = internalMap[t.id] || {};
  const ghCell = g.number ? `[#${g.number}](${g.url})` : '—';
  const ghStatus = g.status || 'Failed';
  const intCell = i.taskId ? `\`${i.taskId}\`` : '—';
  const intStatus = i.status || 'Failed';
  return `| ${t.id} | ${t.severity} | ${SEV_PRIORITY[t.severity]} | ${t.module} | ${t.type} | ${ghCell} | ${ghStatus} | ${intCell} | ${intStatus} |`;
});

const ghCreated = Object.values(ghMap).filter((g) => g.status === 'Created').length;
const ghSkipped = Object.values(ghMap).filter((g) => g.status === 'Skipped-existing').length;
const ghFailed = Object.values(ghMap).filter((g) => g.status === 'Failed').length;
const intCreated = Object.values(internalMap).filter((i) => i.status === 'Created').length;
const intSkipped = Object.values(internalMap).filter((i) => i.status === 'Skipped-existing').length;
const intFailed = Object.values(internalMap).filter((i) => i.status.startsWith('Failed')).length;
const failures = TICKETS.filter((t) => ghMap[t.id]?.status === 'Failed' || (internalMap[t.id]?.status || '').startsWith('Failed'));

const md = `# TICKETS.md — QA defect ticketing reconciliation

Every finding in [\`/BUGS.md\`](./BUGS.md) (53) filed in **two trackers** with identical content:
- **(A) GitHub Issues** — repo \`WhatTheStack1/DevFathom-Hub\`, milestone "${MILESTONE}", labelled \`severity:* · type:* · module:* · bug · qa\`.
- **(B) Internal DevFathom-Hub app** — Project **"${PROJECT_NAME}"** (INTERNAL) › Board **"${BOARD_NAME}"** › list **"${TARGET_COLUMN}"** (one Task per bug).

Each pair reconciles 1:1 on the shared **BUG-ID**. The internal task carries its GitHub #/URL; the GitHub issue carries the internal task id — both in their **References** section.

## Totals
- **GitHub:** ${ghCreated} created · ${ghSkipped} skipped-existing · ${ghFailed} failed (of 53)
- **Internal:** ${intCreated} created · ${intSkipped} skipped-existing · ${intFailed} failed (of 53)
- **Cross-links applied:** ${linked} (failed ${linkFail})
- **Severity → priority (internal):** HIGH→URGENT · MEDIUM→MEDIUM · LOW→LOW
- **Severity → label (GitHub):** HIGH→\`severity:high\` · MEDIUM→\`severity:medium\` · LOW→\`severity:low\`

${failures.length ? `## ⚠️ Failures\n${failures.map((t) => `- **${t.id}** — GitHub: ${ghMap[t.id]?.status}${ghMap[t.id]?.error ? ` (${ghMap[t.id]?.error})` : ''}; Internal: ${internalMap[t.id]?.status}`).join('\n')}\n` : '## Failures\nNone — all 53 filed on both sides.\n'}
## Mapping

| BUG-ID | Sev | Priority | Module | Type | GitHub | GH status | Internal task id | Int status |
|---|---|---|---|---|---|---|---|---|
${rows.join('\n')}

## Reversibility & re-running
- **Remove the internal import in one action:** delete Project **"${PROJECT_NAME}"** (\`prisma project.delete\`); cascades remove its board, columns, labels, and all 53 tasks. No pre-existing rows were touched.
- **GitHub:** close/delete the issues in milestone "${MILESTONE}" (e.g. \`gh issue list --repo ${REPO} --milestone "${MILESTONE}"\`).
- **Idempotent:** re-running \`bun scripts/create-github-issues.ts\` and \`bun scripts/import-qa-tickets.ts\` creates zero duplicates (matched by \`(BUG-ID)\` in the title) and refreshes content in place.

_Source of truth: \`/BUGS.md\`. Scripts: \`scripts/qa-tickets.json\` (data) · \`scripts/qa-lib.ts\` (render) · \`scripts/create-github-issues.ts\` · \`scripts/import-qa-tickets.ts\` · \`scripts/finalize-tickets.ts\`._
`;

writeFileSync(TICKETS_MD, md);
console.log(`  wrote ${TICKETS_MD}`);
console.log(`\nDone. GitHub ${ghCreated + ghSkipped}/53 · Internal ${intCreated + intSkipped}/53 · cross-links ${linked}/53`);
if (linkFail || ghFailed || intFailed) process.exitCode = 1;
