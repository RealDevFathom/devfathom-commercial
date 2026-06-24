/**
 * Shared library for the QA ticketing scripts.
 *
 * Single source of truth = scripts/qa-tickets.json (faithfully transcribed from
 * /BUGS.md). This module loads it and renders the identical "pro template" body
 * used in BOTH trackers (GitHub Issues + the internal DevFathom-Hub app).
 *
 * Read-only with respect to app code: these scripts only file tickets.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export type Severity = 'HIGH' | 'MEDIUM' | 'LOW';

export interface Ticket {
  id: string;
  severity: Severity;
  module: string; // display, e.g. "Finance/Dashboard"
  moduleLabel: string; // normalized, e.g. "finance"
  type: string; // display, e.g. "Data/Functional"
  typeLabel: string; // normalized: security|functional|data|ux|performance
  role: string;
  summary: string;
  preconditions: string;
  steps: string[];
  expected: string;
  actual: string;
  evidence: string;
  fix: string;
}

export const TICKETS: Ticket[] = JSON.parse(
  readFileSync(join(import.meta.dir, 'qa-tickets.json'), 'utf8')
);

/** severity -> internal Priority enum value (High = highest priority value). */
export const SEV_PRIORITY: Record<Severity, 'URGENT' | 'MEDIUM' | 'LOW'> = {
  HIGH: 'URGENT',
  MEDIUM: 'MEDIUM',
  LOW: 'LOW',
};

/** severity -> GitHub label suffix. */
export const SEV_LABEL: Record<Severity, string> = {
  HIGH: 'high',
  MEDIUM: 'medium',
  LOW: 'low',
};

export const MILESTONE = 'QA Remediation';
export const PROJECT_NAME = 'QA Remediation — June 2026';
export const BOARD_NAME = 'QA Findings';
export const COLUMNS = ['Backlog', 'To Do', 'In Progress', 'In Review', 'Done'];
export const TARGET_COLUMN = 'To Do';

/** Title format: [SEVERITY][Module] Concise summary (BUG-ID) */
export function ticketTitle(t: Ticket): string {
  return `[${t.severity}][${t.module}] ${t.summary} (${t.id})`;
}

const ENV_LINES = [
  '- Branch: `main` · Build: `bun run build` → exit 0 (clean)',
  '- Stack: Next.js 16 / React 19 / TypeScript · Bun · Prisma 7 + Postgres (Neon) · tRPC v11 · NextAuth v5',
];

export interface CrossRef {
  githubNumber?: number;
  githubUrl?: string;
  internalTaskId?: string;
}

/** Renders the full, identical pro-template body for either tracker. */
export function renderBody(t: Ticket, ref: CrossRef = {}): string {
  const steps = t.steps.map((s, i) => `${i + 1}. ${s}`).join('\n');
  const priority = SEV_PRIORITY[t.severity];

  const github = ref.githubNumber
    ? `- GitHub issue: #${ref.githubNumber}${ref.githubUrl ? ` — ${ref.githubUrl}` : ''}`
    : `- GitHub issue: paired by shared BUG-ID \`${t.id}\` (repo WhatTheStack1/DevFathom-Hub, milestone "${MILESTONE}")`;
  const internal = ref.internalTaskId
    ? `- Internal ticket: DevFathom-Hub › "${PROJECT_NAME}" › Board "${BOARD_NAME}" › ${TARGET_COLUMN} · task id \`${ref.internalTaskId}\``
    : `- Internal ticket: DevFathom-Hub › "${PROJECT_NAME}" › Board "${BOARD_NAME}" › ${TARGET_COLUMN} (paired by shared BUG-ID \`${t.id}\`)`;

  return [
    `**Bug ID:** \`${t.id}\` · **Severity:** ${t.severity} · **Priority:** ${priority} · **Module:** ${t.module} · **Type:** ${t.type}`,
    '',
    '### Environment',
    ...ENV_LINES,
    `- Reproduced as: ${t.role} (static code review + live dev server at http://localhost:3000)`,
    '',
    '### Preconditions / Setup',
    t.preconditions,
    '',
    '### Steps to Reproduce',
    steps,
    '',
    '### Expected Result',
    t.expected,
    '',
    '### Actual Result',
    t.actual,
    '',
    '### Evidence',
    t.evidence,
    '',
    '### Suggested Fix',
    t.fix,
    '',
    '### References',
    `- Source of truth: \`/BUGS.md\` → **${t.id}**`,
    github,
    internal,
    `- Cross-reference key: **${t.id}** (reconciles 1:1 across both trackers)`,
    '',
    '_Filed by the QA engagement (documentation only — no code changed)._',
  ].join('\n');
}

/** Distinct module labels present, for building the GitHub label taxonomy. */
export function moduleLabels(): string[] {
  return [...new Set(TICKETS.map((t) => t.moduleLabel))].sort();
}
