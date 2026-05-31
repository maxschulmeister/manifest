import { randomUUID } from 'node:crypto';
import type { SDKMessage } from '@cursor/sdk';
import type { StreamUsage } from '../routing/proxy/stream-writer';
import type { ManifestBridgeToolRequest } from './adapted/manifest-tool-bridge-types';
import { estimateTokensFromText } from './cursor-message-converter';

export interface OpenAiToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export function manifestBridgeRequestsToOpenAiToolCalls(
  requests: ManifestBridgeToolRequest[],
): OpenAiToolCall[] {
  return requests.map((request) => ({
    id: request.manifestToolCallId,
    type: 'function' as const,
    function: {
      name: request.agentToolName,
      arguments: JSON.stringify(request.args),
    },
  }));
}

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

/**
 * Cursor run.stream() assistant events are often cumulative snapshots; onDelta chunks are
 * usually incremental. Emit only the suffix that extends the text already sent to the client.
 */
export function computeAssistantStreamDelta(
  previousFullText: string,
  chunk: string,
): { delta: string; nextFullText: string } {
  if (!chunk) {
    return { delta: '', nextFullText: previousFullText };
  }
  if (chunk.startsWith(previousFullText)) {
    return {
      delta: chunk.slice(previousFullText.length),
      nextFullText: chunk,
    };
  }
  return { delta: chunk, nextFullText: previousFullText + chunk };
}

export function buildOpenAiChatCompletion(
  model: string,
  content: string,
  usage: StreamUsage,
  toolCalls?: OpenAiToolCall[],
): Record<string, unknown> {
  const finishReason = toolCalls && toolCalls.length > 0 ? 'tool_calls' : 'stop';
  const message: Record<string, unknown> = { role: 'assistant', content: content || null };
  if (toolCalls && toolCalls.length > 0) message.tool_calls = toolCalls;

  return {
    id: `chatcmpl-${randomUUID()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        message,
        finish_reason: finishReason,
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
  toolCalls?: OpenAiToolCall[],
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const id = `chatcmpl-${randomUUID()}`;
  const created = Math.floor(Date.now() / 1000);
  const finishReason = toolCalls && toolCalls.length > 0 ? 'tool_calls' : 'stop';

  const chunkObjects: Record<string, unknown>[] = [
    {
      id,
      object: 'chat.completion.chunk',
      created,
      model,
      choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }],
    },
  ];

  if (content) {
    chunkObjects.push({
      id,
      object: 'chat.completion.chunk',
      created,
      model,
      choices: [{ index: 0, delta: { content }, finish_reason: null }],
    });
  }

  if (toolCalls && toolCalls.length > 0) {
    for (let index = 0; index < toolCalls.length; index += 1) {
      const toolCall = toolCalls[index]!;
      chunkObjects.push({
        id,
        object: 'chat.completion.chunk',
        created,
        model,
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                {
                  index,
                  id: toolCall.id,
                  type: toolCall.type,
                  function: { name: toolCall.function.name, arguments: '' },
                },
              ],
            },
            finish_reason: null,
          },
        ],
      });
      chunkObjects.push({
        id,
        object: 'chat.completion.chunk',
        created,
        model,
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                {
                  index,
                  function: { arguments: toolCall.function.arguments },
                },
              ],
            },
            finish_reason: null,
          },
        ],
      });
    }
  }

  chunkObjects.push({
    id,
    object: 'chat.completion.chunk',
    created,
    model,
    choices: [{ index: 0, delta: {}, finish_reason: finishReason }],
    usage: {
      prompt_tokens: usage.prompt_tokens,
      completion_tokens: usage.completion_tokens,
      total_tokens: usage.prompt_tokens + usage.completion_tokens,
    },
  });

  const chunks = chunkObjects.map((obj) => `data: ${JSON.stringify(obj)}\n\n`);

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
