import {
  applyToolOutputCompression,
  compressToolOutputText,
} from '../src/tool-output-compression';

describe('tool-output-compression', () => {
  describe('compressToolOutputText', () => {
    it('returns unchanged text when compression saves no length', () => {
      const text = 'ok';
      expect(compressToolOutputText(text)).toBe(text);
    });

    it('strips ANSI sequences and deduplicates repeated lines', () => {
      const text = [
        '\u001b[32mPASS\u001b[0m test/a.spec.ts',
        'PASS test/a.spec.ts',
        'PASS test/a.spec.ts',
        'PASS test/a.spec.ts',
        'FAIL test/b.spec.ts',
      ].join('\n');
      const result = compressToolOutputText(text);
      expect(result).not.toContain('\u001b[');
      expect(result).toContain('[x4] PASS test/a.spec.ts');
      expect(result).toContain('FAIL test/b.spec.ts');
      expect(result.length).toBeLessThan(text.length);
    });

    it('removes empty and spinner noise lines', () => {
      const text = ['', '   ', '⠋ loading', 'done', 'done'].join('\n');
      const result = compressToolOutputText(text);
      expect(result).not.toMatch(/⠋/);
      expect(result).toContain('[x2] done');
      expect(result.length).toBeLessThan(text.length);
    });

    it('truncates very large logs while preserving head and tail', () => {
      const head = Array.from({ length: 400 }, (_, i) => `Error ${i}: build failed`).join('\n');
      const middle = Array.from({ length: 2000 }, (_, i) => `noise line ${i}`).join('\n');
      const tail = 'Summary: 1 failed, 99 passed\n';
      const text = `${head}\n${middle}\n${tail}`;
      const result = compressToolOutputText(text);
      expect(result.length).toBeLessThan(text.length);
      expect(result).toContain('Error 0: build failed');
      expect(result).toContain('Summary: 1 failed, 99 passed');
      expect(result).toMatch(/\[truncated \d+ chars\]/);
    });

    it('keeps git-style status output compact via deduplication', () => {
      const text = [
        ' M packages/shared/src/index.ts',
        ' M packages/shared/src/index.ts',
        '?? packages/shared/src/new.ts',
      ].join('\n');
      const result = compressToolOutputText(text);
      expect(result).toContain('[x2]  M packages/shared/src/index.ts');
      expect(result.length).toBeLessThan(text.length);
    });

    it('returns empty strings unchanged', () => {
      expect(compressToolOutputText('')).toBe('');
    });
  });

  describe('applyToolOutputCompression — chat_completions', () => {
    it('compresses tool messages only', () => {
      const log = ['\u001b[31merr\u001b[0m', 'err', 'err'].join('\n');
      const body = {
        messages: [
          { role: 'user', content: 'run tests' },
          { role: 'tool', tool_call_id: 'call_1', content: log },
          { role: 'assistant', content: 'done' },
        ],
      };
      const userBefore = body.messages[0].content;
      const assistantBefore = body.messages[2].content;
      applyToolOutputCompression(body, 'chat_completions');
      expect(body.messages[0].content).toBe(userBefore);
      expect(body.messages[2].content).toBe(assistantBefore);
      expect(String(body.messages[1].content).length).toBeLessThan(log.length);
    });

    it('compresses text blocks in multipart tool content', () => {
      const log = ['line', 'line', 'line'].join('\n');
      const body = {
        messages: [
          {
            role: 'tool',
            tool_call_id: 'call_1',
            content: [{ type: 'text', text: log }],
          },
        ],
      };
      applyToolOutputCompression(body, 'chat_completions');
      const part = body.messages[0].content[0] as { text: string };
      expect(part.text).toContain('[x3] line');
    });

    it('leaves tool content unchanged when compression saves no length', () => {
      const body = {
        messages: [{ role: 'tool', tool_call_id: 'call_1', content: 'ok' }],
      };
      applyToolOutputCompression(body, 'chat_completions');
      expect(body.messages[0].content).toBe('ok');
    });

    it('compresses legacy function-role messages', () => {
      const log = ['err', 'err', 'err'].join('\n');
      const body = {
        messages: [{ role: 'function', name: 'bash', content: log }],
      };
      applyToolOutputCompression(body, 'chat_completions');
      expect(String(body.messages[0].content)).toContain('[x3] err');
    });

    it('preserves non-text multipart tool blocks', () => {
      const body = {
        messages: [
          {
            role: 'tool',
            tool_call_id: 'call_1',
            content: [{ type: 'image_url', image_url: { url: 'x' } }, { type: 'text', text: 'ok' }],
          },
        ],
      };
      applyToolOutputCompression(body, 'chat_completions');
      expect(body.messages[0].content[0]).toEqual({
        type: 'image_url',
        image_url: { url: 'x' },
      });
      expect(body.messages[0].content[1]).toEqual({ type: 'text', text: 'ok' });
    });

    it('ignores bodies without a messages array', () => {
      const body: Record<string, unknown> = { model: 'gpt-4o' };
      applyToolOutputCompression(body, 'chat_completions');
      expect(body).toEqual({ model: 'gpt-4o' });
    });
  });

  describe('applyToolOutputCompression — responses', () => {
    it('compresses function_call_output items in input', () => {
      const log = ['Downloading package', 'Downloading package', 'Downloading package'].join('\n');
      const body = {
        input: [
          { role: 'user', content: 'run' },
          { type: 'function_call_output', call_id: 'call_1', output: log },
        ],
      };
      applyToolOutputCompression(body, 'responses');
      expect(body.input[0]).toEqual({ role: 'user', content: 'run' });
      expect(String(body.input[1].output)).toContain('[x3] Downloading package');
      expect(String(body.input[1].output).length).toBeLessThan(log.length);
    });

    it('compresses structured function_call_output payloads', () => {
      const body = {
        input: [
          {
            type: 'function_call_output',
            call_id: 'call_1',
            output: { log: `${'Error: build failed\n'.repeat(1600)}Summary: done\n` },
          },
        ],
      };
      const before = JSON.stringify(body.input[0].output);
      applyToolOutputCompression(body, 'responses');
      expect(String(body.input[0].output).length).toBeLessThan(before.length);
      expect(String(body.input[0].output)).toMatch(/\[truncated \d+ chars\]/);
    });

    it('leaves null function_call_output unchanged', () => {
      const body = {
        input: [{ type: 'function_call_output', call_id: 'call_1', output: null }],
      };
      applyToolOutputCompression(body, 'responses');
      expect(body.input[0].output).toBeNull();
    });

    it('ignores bodies without an input array', () => {
      const body: Record<string, unknown> = { model: 'gpt-4o' };
      applyToolOutputCompression(body, 'responses');
      expect(body).toEqual({ model: 'gpt-4o' });
    });
  });

  describe('applyToolOutputCompression — messages', () => {
    it('compresses tool_result blocks in user messages', () => {
      const log = ['npm ERR! missing script', 'npm ERR! missing script'].join('\n');
      const body = {
        messages: [
          {
            role: 'user',
            content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: log }],
          },
        ],
      };
      applyToolOutputCompression(body, 'messages');
      const block = body.messages[0].content[0] as { content: string };
      expect(block.content).toContain('[x2] npm ERR! missing script');
    });

    it('compresses multipart tool_result text blocks', () => {
      const log = ['line', 'line', 'line'].join('\n');
      const body = {
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'tool_result',
                tool_use_id: 'tu_1',
                content: [{ type: 'text', text: log }],
              },
            ],
          },
        ],
      };
      applyToolOutputCompression(body, 'messages');
      const block = body.messages[0].content[0] as { content: Array<{ text: string }> };
      expect(block.content[0].text).toContain('[x3] line');
    });

    it('preserves non-text blocks inside tool_result content arrays', () => {
      const body = {
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'tool_result',
                tool_use_id: 'tu_1',
                content: [{ type: 'image', source: { type: 'base64', data: 'abc' } }],
              },
            ],
          },
        ],
      };
      applyToolOutputCompression(body, 'messages');
      expect(body.messages[0].content[0]).toEqual({
        type: 'tool_result',
        tool_use_id: 'tu_1',
        content: [{ type: 'image', source: { type: 'base64', data: 'abc' } }],
      });
    });

    it('leaves non-tool user blocks unchanged', () => {
      const body = {
        messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
      };
      applyToolOutputCompression(body, 'messages');
      expect(body.messages[0].content[0]).toEqual({ type: 'text', text: 'hello' });
    });
  });
});
