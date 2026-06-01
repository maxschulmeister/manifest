import {
  applyPromptCompression,
  compressUserPromptText,
} from '../src/prompt-compression';

describe('prompt-compression', () => {
  describe('compressUserPromptText', () => {
    it('returns unchanged text when compression saves no length', () => {
      const text = 'Fix bug in auth.ts';
      expect(compressUserPromptText(text)).toBe(text);
    });

    it('shortens verbose prose while preserving code fences', () => {
      const text =
        'I would really like you to basically just explain please how this works.\n\n```ts\nconst x = 1;\n```\n\nThanks!';
      const result = compressUserPromptText(text);
      expect(result.length).toBeLessThan(text.length);
      expect(result).toContain('```ts\nconst x = 1;\n```');
    });

    it('preserves inline code, URLs, paths, env vars, and error lines', () => {
      const text =
        'Please really just check `auth.ts`, visit https://example.com/docs, read /var/log/app.log, use $API_KEY and %USERPROFILE%, then fix.\nError: ENOENT missing file\n    at main (/app/index.ts:12:3)';
      const result = compressUserPromptText(text);
      expect(result).toContain('`auth.ts`');
      expect(result).toContain('https://example.com/docs');
      expect(result).toContain('/var/log/app.log');
      expect(result).toContain('$API_KEY');
      expect(result).toContain('%USERPROFILE%');
      expect(result).toContain('Error: ENOENT missing file');
      expect(result).toContain('at main (/app/index.ts:12:3)');
    });

    it('keeps original when protected regions fail validation', () => {
      const text = 'short';
      expect(compressUserPromptText(text)).toBe(text);
    });
  });

  describe('applyPromptCompression — chat_completions', () => {
    it('compresses user messages only', () => {
      const body = {
        messages: [
          { role: 'system', content: 'You are really very helpful please.' },
          {
            role: 'user',
            content:
              'I would really like you to basically just summarize this please in one sentence.',
          },
          { role: 'assistant', content: 'I would really like to help you with that certainly.' },
        ],
      };
      const systemBefore = body.messages[0].content;
      const assistantBefore = body.messages[2].content;
      applyPromptCompression(body, 'chat_completions');
      expect(body.messages[0].content).toBe(systemBefore);
      expect(body.messages[2].content).toBe(assistantBefore);
      expect(String(body.messages[1].content).length).toBeLessThan(
        'I would really like you to basically just summarize this please in one sentence.'.length,
      );
    });

    it('compresses text blocks in multipart user content', () => {
      const longText =
        'I would really like you to basically just explain please what this means.';
      const body = {
        messages: [
          {
            role: 'user',
            content: [{ type: 'text', text: longText }, { type: 'input_image', image_url: 'x' }],
          },
        ],
      };
      applyPromptCompression(body, 'chat_completions');
      const part = body.messages[0].content[0] as { text: string };
      expect(part.text.length).toBeLessThan(longText.length);
      expect(body.messages[0].content[1]).toEqual({ type: 'input_image', image_url: 'x' });
    });
  });

  describe('applyPromptCompression — responses', () => {
    it('compresses string input', () => {
      const input =
        'I would really like you to basically just tell me please what happened.';
      const body: Record<string, unknown> = { input };
      applyPromptCompression(body, 'responses');
      expect(String(body.input).length).toBeLessThan(input.length);
    });

    it('compresses user items in array input', () => {
      const body: Record<string, unknown> = {
        input: [
          {
            role: 'user',
            content:
              'I would really like you to basically just summarize this please in one sentence.',
          },
          { role: 'assistant', content: 'Certainly I would really like to help you.' },
        ],
      };
      applyPromptCompression(body, 'responses');
      const items = body.input as { role: string; content: string }[];
      expect(items[0].content.length).toBeLessThan(
        'I would really like you to basically just summarize this please in one sentence.'.length,
      );
      expect(items[1].content).toBe('Certainly I would really like to help you.');
    });

    it('compresses plain string items and multipart user content in array input', () => {
      const longText =
        'I would really like you to basically just explain please what this means.';
      const body: Record<string, unknown> = {
        input: [
          longText,
          {
            role: 'user',
            content: [{ type: 'input_text', text: longText }],
          },
          42,
        ],
      };
      applyPromptCompression(body, 'responses');
      const items = body.input as unknown[];
      expect(String(items[0]).length).toBeLessThan(longText.length);
      const part = (items[1] as { content: { text: string }[] }).content[0];
      expect(part.text.length).toBeLessThan(longText.length);
      expect(items[2]).toBe(42);
    });

    it('leaves user items with non-text content unchanged', () => {
      const item = { role: 'user', content: { type: 'input_image', image_url: 'x' } };
      const body: Record<string, unknown> = { input: [item] };
      applyPromptCompression(body, 'responses');
      expect(body.input).toEqual([item]);
    });
  });

  describe('applyPromptCompression — messages', () => {
    it('compresses user messages and leaves system untouched', () => {
      const body = {
        system: 'You are really very helpful please.',
        messages: [
          {
            role: 'user',
            content:
              'I would really like you to basically just summarize this please in one sentence.',
          },
        ],
      };
      applyPromptCompression(body, 'messages');
      expect(body.system).toBe('You are really very helpful please.');
      expect(String(body.messages[0].content).length).toBeLessThan(
        'I would really like you to basically just summarize this please in one sentence.'.length,
      );
    });
  });
});
