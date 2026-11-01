import {
  streamText,
  validateUIMessages,
  convertToModelMessages,
  stepCountIs,
  type UIMessage,
} from 'ai';
import {
  ASSISTANT_LIMITS,
  assistantRateKeys,
  contentLengthTooLarge,
  hasUnavailableApprovedTool,
  messagesTooLarge,
  utf8Bytes,
} from '@/lib/ai/assistant-request';
import { assistantVertical } from '@/lib/ai/context';
import { rateLimit } from '@/lib/rate-limit';
import { readAskFathomSettings } from '@/lib/ai/ask-fathom-settings';
import { createAIModel, readAIAvailability } from '@/lib/ai/provider';
import { assistantToolChoice, buildAssistantTools } from '@/lib/ai/tools';
import { assistantSystemPrompt } from '@/lib/ai/prompt';
import { withApiRoute } from '@/lib/api-route';
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

const UNAVAILABLE = 'Ask Fathom is currently unavailable. No cached answer was used.';

export const POST = withApiRoute(
  async (req: Request) => {
    return await respond(req);
  },
  () => {
    console.error('ASSISTANT_REQUEST_FAILED');
    return Response.json({ error: UNAVAILABLE }, { status: 503 });
  }
);

async function respond(req: Request) {
  const actor = await resolveTenantActor({ request: req });
  if (!actor?.session.user?.id) {
    return new Response('Unauthorized', { status: 401 });
  }
  const session = actor.session;
  const organization = actor.organization;
  const [userKey, orgKey] = assistantRateKeys(session.user.id, organization.id);
  const [userGate, orgGate] = await Promise.all([
    rateLimit(userKey, ASSISTANT_LIMITS.userPerMinute, 60_000),
    rateLimit(orgKey, ASSISTANT_LIMITS.orgPerMinute, 60_000),
  ]);
  if (!userGate.ok || !orgGate.ok) {
    const retryAfter = Math.max(userGate.retryAfter, orgGate.retryAfter, 1);
    return Response.json(
      { error: 'Too many assistant requests.' },
      { status: 429, headers: { 'Retry-After': String(retryAfter) } }
    );
  }
  if (contentLengthTooLarge(req.headers.get('content-length'))) {
    return Response.json({ error: 'Assistant request is too large.' }, { status: 413 });
  }
  let rawBody: string;
  try {
    rawBody = await req.text();
  } catch {
    return Response.json({ error: 'Invalid assistant messages.' }, { status: 400 });
  }
  if (utf8Bytes(rawBody) > ASSISTANT_LIMITS.bodyBytes) {
    return Response.json({ error: 'Assistant request is too large.' }, { status: 413 });
  }
  const tenantDb = createTenantDb(organization.id);
  // Every POST (including approval continuations) rechecks current company chat policy.
  // Requests already past this gate are not cancelled when an administrator disables chat.
  const settings = await readAskFathomSettings(tenantDb, organization.id);
  if (!settings) {
    return Response.json({ error: UNAVAILABLE }, { status: 503 });
  }
  if (!settings.askFathomEnabled) {
    return Response.json(
      { error: 'Ask Fathom chat is disabled for your company.' },
      { status: 403 }
    );
  }

  let messages: UIMessage[];
  try {
    const body = JSON.parse(rawBody) as { messages?: unknown };
    messages = await validateUIMessages({ messages: body?.messages });
    if (
      !messages.length ||
      messages.some(
        (message) =>
          message.role === 'system' ||
          (message.role === 'user' && message.parts.some((part) => part.type !== 'text')) ||
          message.parts.some((part) => part.type === 'file')
      )
    )
      throw new Error('Invalid messages');
  } catch {
    return Response.json({ error: 'Invalid assistant messages.' }, { status: 400 });
  }
  if (messagesTooLarge(messages)) {
    return Response.json({ error: 'Assistant request is too large.' }, { status: 413 });
  }
  if (organization.isDemo) {
    return Response.json({ error: 'Not available in demo.' }, { status: 403 });
  }
  // Rechecked for every request, including approved tool continuations.
  if (!readAIAvailability().available) {
    return Response.json({ error: UNAVAILABLE }, { status: 503 });
  }
  const entitlements = await resolveOrganizationEntitlements(organization.id, tenantDb);

  const ctx = {
    organizationId: organization.id,
    vertical: assistantVertical(entitlements.vertical),
    userId: session.user.id,
    role: session.user.role ?? 'EMPLOYEE',
    name: session.user.name,
    email: session.user.email,
    department: session.user.department,
    status: session.user.status,
    enabledModules: entitlements.enabledModules,
  };

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
  // we load the full currently entitled set (one call) rather than risk hint-routing dropping it.
  const isApprovalContinuation = messages.some((m) =>
    (m.parts ?? []).some(
      (p) =>
        typeof (p as { state?: unknown }).state === 'string' &&
        (p as { state: string }).state === 'approval-responded'
    )
  );

  const hint = recentUserText(messages);
  const tools = buildAssistantTools(ctx, isApprovalContinuation ? {} : { hint });
  // Client approval history cannot resurrect a disabled or wrong-vertical tool.
  if (hasUnavailableApprovedTool(messages, new Set(Object.keys(tools)))) {
    return Response.json({ error: 'This action is no longer available.' }, { status: 403 });
  }
  let modelMessages;
  try {
    modelMessages = await convertToModelMessages(messages);
  } catch {
    return Response.json({ error: 'Invalid assistant messages.' }, { status: 400 });
  }
  let ai: ReturnType<typeof createAIModel>;
  try {
    ai = createAIModel();
  } catch {
    console.error('ASSISTANT_PROVIDER_UNAVAILABLE');
    return Response.json(
      { error: 'Ask Fathom is currently unavailable. No cached answer was used.' },
      { status: 503 }
    );
  }
  const result = streamText({
    model: ai.model,
    system: assistantSystemPrompt(ctx, Object.keys(tools)),
    messages: modelMessages,
    // Cost control: send only the tools relevant to what the user is asking
    // about (a core read set + the matched domain), not all ~96 every request.
    // The hint is the recent user text. See buildAssistantTools / tools.ts.
    tools,
    toolChoice: isApprovalContinuation ? 'auto' : assistantToolChoice(hint, tools),
    // Operator actions chain resolve → act → confirm; 6 steps covers that while
    // capping the worst-case number of (token-heavy) model round-trips per turn.
    stopWhen: stepCountIs(6),
    providerOptions: ai.providerOptions,
  });

  return result.toUIMessageStreamResponse({
    onError: () => {
      console.error('ASSISTANT_STREAM_FAILED');
      return UNAVAILABLE;
    },
  });
}
