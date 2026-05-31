import {
  buildOpenAiChatCompletion,
  buildOpenAiSseStream,
  estimateUsage,
  extractAssistantTextFromSdkMessage,
  openAiJsonResponse,
  openAiSseResponse,
} from './cursor-openai-stream';

describe('cursor-openai-stream', () => {
  it('extracts assistant text blocks from SDK messages', () => {
    const text = extractAssistantTextFromSdkMessage({
      type: 'assistant',
      agent_id: 'a1',
      run_id: 'r1',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'Hello world' }],
      },
    });
    expect(text).toBe('Hello world');
  });

  it('ignores assistant messages without text blocks', () => {
    expect(
      extractAssistantTextFromSdkMessage({
        type: 'assistant',
        agent_id: 'a1',
        run_id: 'r1',
        message: { role: 'assistant', content: 'plain string' },
      } as never),
    ).toBe('');
  });

  it('ignores non-assistant SDK messages', () => {
    expect(
      extractAssistantTextFromSdkMessage({
        type: 'status',
        agent_id: 'a1',
        run_id: 'r1',
        status: 'RUNNING',
      }),
    ).toBe('');
  });

  it('builds OpenAI chat completion JSON', () => {
    const body = buildOpenAiChatCompletion('cursor/composer-2.5', 'Hi', {
      prompt_tokens: 10,
      completion_tokens: 5,
    });
    expect(body.choices).toEqual([
      expect.objectContaining({
        message: { role: 'assistant', content: 'Hi' },
      }),
    ]);
  });

  it('builds SSE stream ending with DONE', async () => {
    const stream = buildOpenAiSseStream('cursor/m', 'x', {
      prompt_tokens: 1,
      completion_tokens: 1,
    });
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let combined = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      combined += decoder.decode(value);
    }
    expect(combined).toContain('"content":"x"');
    expect(combined).toContain('data: [DONE]');
  });

  it('wraps json and sse responses', () => {
    const json = openAiJsonResponse({ ok: true });
    expect(json.headers.get('Content-Type')).toBe('application/json');
    const sse = openAiSseResponse(
      buildOpenAiSseStream('m', 't', { prompt_tokens: 1, completion_tokens: 1 }),
    );
    expect(sse.headers.get('Content-Type')).toBe('text/event-stream');
  });

  it('estimates usage from prompt and completion text', () => {
    expect(estimateUsage('1234', 'ab')).toEqual({
      prompt_tokens: 1,
      completion_tokens: 1,
    });
  });
});
