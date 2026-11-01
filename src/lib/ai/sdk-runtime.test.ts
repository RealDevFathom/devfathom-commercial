// @vitest-environment node

import { generateText, Output, tool } from 'ai';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { createAIModel } from './provider';

// Keep the SDK and provider adapter real: mocking either hides incompatible
// dependency overrides and regressions at the v3-provider/v7-core boundary.
function model() {
  return createAIModel({
    AI_PROVIDER: 'google',
    AI_MODEL: 'gemini-2.5-flash',
    GOOGLE_GENERATIVE_AI_API_KEY: 'synthetic-test-key',
  }).model;
}

function mockResponse(parts: unknown[]) {
  const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
    Response.json({
      candidates: [{ content: { role: 'model', parts }, finishReason: 'STOP' }],
      usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 },
    })
  );
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

afterEach(() => vi.unstubAllGlobals());

describe('installed AI SDK with the configured provider adapter', () => {
  it('generates validated structured output without replacing the SDK or adapter', async () => {
    const fetchMock = mockResponse([{ text: '{"summary":"Synthetic summary"}' }]);
    const result = await generateText({
      model: model(),
      system: 'Summarize only the supplied data.',
      prompt: 'Synthetic data',
      output: Output.object({ schema: z.object({ summary: z.string() }) }),
      maxRetries: 0,
    });

    expect(result.output).toEqual({ summary: 'Synthetic summary' });
    expect(result.finishReason).toBe('stop');
    expect(fetchMock).toHaveBeenCalledOnce();
    const [, options] = fetchMock.mock.calls[0];
    expect(JSON.parse(options!.body as string)).toMatchObject({
      systemInstruction: { parts: [{ text: 'Summarize only the supplied data.' }] },
      generationConfig: { responseMimeType: 'application/json' },
    });
  });

  it('requires approval before executing a write tool with the real SDK', async () => {
    mockResponse([{ functionCall: { name: 'createNote', args: { title: 'Synthetic note' } } }]);
    const execute = vi.fn(async () => ({ success: true }));
    const result = await generateText({
      model: model(),
      prompt: 'Create a note.',
      tools: {
        createNote: tool({
          inputSchema: z.object({ title: z.string() }),
          needsApproval: true,
          execute,
        }),
      },
      maxRetries: 0,
    });

    expect(result.toolCalls).toMatchObject([
      { toolName: 'createNote', input: { title: 'Synthetic note' } },
    ]);
    expect(result.content).toEqual(
      expect.arrayContaining([expect.objectContaining({ type: 'tool-approval-request' })])
    );
    expect(execute).not.toHaveBeenCalled();
  });
});
