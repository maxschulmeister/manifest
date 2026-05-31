import {
  buildBootstrapCursorPrompt,
  buildIncrementalCursorPrompt,
  computeManifestContextFingerprint,
  cursorPromptToSdkUserMessage,
  estimateTokensFromText,
  openAiMessagesToContext,
} from './cursor-message-converter';

describe('cursor-message-converter', () => {
  it('converts OpenAI messages to bootstrap prompt text', () => {
    const context = openAiMessagesToContext({
      messages: [
        { role: 'system', content: 'Be helpful' },
        { role: 'user', content: 'Hello' },
      ],
    });
    const prompt = buildBootstrapCursorPrompt(context);
    expect(prompt.text).toContain('System instructions');
    expect(prompt.text).toContain('User: Hello');
  });

  it('builds incremental prompt from latest user message only', () => {
    const context = openAiMessagesToContext({
      messages: [
        { role: 'user', content: 'First' },
        { role: 'assistant', content: 'Hi' },
        { role: 'user', content: 'Second' },
      ],
    });
    const prompt = buildIncrementalCursorPrompt(context);
    expect(prompt.text).toContain('User: Second');
    expect(prompt.text).not.toContain('User: First');
  });

  it('formats assistant tool calls and tool results', () => {
    const context = openAiMessagesToContext({
      messages: [
        {
          role: 'assistant',
          content: '',
          tool_calls: [
            {
              id: 'call-1',
              type: 'function',
              function: { name: 'bash', arguments: '{"cmd":"ls"}' },
            },
          ],
        },
        { role: 'tool', tool_call_id: 'call-1', content: 'ok' },
      ],
    });
    const prompt = buildBootstrapCursorPrompt(context);
    expect(prompt.text).toContain('Tool call (bash');
    expect(prompt.text).toContain('Tool result (call-1)');
  });

  it('extracts base64 images from latest user message', () => {
    const context = openAiMessagesToContext({
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'see this' },
            {
              type: 'image_url',
              image_url: { url: 'data:image/png;base64,abc123' },
            },
          ],
        },
      ],
    });
    const prompt = buildBootstrapCursorPrompt(context);
    expect(prompt.images).toEqual([{ data: 'abc123', mimeType: 'image/png' }]);
    const sdk = cursorPromptToSdkUserMessage(prompt);
    expect(sdk.images).toHaveLength(1);
  });

  it('computes stable context fingerprints', () => {
    const context = { messages: [{ role: 'user', content: 'x' }] };
    expect(computeManifestContextFingerprint(context)).toBe(
      computeManifestContextFingerprint(context),
    );
  });

  it('estimates tokens from text length', () => {
    expect(estimateTokensFromText('abcd')).toBe(1);
    expect(estimateTokensFromText('a'.repeat(8))).toBe(2);
  });

  it('handles system-role rows and unknown roles in transcript', () => {
    const prompt = buildBootstrapCursorPrompt({
      systemPrompt: 'from field',
      messages: [
        { role: 'system', content: 'inline system' },
        { role: 'function', content: 'ignored' } as { role: string; content: string },
      ],
    });
    expect(prompt.text).toContain('System: inline system');
  });

  it('handles non-string non-array message content', () => {
    const context = openAiMessagesToContext({
      messages: [{ role: 'user', content: null as unknown as string }],
    });
    const prompt = buildBootstrapCursorPrompt(context);
    expect(prompt.text).not.toContain('User:');
  });

  it('skips invalid content blocks in multipart messages', () => {
    const context = openAiMessagesToContext({
      messages: [
        {
          role: 'user',
          content: [{ type: 'unknown' }, { type: 'text', text: 'hello' }],
        },
      ],
    });
    expect(buildBootstrapCursorPrompt(context).text).toContain('User: hello');
  });

  it('formats assistant messages with default tool name and empty content', () => {
    const prompt = buildBootstrapCursorPrompt({
      messages: [
        {
          role: 'assistant',
          content: '',
          tool_calls: [{ id: 'c1', type: 'function', function: { name: 'tool', arguments: '{}' } }],
        },
      ],
    });
    expect(prompt.text).toContain('Tool call (tool, c1)');
  });

  it('uses default tool id when tool_call_id missing', () => {
    const prompt = buildBootstrapCursorPrompt({
      messages: [{ role: 'tool', content: 'out' }],
    });
    expect(prompt.text).toContain('Tool result (tool)');
  });

  it('ignores non-data image URLs', () => {
    const prompt = buildBootstrapCursorPrompt({
      messages: [
        {
          role: 'user',
          content: [{ type: 'image_url', image_url: { url: 'https://example.com/x.png' } }],
        },
      ],
    });
    expect(prompt.images).toEqual([]);
  });

  it('returns empty context when messages missing', () => {
    expect(openAiMessagesToContext({})).toEqual({ messages: [] });
  });

  it('incremental prompt includes system instructions when set', () => {
    const prompt = buildIncrementalCursorPrompt({
      systemPrompt: 'Stay concise',
      messages: [],
    });
    expect(prompt.text).toContain('Stay concise');
  });
});
