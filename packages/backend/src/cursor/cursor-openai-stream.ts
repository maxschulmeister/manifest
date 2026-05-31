import { randomUUID } from 'node:crypto';
import type { SDKMessage } from '@cursor/sdk';
import type { StreamUsage } from '../routing/proxy/stream-writer';
import { estimateTokensFromText } from './cursor-message-converter';

function isTextBlock(block: unknown): block is { type: 'text'; text: string } {
  return (
    typeof block === 'object' &&
    block !== null &&
    (block as { type?: string }).type === 'text' &&
    typeof (block as { text?: string }).text === 'string'
  );
}

export function extractAssistantTextFromSdkMessage(message: SDKMessage): string {
  if (message.type !== 'assistant') return '';
  const content = message.message.content;
  if (!Array.isArray(content)) return '';
  return content
    .filter(isTextBlock)
    .map((b) => b.text)
    .join('');
}

export function buildOpenAiChatCompletion(
  model: string,
  content: string,
  usage: StreamUsage,
): Record<string, unknown> {
  return {
    id: `chatcmpl-${randomUUID()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content },
        finish_reason: 'stop',
      },
    ],
    usage: {
      prompt_tokens: usage.prompt_tokens,
      completion_tokens: usage.completion_tokens,
      total_tokens: usage.prompt_tokens + usage.completion_tokens,
    },
  };
}

export function buildOpenAiSseStream(
  model: string,
  content: string,
  usage: StreamUsage,
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const id = `chatcmpl-${randomUUID()}`;
  const created = Math.floor(Date.now() / 1000);

  const chunks: string[] = [
    {
      id,
      object: 'chat.completion.chunk',
      created,
      model,
      choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }],
    },
    {
      id,
      object: 'chat.completion.chunk',
      created,
      model,
      choices: [{ index: 0, delta: { content }, finish_reason: null }],
    },
    {
      id,
      object: 'chat.completion.chunk',
      created,
      model,
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      usage: {
        prompt_tokens: usage.prompt_tokens,
        completion_tokens: usage.completion_tokens,
        total_tokens: usage.prompt_tokens + usage.completion_tokens,
      },
    },
  ].map((obj) => `data: ${JSON.stringify(obj)}\n\n`);

  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.enqueue(encoder.encode('data: [DONE]\n\n'));
      controller.close();
    },
  });
}

export function estimateUsage(promptText: string, completionText: string): StreamUsage {
  return {
    prompt_tokens: estimateTokensFromText(promptText),
    completion_tokens: estimateTokensFromText(completionText || ' '),
  };
}

export function openAiJsonResponse(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

export function openAiSseResponse(stream: ReadableStream<Uint8Array>, status = 200): Response {
  return new Response(stream, {
    status,
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    },
  });
}
