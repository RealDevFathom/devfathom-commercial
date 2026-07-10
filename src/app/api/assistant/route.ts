import { streamText, convertToModelMessages, stepCountIs, type UIMessage } from 'ai';
import { google } from '@ai-sdk/google';
import { auth } from '@/lib/auth';
import { buildAssistantTools } from '@/lib/ai/tools';
import { assistantSystemPrompt } from '@/lib/ai/prompt';

// Allow headroom for multi-step tool runs.
export const maxDuration = 60;

const MODEL_ID = process.env.GEMINI_MODEL ?? 'gemini-2.5-flash';

// The text of the last couple of user messages — used to route which tool
// domains to load (including the prior turn handles follow-ups like "do it").
function recentUserText(messages: UIMessage[]): string {
  const texts: string[] = [];
  for (let i = messages.length - 1; i >= 0 && texts.length < 2; i--) {
    const m = messages[i];
    if (m.role !== 'user') continue;
    const t = (m.parts ?? [])
      .filter((p): p is { type: 'text'; text: string } => p.type === 'text' && typeof (p as { text?: unknown }).text === 'string')
      .map((p) => p.text)
      .join(' ');
    if (t.trim()) texts.push(t);
  }
  return texts.reverse().join(' \n ');
}

export async function POST(req: Request) {
  const session = await auth();
  if (!session?.user?.id) {
    return new Response('Unauthorized', { status: 401 });
  }

  const { messages }: { messages: UIMessage[] } = await req.json();

  const ctx = {
    userId: session.user.id,
    role: session.user.role ?? 'EMPLOYEE',
    name: session.user.name,
    email: session.user.email,
    department: session.user.department,
    status: session.user.status,
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
      (p) => typeof (p as { state?: unknown }).state === 'string' &&
        (p as { state: string }).state === 'approval-responded'
    )
  );

  const result = streamText({
    model: google(MODEL_ID),
    system: assistantSystemPrompt(ctx),
    messages: modelMessages,
    // Cost control: send only the tools relevant to what the user is asking
    // about (a core read set + the matched domain), not all ~96 every request.
    // The hint is the recent user text. See buildAssistantTools / tools.ts.
    tools: buildAssistantTools(ctx, isApprovalContinuation ? {} : { hint: recentUserText(messages) }),
    // Operator actions chain resolve → act → confirm; 6 steps covers that while
    // capping the worst-case number of (token-heavy) model round-trips per turn.
    stopWhen: stepCountIs(6),
    onError: ({ error }) => {
      console.error('[assistant] stream error:', error);
    },
  });

  return result.toUIMessageStreamResponse({
    onError: (error) => {
      console.error('[assistant] surfaced error:', error);
      return 'Sorry — I hit a snag with that. Please try again or rephrase.';
    },
  });
}
