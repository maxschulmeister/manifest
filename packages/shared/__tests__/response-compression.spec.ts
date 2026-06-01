import {
  RESPONSE_COMPRESSION_INSTRUCTION,
  RESPONSE_COMPRESSION_MARKER,
  applyResponseCompressionInstruction,
  requestBodyHasResponseCompressionMarker,
} from '../src/response-compression';

describe('response-compression', () => {
  describe('requestBodyHasResponseCompressionMarker', () => {
    it('returns false when marker is absent', () => {
      expect(
        requestBodyHasResponseCompressionMarker(
          { messages: [{ role: 'user', content: 'hi' }] },
          'chat_completions',
        ),
      ).toBe(false);
    });

    it('returns true when marker is present in chat messages', () => {
      expect(
        requestBodyHasResponseCompressionMarker(
          {
            messages: [
              { role: 'system', content: `prefix ${RESPONSE_COMPRESSION_MARKER} suffix` },
            ],
          },
          'chat_completions',
        ),
      ).toBe(true);
    });
  });

  describe('applyResponseCompressionInstruction — chat_completions', () => {
    it('prepends a system message when none exists', () => {
      const body = { messages: [{ role: 'user', content: 'hi' }] };
      applyResponseCompressionInstruction(body, 'chat_completions');
      expect(body.messages[0]).toEqual({
        role: 'system',
        content: RESPONSE_COMPRESSION_INSTRUCTION,
      });
    });

    it('appends to an existing system message', () => {
      const body = {
        messages: [
          { role: 'system', content: 'Be helpful.' },
          { role: 'user', content: 'hi' },
        ],
      };
      applyResponseCompressionInstruction(body, 'chat_completions');
      expect(body.messages[0].content).toContain('Be helpful.');
      expect(body.messages[0].content).toContain(RESPONSE_COMPRESSION_MARKER);
      expect(body.messages).toHaveLength(2);
    });

    it('is idempotent when marker is already present', () => {
      const body = {
        messages: [
          { role: 'system', content: RESPONSE_COMPRESSION_INSTRUCTION },
          { role: 'user', content: 'hi' },
        ],
      };
      const before = JSON.stringify(body);
      applyResponseCompressionInstruction(body, 'chat_completions');
      expect(JSON.stringify(body)).toBe(before);
    });
  });

  describe('applyResponseCompressionInstruction — responses', () => {
    it('sets instructions when absent', () => {
      const body: Record<string, unknown> = { input: 'hello' };
      applyResponseCompressionInstruction(body, 'responses');
      expect(body.instructions).toBe(RESPONSE_COMPRESSION_INSTRUCTION);
    });

    it('appends to existing instructions', () => {
      const body: Record<string, unknown> = { instructions: 'Be helpful.', input: 'hello' };
      applyResponseCompressionInstruction(body, 'responses');
      expect(body.instructions).toContain('Be helpful.');
      expect(body.instructions).toContain(RESPONSE_COMPRESSION_MARKER);
    });
  });

  describe('applyResponseCompressionInstruction — messages', () => {
    it('sets string system when absent', () => {
      const body: Record<string, unknown> = {
        messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      };
      applyResponseCompressionInstruction(body, 'messages');
      expect(body.system).toBe(RESPONSE_COMPRESSION_INSTRUCTION);
    });

    it('appends to existing string system', () => {
      const body: Record<string, unknown> = {
        system: 'Be helpful.',
        messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      };
      applyResponseCompressionInstruction(body, 'messages');
      expect(body.system).toContain('Be helpful.');
      expect(body.system).toContain(RESPONSE_COMPRESSION_MARKER);
    });

    it('appends to the last text block in array system', () => {
      const body: Record<string, unknown> = {
        system: [{ type: 'text', text: 'Be helpful.' }],
        messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      };
      applyResponseCompressionInstruction(body, 'messages');
      const system = body.system as Array<{ text: string }>;
      expect(system[0].text).toContain('Be helpful.');
      expect(system[0].text).toContain(RESPONSE_COMPRESSION_MARKER);
    });

    it('adds a text block when system array has no text parts', () => {
      const body: Record<string, unknown> = {
        system: [{ type: 'image', source: { type: 'base64', data: 'abc' } }],
        messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      };
      applyResponseCompressionInstruction(body, 'messages');
      const system = body.system as Array<{ type: string; text?: string }>;
      expect(system.some((p) => p.text?.includes(RESPONSE_COMPRESSION_MARKER))).toBe(true);
    });
  });

  describe('edge cases', () => {
    it('creates messages when chat body has no messages array', () => {
      const body: Record<string, unknown> = { model: 'gpt-4o' };
      applyResponseCompressionInstruction(body, 'chat_completions');
      expect(body.messages).toEqual([
        { role: 'system', content: RESPONSE_COMPRESSION_INSTRUCTION },
      ]);
    });

    it('appends to developer-role messages', () => {
      const body = {
        messages: [
          { role: 'developer', content: 'Be helpful.' },
          { role: 'user', content: 'hi' },
        ],
      };
      applyResponseCompressionInstruction(body, 'chat_completions');
      expect(body.messages[0].content).toContain(RESPONSE_COMPRESSION_MARKER);
    });

    it('appends to system message array content that already has text blocks', () => {
      const body = {
        messages: [
          { role: 'system', content: [{ type: 'text', text: 'Be helpful.' }] },
          { role: 'user', content: 'hi' },
        ],
      };
      applyResponseCompressionInstruction(body, 'chat_completions');
      const content = body.messages[0].content as Array<{ text: string }>;
      expect(content[0].text).toContain(RESPONSE_COMPRESSION_MARKER);
    });

    it('replaces non-string non-array system content with the instruction', () => {
      const body = {
        messages: [{ role: 'system', content: null }, { role: 'user', content: 'hi' }],
      };
      applyResponseCompressionInstruction(body, 'chat_completions');
      expect(body.messages[0].content).toBe(RESPONSE_COMPRESSION_INSTRUCTION);
    });

    it('appends a text block to system messages with non-text array content', () => {
      const body = {
        messages: [
          { role: 'system', content: [{ type: 'image_url', image_url: { url: 'x' } }] },
          { role: 'user', content: 'hi' },
        ],
      };
      applyResponseCompressionInstruction(body, 'chat_completions');
      const content = body.messages[0].content as Array<{ type: string; text?: string }>;
      expect(content.some((p) => p.text?.includes(RESPONSE_COMPRESSION_MARKER))).toBe(true);
    });

    it('falls back to field checks when JSON.stringify throws', () => {
      const body: Record<string, unknown> = {
        messages: [{ role: 'system', content: RESPONSE_COMPRESSION_MARKER }],
      };
      const original = JSON.stringify;
      JSON.stringify = () => {
        throw new Error('circular');
      };
      try {
        expect(requestBodyHasResponseCompressionMarker(body, 'chat_completions')).toBe(true);
      } finally {
        JSON.stringify = original;
      }
    });
  });
});
