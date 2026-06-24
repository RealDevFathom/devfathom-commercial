/**
 * The DevFathom assistant's toolset — the assembly point.
 *
 * The tools live in `src/lib/ai/tools/<domain>.ts`, one file per product area,
 * built against the shared `AssistantHelpers` foundation in `context.ts`. This
 * module:
 *   1. builds the per-request helper bundle from the acting user,
 *   2. SELECTS a relevant subset of tools for the request (see below),
 *   3. wraps each `execute` in try/catch so a thrown tool becomes a clean
 *      `{ error }` instead of the SDK's masked "An error occurred."
 *
 * COST CONTROL — tool selection.
 * The full operator has ~96 tools. Sending every tool's schema on every request
 * (and re-sending it on every step of a multi-step run) is the dominant token
 * cost. So we only send: a small always-on CORE of high-frequency reads, plus
 * the tools of the domain(s) the user's latest message is about (keyword-routed).
 * A typical question ships ~16 tools instead of 96; a focused write intent adds
 * one domain. If no hint is given we fall back to the full set (used by tests).
 *
 * Role-based exposure still happens INSIDE each domain builder (admin/HR tools
 * are only created when the capability holds; finance is empty for non-admins),
 * so selection never widens permissions — it only narrows what's offered.
 */
import { createAssistantHelpers, type AssistantContext, type ToolSet } from '@/lib/ai/context';
import { buildPeopleTools } from '@/lib/ai/tools/people';
import { buildResignationsTools } from '@/lib/ai/tools/resignations';
import { buildProjectsTools } from '@/lib/ai/tools/projects';
import { buildTasksTools } from '@/lib/ai/tools/tasks';
import { buildClientsTools } from '@/lib/ai/tools/clients';
import { buildFinanceTools } from '@/lib/ai/tools/finance';
import { buildChatTools } from '@/lib/ai/tools/chat';
import { buildNotesTools } from '@/lib/ai/tools/notes';
import { buildMeetingsTools } from '@/lib/ai/tools/meetings';
import { buildInsightsTools } from '@/lib/ai/tools/insights';

export type { AssistantContext } from '@/lib/ai/context';

type Domain =
  | 'insights' | 'people' | 'resignations' | 'projects' | 'tasks'
  | 'clients' | 'finance' | 'chat' | 'notes' | 'meetings';

// High-frequency READ tools that answer most questions — always offered, so a
// plain question rarely needs a domain bundle loaded at all.
const CORE_TOOLS = new Set([
  'getOverview', 'globalSearch', 'getRecentActivity',
  'listTeam', 'getTeamMember', 'getLeaveOverview',
  'listProjects', 'getProject', 'findProjectsBehindSchedule',
  'searchTasks', 'listMyTasks', 'findOverdueTasks',
  'listClients', 'listMeetings', 'searchNotes', 'listChannels',
]);

// Keyword → domain(s) whose FULL toolset (incl. writes) to load. Generous on
// purpose: a missed keyword just means a write tool isn't offered for that turn,
// and CORE still answers reads. Matched against the recent user message(s).
const ROUTES: Array<[RegExp, Domain[]]> = [
  [/invoic|revenue|profit|expense|transaction|p&l|pnl|budget|\bpaid\b|owe|financ|money|billing|\bbill\b|payment|cash|margin/i, ['finance']],
  [/\btask|to-?do|kanban|checklist|\blabel|assign|comment|ticket|backlog|sprint|\bcard\b|due date|priorit|move .*to|mark .*done/i, ['tasks', 'projects']],
  [/project|milestone|deadline|deliverable|roadmap|behind schedule|\bboard\b|column/i, ['projects', 'tasks']],
  [/client|customer|\baccount\b|contact|vendor|prospect/i, ['clients']],
  [/\bchat\b|messag|channel|\bdm\b|conversation|slack|\bpost\b|reply|mention|announce/i, ['chat']],
  [/\bnote|\bdoc\b|document|knowledge|wiki|write.?up|memo|jot/i, ['notes']],
  [/meeting|schedul|calendar|\bsync\b|stand.?up|\bcall\b|appointment|agenda|1.?on.?1/i, ['meetings']],
  [/resign|\bquit\b|\bnotice\b|last day|step down|leaving the company/i, ['resignations', 'people']],
  [
    /lay ?off|terminate|\bfire\b|let .* go|offboard|deactivat|\bhire\b|invit|onboard|\brole\b|promot|demote|perform|\bhr\b|headcount|staff|team member|employee|profile|leave|time off|vacation|sick|\bpto\b|holiday|password/i,
    ['people'],
  ],
  [/audit|workload|capacity|overload|bandwidth|\bskill|who knows|who (?:on the team )?knows|who can (?:do|build|write|use|code|design)|anyone who knows|expert(?:ise)? in|behind|overdue|brief|catch me up|dashboard|stat/i, ['insights', 'people', 'projects', 'tasks']],
];

// When no keyword matches at all, offer the common write targets (reads are
// already covered by CORE).
const DEFAULT_DOMAINS: Domain[] = ['people', 'projects', 'tasks'];

function selectDomains(hint: string): Set<Domain> {
  const picked = new Set<Domain>();
  for (const [re, domains] of ROUTES) {
    if (re.test(hint)) domains.forEach((d) => picked.add(d));
  }
  if (picked.size === 0) DEFAULT_DOMAINS.forEach((d) => picked.add(d));
  return picked;
}

/**
 * Build the toolset for one request. `opts.hint` is the recent user text used to
 * route which domains to load; omit it (or pass empty) to get the full set.
 */
export function buildAssistantTools(ctx: AssistantContext, opts: { hint?: string } = {}): ToolSet {
  const h = createAssistantHelpers(ctx);

  const perDomain: Record<Domain, ToolSet> = {
    insights: buildInsightsTools(h),
    people: buildPeopleTools(h),
    resignations: buildResignationsTools(h),
    projects: buildProjectsTools(h),
    tasks: buildTasksTools(h),
    clients: buildClientsTools(h),
    finance: buildFinanceTools(h),
    chat: buildChatTools(h),
    notes: buildNotesTools(h),
    meetings: buildMeetingsTools(h),
  };

  const hint = (opts.hint ?? '').trim();
  const selectAll = hint.length === 0;
  const domains = selectAll ? null : selectDomains(hint);

  const tools: ToolSet = {};
  for (const [domain, set] of Object.entries(perDomain) as [Domain, ToolSet][]) {
    const wholeDomain = selectAll || domains!.has(domain);
    for (const [name, t] of Object.entries(set)) {
      if (wholeDomain || CORE_TOOLS.has(name)) tools[name] = t;
    }
  }

  // Defense in depth: a thrown tool becomes a clean { error } the model can
  // recover from. Expected failures (auth refusals, not-found, ambiguity) are
  // already returned as { error } / { needsClarification } by the tools.
  for (const t of Object.values(tools) as Array<{
    execute?: (...args: unknown[]) => Promise<unknown>;
  }>) {
    const orig = t.execute;
    if (!orig) continue;
    t.execute = async (...args: unknown[]) => {
      try {
        return await orig(...args);
      } catch (e) {
        console.error('[assistant tool] failed:', e);
        return { error: e instanceof Error ? e.message : 'Tool failed.' };
      }
    };
  }

  return tools;
}
