/**
 * DEV-1053: the assistant is under the same support-session rule as tRPC and REST.
 *
 * Every assistant tool is decided here: the six that reach a member, role or password change
 * are refused for a support session; a new tool fails until it is put on one side.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ recordAudit: vi.fn() }));

vi.mock('server-only', () => ({}));
// A refused tool must never reach the database.
vi.mock('@/lib/tenancy/scoped-db', () => ({
  createTenantDb: () =>
    new Proxy(
      {},
      {
        get: (_target, property) => {
          throw new Error(`database touched: ${String(property)}`);
        },
      }
    ),
}));
vi.mock('@/server/audit', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/server/audit')>()),
  recordAudit: mocks.recordAudit,
}));

import { buildAssistantTools, type AssistantContext } from '@/lib/ai/tools';
import { MODULE_CATALOG } from '@/lib/module-catalog';
import {
  SUPPORT_REFUSED_ASSISTANT_TOOLS,
  SUPPORT_SESSION_REFUSED_MESSAGE,
} from '@/lib/tenancy/support-session-rule';
import { ALL_VERTICALS } from '@/lib/vertical-catalog';

/**
 * Support may not: each mirrors a refused procedure (invite, update, status, lay off, reset,
 * and `resignations.review`, which decides whether a member leaves).
 */
const SUPPORT_MAY_NOT = [
  'inviteMember',
  'layOffMember',
  'resetMemberPassword',
  'reviewResignation',
  'setMemberStatus',
  'updateMember',
];

/**
 * Support may: reads, and ordinary records. Project, channel and note sharing act only among
 * existing members.
 */
// prettier-ignore
const SUPPORT_MAY = [
  'addChannelMembers', 'addClientContact', 'addLabelToTask', 'addPerformanceNote',
  'addProjectMember', 'addTaskComment', 'askPharmacyBusinessInsights',
  'askPharmacyCashCloseCheck', 'askPharmacyFinanceInsights', 'askPharmacyOwnerQuestion',
  'askPharmacyReports', 'askPharmacyWorkPacks', 'askRestaurantReports', 'createBoard',
  'createChannel', 'createClient', 'createColumn', 'createInvoice', 'createLabel',
  'createMeeting', 'createMilestone', 'createNote', 'createProject', 'createRecurringExpense',
  'createTask', 'createTransaction', 'deleteBoard', 'deleteClient', 'deleteClientContact',
  'deleteColumn', 'deleteMeeting', 'deleteMilestone', 'deleteNote', 'deleteProject',
  'deleteRecurringExpense', 'deleteTask', 'deleteTransaction', 'findOverdueTasks',
  'findPeopleBySkill', 'findProjectsBehindSchedule', 'getChannelMessages', 'getClient',
  'getDashboardStats', 'getFinanceSummary', 'getHrOverview', 'getInvoice', 'getLeaveOverview',
  'getMeeting', 'getMyResignation', 'getNote', 'getOverview', 'getPnlReport', 'getProject',
  'getRecentActivity', 'getTaskDetail', 'getTeamMember', 'getTeamWorkload', 'globalSearch',
  'listChannels', 'listClients', 'listInvoices', 'listMeetings', 'listMyTasks',
  'listPerformanceNotes', 'listProjects', 'listRecurringExpenses', 'listResignations',
  'listStaffRoles', 'listTeam', 'listTransactions', 'markJoined', 'moveTask',
  'removeLabelFromTask', 'removeProjectMember', 'reorderColumns', 'requestLeave',
  'searchAuditLog', 'searchMessages', 'searchNotes', 'searchTasks',
  'sendMessage', 'setLeaveStatus', 'setNoteShares', 'setProjectMemberRole', 'setTaskAssignees',
  'submitResignation', 'toggleChecklistItem', 'updateClient', 'updateColumn',
  'updateInvoiceStatus', 'updateMeeting', 'updateMilestone', 'updateMyProfile', 'updateNote',
  'updateProject', 'updateTask', 'updateTransaction', 'withdrawResignation',
];

const owner: AssistantContext = {
  organizationId: 'org_1',
  userId: 'owner_1',
  role: 'ADMIN',
  name: 'Owner',
  email: 'owner@test.invalid',
  enabledModules: MODULE_CATALOG.map(({ key }) => key),
};
const support: AssistantContext = {
  ...owner,
  supportSession: true,
  supportOperator: { supportSessionId: 'support_session_1', platformUserId: 'platform_operator_1' },
};

/** Hints unlock the two pharmacy tools that need explicit intent. */
const HINTS = [undefined, 'pharmacy work pack', 'cash close check'];

function everyTool(ctx: AssistantContext) {
  const tools = new Map<string, { needsApproval?: unknown; execute?: unknown }>();
  for (const vertical of ALL_VERTICALS) {
    for (const hint of HINTS) {
      const built = buildAssistantTools({ ...ctx, vertical }, hint ? { hint } : {});
      for (const [name, tool] of Object.entries(built)) tools.set(name, tool);
    }
  }
  return tools;
}

type Execute = (input: unknown, options: unknown) => Promise<unknown>;

beforeEach(() => mocks.recordAudit.mockReset());

describe('DEV-1053 assistant tools under the support-session rule', () => {
  it('decides every assistant tool, with no stale entry', () => {
    const names = [...everyTool(owner).keys()].sort();
    expect(names).toEqual([...SUPPORT_MAY, ...SUPPORT_MAY_NOT].sort());
    expect([...SUPPORT_REFUSED_ASSISTANT_TOOLS].sort()).toEqual(SUPPORT_MAY_NOT);
  });

  it('refuses each member, role and password tool for a support session and audits it', async () => {
    const tools = everyTool(support);
    for (const name of SUPPORT_MAY_NOT) {
      mocks.recordAudit.mockReset();
      const tool = tools.get(name)!;
      // No approval card: there is nothing to approve.
      expect(tool.needsApproval, name).toBe(false);
      const result = await (tool.execute as Execute)(
        { name: 'Aisha Khan', email: 'new-admin@test.invalid', role: 'ADMIN', status: 'ACTIVE' },
        { toolCallId: 'call_1', messages: [] }
      );
      expect(result, name).toEqual({ error: SUPPORT_SESSION_REFUSED_MESSAGE });
      expect(mocks.recordAudit, name).toHaveBeenCalledTimes(1);
      expect(mocks.recordAudit, name).toHaveBeenCalledWith(
        expect.objectContaining({
          organizationId: 'org_1',
          actorId: 'owner_1',
          source: 'SYSTEM',
          action: `assistant.${name}`,
          outcome: 'FAILURE',
          errorCode: 'FORBIDDEN',
          metadata: {
            via: 'assistant',
            supportSessionRefused: true,
            supportSessionId: 'support_session_1',
            platformUserId: 'platform_operator_1',
            actingAsTenantUserId: 'owner_1',
          },
        })
      );
    }
  });

  it('leaves every other tool, and the session of the member themselves, as it was', () => {
    const asSupport = everyTool(support);
    const asOwner = everyTool(owner);
    for (const name of SUPPORT_MAY) {
      expect(asSupport.get(name)!.needsApproval, name).toBe(asOwner.get(name)!.needsApproval);
    }
    // The owner still gets the approval card for the six.
    for (const name of SUPPORT_MAY_NOT) expect(asOwner.get(name)!.needsApproval, name).toBe(true);
  });
});
