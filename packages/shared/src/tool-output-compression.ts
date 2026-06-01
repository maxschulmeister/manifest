/**
 * Tool-output log compression adapted from LogStrip (MIT):
 * https://github.com/mrwogu/logstrip
 *
 * Copyright (c) LogStrip contributors
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

export type ToolOutputCompressionApiMode = 'chat_completions' | 'responses' | 'messages';

type JsonRecord = Record<string, unknown>;

const ANSI_ESCAPE = /\u001b(?:\[[0-9?;]*[ -/]*[@-~]|\][^\u0007]*(?:\u0007|\u001b\\))/g;
const NOISE_LINE = /^(?:\s*|[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏][^\n]*|[\-\\|/]+\s*|\.*\s*)$/;
const MAX_OUTPUT_CHARS = 32_768;
const TRUNCATION_HEAD_CHARS = 12_000;
const TRUNCATION_TAIL_CHARS = 4_000;

function isRecord(value: unknown): value is JsonRecord {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function stripAnsi(text: string): string {
  return text.replace(ANSI_ESCAPE, '');
}

function isNoiseLine(line: string): boolean {
  return NOISE_LINE.test(line);
}

function dedupeConsecutiveLines(text: string): string {
  const lines = text.split('\n');
  const kept: string[] = [];
  let prevLine: string | null = null;
  let repeatCount = 0;

  const flush = (): void => {
    if (prevLine === null) return;
    if (repeatCount > 0) {
      kept.push(`[x${repeatCount + 1}] ${prevLine}`);
    } else {
      kept.push(prevLine);
    }
    prevLine = null;
    repeatCount = 0;
  };

  for (const rawLine of lines) {
    const line = rawLine.trimEnd();
    if (isNoiseLine(line)) continue;

    if (line === prevLine) {
      repeatCount++;
      continue;
    }

    flush();
    prevLine = line;
    repeatCount = 0;
  }

  flush();
  return kept.join('\n');
}

function truncateIfNeeded(text: string): string {
  if (text.length <= MAX_OUTPUT_CHARS) return text;

  const omitted = text.length - TRUNCATION_HEAD_CHARS - TRUNCATION_TAIL_CHARS;
  if (omitted <= 0) return text.slice(0, MAX_OUTPUT_CHARS);

  const head = text.slice(0, TRUNCATION_HEAD_CHARS);
  const tail = text.slice(-TRUNCATION_TAIL_CHARS);
  return `${head}\n...[truncated ${omitted} chars]...\n${tail}`;
}

export function compressToolOutputText(text: string): string {
  if (!text) return text;

  const stripped = stripAnsi(text);
  const deduped = dedupeConsecutiveLines(stripped);
  const truncated = truncateIfNeeded(deduped);

  if (truncated.length >= text.length) return text;
  return truncated;
}

function compressMaybeText(value: string): string {
  return compressToolOutputText(value);
}

function compressToolContent(content: unknown): unknown {
  if (typeof content === 'string') return compressMaybeText(content);
  if (!Array.isArray(content)) return content;

  return content.map((part) => {
    if (isRecord(part) && typeof part.text === 'string') {
      const compressed = compressMaybeText(part.text);
      if (compressed !== part.text) return { ...part, text: compressed };
    }
    return part;
  });
}

function compressToolResultBlockContent(content: unknown): unknown {
  if (typeof content === 'string') return compressMaybeText(content);
  if (!Array.isArray(content)) return content;

  return content.map((part) => {
    if (isRecord(part) && typeof part.text === 'string') {
      const compressed = compressMaybeText(part.text);
      if (compressed !== part.text) return { ...part, text: compressed };
    }
    return part;
  });
}

function injectChatCompletions(body: JsonRecord): void {
  const messages = body.messages;
  if (!Array.isArray(messages)) return;

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (!isRecord(msg)) continue;
    if (msg.role !== 'tool' && msg.role !== 'function') continue;
    messages[i] = { ...msg, content: compressToolContent(msg.content) };
  }
}

function injectResponses(body: JsonRecord): void {
  if (!Array.isArray(body.input)) return;

  body.input = body.input.map((item) => {
    if (!isRecord(item) || item.type !== 'function_call_output') return item;

    if (typeof item.output === 'string') {
      const compressed = compressMaybeText(item.output);
      if (compressed === item.output) return item;
      return { ...item, output: compressed };
    }

    if (item.output == null) return item;

    const serialized = typeof item.output === 'string' ? item.output : JSON.stringify(item.output);
    const compressed = compressMaybeText(serialized);
    if (compressed === serialized) return item;
    return { ...item, output: compressed };
  });
}

function injectAnthropicMessages(body: JsonRecord): void {
  const messages = body.messages;
  if (!Array.isArray(messages)) return;

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (!isRecord(msg) || msg.role !== 'user' || !Array.isArray(msg.content)) continue;

    let changed = false;
    const content = msg.content.map((block) => {
      if (!isRecord(block) || block.type !== 'tool_result') return block;
      const compressed = compressToolResultBlockContent(block.content);
      if (compressed === block.content) return block;
      changed = true;
      return { ...block, content: compressed };
    });

    if (changed) {
      messages[i] = { ...msg, content };
    }
  }
}

export function applyToolOutputCompression(
  body: JsonRecord,
  apiMode: ToolOutputCompressionApiMode,
): JsonRecord {
  if (apiMode === 'responses') {
    injectResponses(body);
  } else if (apiMode === 'messages') {
    injectAnthropicMessages(body);
  } else {
    injectChatCompletions(body);
  }

  return body;
}
