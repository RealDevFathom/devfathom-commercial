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
import { logAIProviderUnavailable, readAskFathomAvailability } from '@/lib/ai/ask-fathom-settings';
import { createAIModel } from '@/lib/ai/provider';
import { assistantToolChoice, buildAssistantTools } from '@/lib/ai/tools';
import { assistantSystemPrompt } from '@/lib/ai/prompt';
import { resolveAssistantLocale } from '@/lib/ai/locale';
import { createAnswerGuardTransform, GroundingEvidence } from '@/lib/ai/grounding';
import { assistantTurnTier } from '@/lib/ai/quick-lookup';
import { limitToolCalls } from '@/lib/ai/tool-call-limit';
import {
  ASK_FATHOM_MAX_MODEL_CALLS,
  ASK_FATHOM_MAX_TOOL_CALLS,
  ASK_FATHOM_TURN_TIMEOUT_MS,
  createTurnBudget,
} from '@/lib/ai/turn-budget';
import { responseForPasswordChange } from '@/lib/auth/session-state';
import { resolveTenantActor } from '@/lib/tenancy/tenant-actor';
import { createTenantDb } from '@/lib/tenancy/scoped-db';
import { resolveOrganizationEntitlements } from '@/lib/entitlements';
import { createActionLedgerContext, recordProposalsTransform } from '@/lib/ai/action-ledger';

// The turn itself stops at 90 s (ASK_FATHOM_TURN_TIMEOUT_MS); this leaves room to
// finish the stream and log after the deadline.
export const maxDuration = 120;

// The text of the last couple of user messages — used to route which tool
// domains to load (including the prior turn handles follow-ups like "do it").
function recentUserText(messages: UIMessage[], count = 2): string {
  const texts: string[] = [];
  for (let i = messages.length - 1; i >= 0 && texts.length < count; i--) {
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

// DEV-582: the latest user message alone decides whether an English workspace answers in Urdu.
function latestUserText(messages: UIMessage[]): string {
  const latest = messages.findLast((m) => m.role === 'user');
  return (latest?.parts ?? [])
    .map((p) => (p.type === 'text' && typeof p.text === 'string' ? p.text : ''))
    .join(' ');
}

const UNAVAILABLE = 'Ask Fathom is currently unavailable. No cached answer was used.';
const NOT_CONFIGURED = "Ask Fathom isn't set up yet, contact support.";

export async function POST(req: Request) {
  try {
    return await respond(req);
  } catch (error) {
    const passwordChange = responseForPasswordChange(error);
    if (passwordChange) return passwordChange;
    console.error('ASSISTANT_REQUEST_FAILED');
    return Response.json({ error: UNAVAILABLE }, { status: 503 });
  }
}

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
  // The launcher's askFathomSettings query uses this same check, so the two cannot disagree.
  const check = await readAskFathomAvailability(tenantDb, organization.id);
  if (!check) {
    return Response.json({ error: UNAVAILABLE }, { status: 503 });
  }
  if (!check.availability.askFathomEnabled) {
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
  // Rechecked for every request, including approved tool continuations. An unset,
  // disabled or incomplete provider (AI_PROVIDER, AI_MODEL, provider credentials) ends here.
  if (!check.provider.ready) {
    logAIProviderUnavailable('ASSISTANT_PROVIDER_UNAVAILABLE', check.provider);
    return Response.json({ error: NOT_CONFIGURED }, { status: 503 });
  }
  // The routed chain can also be off (SuperAdmin switch) or have every candidate
  // at its monthly spend cap: answer with the same unavailable state before streaming.
  if (check.routed && !check.routed.available) {
    console.error('ASSISTANT_PROVIDER_UNAVAILABLE', {
      reason: check.routed.reason,
      provider: 'auto',
    });
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
    // DEV-582: the answer language every tool reads from the assistant context: the
    // workspace locale, or Urdu when the user's latest message is written in Urdu script.
    locale: resolveAssistantLocale(organization.locale, latestUserText(messages)),
  };
  // DEV-576 write ledger: approval-gated writes run once, only as proposed.
  const ledger = createActionLedgerContext({ organizationId: organization.id, userId: ctx.userId });

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
  const assembled = buildAssistantTools(ctx, {
    ...(isApprovalContinuation ? {} : { hint }),
    ledger,
  });
  // Client approval history cannot resurrect a disabled or wrong-vertical tool.
  if (hasUnavailableApprovedTool(messages, new Set(Object.keys(assembled)))) {
    return Response.json({ error: 'This action is no longer available.' }, { status: 403 });
  }
  let modelMessages;
  try {
    modelMessages = await convertToModelMessages(messages);
  } catch {
    return Response.json({ error: 'Invalid assistant messages.' }, { status: 400 });
  }
  // One turn: at most 90 s, 4 model calls (every provider attempt, retries and
  // failovers included) and 6 tool calls.
  const turn = createTurnBudget();
  const tools = limitToolCalls(assembled, ASK_FATHOM_MAX_TOOL_CALLS);
  const toolChoice = isApprovalContinuation ? 'auto' : assistantToolChoice(hint, tools);
  const tier = assistantTurnTier({
    latestUserText: recentUserText(messages, 1),
    isApprovalContinuation,
    forcedTool: toolChoice !== 'auto',
    toolNames: Object.keys(tools),
  });
  // Every figure in the answer must come from this turn's tool results, the tools'
  // earlier results in the conversation or the user's own text.
  const evidence = new GroundingEvidence();
  evidence.addConversation(messages);
  let ai: ReturnType<typeof createAIModel>;
  try {
    ai = createAIModel(process.env, {
      feature: 'ask-fathom',
      organizationId: organization.id,
      tier,
      turn,
    });
  } catch {
    console.error('ASSISTANT_PROVIDER_UNAVAILABLE', {
      reason: 'MODEL_CREATE_FAILED',
      provider: check.provider.provider,
    });
    return Response.json({ error: UNAVAILABLE }, { status: 503 });
  }
  const result = streamText({
    model: ai.model,
    system: assistantSystemPrompt(ctx, Object.keys(tools)),
    messages: modelMessages,
    // Cost control: send only the tools relevant to what the user is asking
    // about (a core read set + the matched domain), not all ~96 every request.
    // The hint is the recent user text. See buildAssistantTools / tools.ts.
    tools,
    toolChoice,
    // Each step is one model call; the routed model also spends the shared turn
    // budget on every attempt, so a retry or failover cannot exceed it either.
    stopWhen: stepCountIs(ASK_FATHOM_MAX_MODEL_CALLS),
    // The router owns retries (one jittered retry, then failover); the SDK's own
    // retries would multiply attempts past the turn budget.
    maxRetries: 0,
    abortSignal: AbortSignal.any([req.signal, AbortSignal.timeout(ASK_FATHOM_TURN_TIMEOUT_MS)]),
    // 1. Record each approval request in the write ledger before its card leaves.
    // 2. Number grounding and the dosing guard on every text block.
    experimental_transform: [
      recordProposalsTransform(ledger),
      createAnswerGuardTransform<typeof tools>(evidence),
    ],
    providerOptions: ai.providerOptions,
    // Approvals are HMAC-signed and verified before any approved tool runs.
    experimental_toolApprovalSecret: ledger.approvalSecret,
  });

  return result.toUIMessageStreamResponse({
    onError: () => {
      console.error('ASSISTANT_STREAM_FAILED');
      return UNAVAILABLE;
    },
  });
}
