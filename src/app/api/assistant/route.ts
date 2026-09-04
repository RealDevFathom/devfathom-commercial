import { streamText, convertToModelMessages, stepCountIs, type UIMessage } from 'ai';
import { createAIModel } from '@/lib/ai/provider';
import { assistantToolChoice, buildAssistantTools } from '@/lib/ai/tools';
import { assistantSystemPrompt } from '@/lib/ai/prompt';
import { resolveTenantActor } from '@/lib/tenancy/tenant-actor';
import { createTenantDb } from '@/lib/tenancy/scoped-db';
import { resolveOrganizationEntitlements } from '@/lib/entitlements';

// Allow headroom for multi-step tool runs.
export const maxDuration = 60;

// The text of the last couple of user messages — used to route which tool
// domains to load (including the prior turn handles follow-ups like "do it").
function recentUserText(messages: UIMessage[]): string {
  const texts: string[] = [];
  for (let i = messages.length - 1; i >= 0 && texts.length < 2; i--) {
    const m = messages[i];
    if (m.role !== 'user') continue;
    const t = (m.parts ?? [])
      .filter(
        (p): p is { type: 'text'; text: string } =>
          p.type === 'text' && typeof (p as { text?: unknown }).text === 'string'
      )
      .map((p) => p.text)
      .join(' ');
    if (t.trim()) texts.push(t);
  }
  return texts.reverse().join(' \n ');
}

export async function POST(req: Request) {
  const actor = await resolveTenantActor({ request: req });
  if (!actor?.session.user?.id) {
    return new Response('Unauthorized', { status: 401 });
  }
  const session = actor.session;

  const { messages }: { messages: UIMessage[] } = await req.json();
  const organization = actor.organization;
  const entitlements = await resolveOrganizationEntitlements(
    organization.id,
    createTenantDb(organization.id)
  );

  const ctx = {
    organizationId: organization.id,
    userId: session.user.id,
    role: session.user.role ?? 'EMPLOYEE',
    name: session.user.name,
    email: session.user.email,
    department: session.user.department,
    status: session.user.status,
    enabledModules: entitlements.enabledModules,
  };

  const modelMessages = await convertToModelMessages(messages);

  // SECURITY INVARIANT (AI-04): the approval gate is a UX confirmation, NOT the
  // security boundary. The client supplies the full message history including the
  // approval parts, so a forged `approved: true` with a matching approvalId could
  // skip the user's own confirmation. That is acceptable ONLY because every write
  // tool re-checks authorization inside its own `execute` (e.g. `if (!h.isAdmin)
  // return { error }`). NEVER relax an in-`execute` authz check on the assumption
  // that the approval flow already protected it — it does not.
  //
  // An approval-continuation carries a just-approved tool part. The approved
  // tool MUST be in the toolset for the SDK to execute it — so on these requests
  // we load the full set (one call) rather than risk hint-routing dropping it.
  const isApprovalContinuation = messages.some((m) =>
    (m.parts ?? []).some(
      (p) =>
        typeof (p as { state?: unknown }).state === 'string' &&
        (p as { state: string }).state === 'approval-responded'
    )
  );

  const hint = recentUserText(messages);
  let ai: ReturnType<typeof createAIModel>;
  try {
    ai = createAIModel();
  } catch {
    return Response.json(
      { error: 'Ask Fathom is currently unavailable. No cached answer was used.' },
      { status: 503 }
    );
  }
  const result = streamText({
    model: ai.model,
    system: assistantSystemPrompt(ctx),
    messages: modelMessages,
    // Cost control: send only the tools relevant to what the user is asking
    // about (a core read set + the matched domain), not all ~96 every request.
    // The hint is the recent user text. See buildAssistantTools / tools.ts.
    tools: buildAssistantTools(ctx, isApprovalContinuation ? {} : { hint }),
    toolChoice: isApprovalContinuation ? 'auto' : assistantToolChoice(hint),
    // Operator actions chain resolve → act → confirm; 6 steps covers that while
    // capping the worst-case number of (token-heavy) model round-trips per turn.
    stopWhen: stepCountIs(6),
    providerOptions: ai.providerOptions,
    onError: ({ error }) => {
      console.error(
        '[assistant] stream unavailable',
        error instanceof Error ? error.name : 'Error'
      );
    },
  });

  return result.toUIMessageStreamResponse({
    onError: (error) => {
      console.error(
        '[assistant] response unavailable',
        error instanceof Error ? error.name : 'Error'
      );
      return 'Ask Fathom is currently unavailable. No cached answer was used.';
    },
  });
}
