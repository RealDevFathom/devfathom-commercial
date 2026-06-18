import 'dotenv/config';
import { generateText, stepCountIs } from 'ai';
import { groq } from '@ai-sdk/groq';
import { db } from '../src/lib/db';
import { buildAssistantTools } from '../src/lib/ai/tools';
import { assistantSystemPrompt } from '../src/lib/ai/prompt';

async function main() {
  const admin = await db.user.findFirst({
    where: { role: 'ADMIN' },
    select: { id: true, name: true, role: true },
  });
  if (!admin) throw new Error('no admin user found');
  const ctx = { userId: admin.id, role: admin.role, name: admin.name };

  // Wrap every tool execute so we SEE the real error instead of the masked one.
  const base = buildAssistantTools(ctx) as Record<string, any>;
  const tools: Record<string, any> = {};
  for (const [name, t] of Object.entries(base)) {
    tools[name] = {
      ...t,
      execute: async (a: any, o: any) => {
        try {
          const r = await t.execute(a, o);
          console.log(`  ✓ ${name} -> ${JSON.stringify(r).slice(0, 100)}`);
          return r;
        } catch (e: any) {
          console.log(`  ✗ ${name} THREW: ${e?.message ?? String(e)}`);
          throw e;
        }
      },
    };
  }

  const prompt = process.argv[2] ?? 'List employees';
  console.log(`\n=== prompt: "${prompt}" | model: ${process.env.GROQ_MODEL} ===`);
  try {
    const res = await generateText({
      model: groq(process.env.GROQ_MODEL ?? 'llama-3.3-70b-versatile'),
      system: assistantSystemPrompt(ctx),
      prompt,
      tools,
      stopWhen: stepCountIs(6),
      providerOptions: { groq: { parallelToolCalls: false } },
    });
    console.log('finishReason:', res.finishReason);
    res.steps.forEach((s: any, i: number) =>
      console.log(
        `  step ${i}: calls=[${s.toolCalls.map((t: any) => t.toolName).join(', ') || '-'}]`
      )
    );
    console.log('TEXT:', JSON.stringify(res.text).slice(0, 300));
  } catch (e: any) {
    console.log('TOP-LEVEL ERROR:', e?.name, '-', e?.message ?? String(e));
    if (e?.cause) console.log('CAUSE:', String(e.cause).slice(0, 400));
  }
}

main()
  .catch((e) => console.error('FATAL:', e?.message ?? e))
  .finally(() => process.exit(0));
