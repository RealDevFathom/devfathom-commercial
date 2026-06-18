import { streamText, convertToModelMessages, stepCountIs, type UIMessage } from 'ai';
import { groq } from '@ai-sdk/groq';
import { auth } from '@/lib/auth';
import { buildAssistantTools } from '@/lib/ai/tools';
import { assistantSystemPrompt } from '@/lib/ai/prompt';

// Groq is fast, but allow headroom for multi-step tool runs.
export const maxDuration = 60;

const MODEL_ID = process.env.GROQ_MODEL ?? 'openai/gpt-oss-120b';

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
  };

  const modelMessages = await convertToModelMessages(messages);

  const result = streamText({
    model: groq(MODEL_ID),
    system: assistantSystemPrompt(ctx),
    messages: modelMessages,
    tools: buildAssistantTools(ctx),
    // Allow the model to chain tool calls (e.g. listProjects → createTask) and
    // then summarise, before the turn ends.
    stopWhen: stepCountIs(6),
    // One tool call per step. Without this, weaker models fire many parallel /
    // duplicate calls — most fail and get masked as "An error occurred."
    providerOptions: { groq: { parallelToolCalls: false } },
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
