import { createHash } from 'node:crypto';
import type { SDKImage, SDKUserMessage } from '@cursor/sdk';
import type { OpenAIMessage } from '../routing/proxy/proxy-types';
import { getManifestBridgeContractText } from './adapted/manifest-bridge-contract';
import type { ManifestToolBridgeSnapshot } from './adapted/manifest-tool-bridge-types';
import { buildCursorToolManifestText } from './cursor-tool-manifest';

export interface CursorPrompt {
  text: string;
  images: SDKImage[];
}

export interface ManifestCursorContext {
  systemPrompt?: string;
  messages: OpenAIMessage[];
}

const SECTION_SEPARATOR = '\n\n';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function messageText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const block of content) {
    if (!isRecord(block)) continue;
    if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text);
    if (block.type === 'image_url') parts.push('[image]');
  }
  return parts.join('\n');
}

function formatOpenAiMessage(msg: OpenAIMessage): string | undefined {
  switch (msg.role) {
    case 'system': {
      const text = messageText(msg.content);
      return text ? `System: ${text}` : undefined;
    }
    case 'user': {
      const text = messageText(msg.content);
      return text ? `User: ${text}` : undefined;
    }
    case 'assistant': {
      const text = messageText(msg.content);
      const toolCalls = Array.isArray(msg.tool_calls)
        ? msg.tool_calls
            .map((tc) => {
              const name = tc.function?.name ?? 'tool';
              const args = tc.function?.arguments ?? '';
              return `Tool call (${name}, ${tc.id}): ${args}`;
            })
            .join('\n')
        : '';
      const combined = [text, toolCalls].filter(Boolean).join('\n');
      return combined ? `Assistant: ${combined}` : undefined;
    }
    case 'tool': {
      const text = messageText(msg.content);
      const id = typeof msg.tool_call_id === 'string' ? msg.tool_call_id : 'tool';
      return `Tool result (${id}): ${text}`;
    }
    default:
      return undefined;
  }
}

function extractLatestUserImages(messages: OpenAIMessage[]): SDKImage[] {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role !== 'user') continue;
    const content = msg.content;
    if (!Array.isArray(content)) return [];
    const images: SDKImage[] = [];
    for (const block of content) {
      if (!isRecord(block) || block.type !== 'image_url') continue;
      const imageUrl = isRecord(block.image_url) ? block.image_url.url : undefined;
      if (typeof imageUrl === 'string' && imageUrl.startsWith('data:')) {
        const match = /^data:([^;]+);base64,(.+)$/i.exec(imageUrl);
        if (match) {
          images.push({ data: match[2], mimeType: match[1] });
        }
      }
    }
    return images;
  }
  return [];
}

function getLatestUserMessageIndex(messages: OpenAIMessage[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'user') return i;
  }
  return -1;
}

export function openAiMessagesToContext(body: Record<string, unknown>): ManifestCursorContext {
  const rawMessages = body.messages;
  const messages = Array.isArray(rawMessages) ? (rawMessages as OpenAIMessage[]) : [];
  const systemParts = messages
    .filter((m) => m.role === 'system')
    .map((m) => messageText(m.content))
    .filter(Boolean);
  const nonSystem = messages.filter((m) => m.role !== 'system');
  return {
    systemPrompt: systemParts.length > 0 ? systemParts.join('\n') : undefined,
    messages: nonSystem,
  };
}

export function computeManifestContextFingerprint(context: ManifestCursorContext): string {
  const payload = {
    system: context.systemPrompt ?? '',
    messages: context.messages.map((m, index) =>
      createHash('sha256')
        .update(`${m.role}:${index}:${JSON.stringify(m)}`)
        .digest('hex')
        .slice(0, 16),
    ),
  };
  return JSON.stringify(payload);
}

export interface BootstrapCursorPromptOptions {
  bridgeSnapshot?: ManifestToolBridgeSnapshot;
  bridgeEnabled?: boolean;
}

export function buildBootstrapCursorPrompt(
  context: ManifestCursorContext,
  options: BootstrapCursorPromptOptions = {},
): CursorPrompt {
  const sections: string[] = [];
  if (context.systemPrompt) {
    sections.push(`System instructions:\n${context.systemPrompt}`);
  }
  for (const msg of context.messages) {
    const formatted = formatOpenAiMessage(msg);
    if (formatted) sections.push(formatted);
  }
  const hasBridgeTools = (options.bridgeSnapshot?.tools.length ?? 0) > 0;
  sections.push(getManifestBridgeContractText({ bridgeToolsActive: hasBridgeTools }));
  sections.push(
    buildCursorToolManifestText({
      bridgeSnapshot: options.bridgeSnapshot,
      bridgeEnabled: options.bridgeEnabled,
    }),
  );
  if (hasBridgeTools) {
    sections.push(
      'When you need agent tools, call only manifest__* MCP tools listed above. Manifest returns tool_calls to the agent; do not assume Manifest executes tools.',
    );
  }
  return {
    text: sections.join(SECTION_SEPARATOR),
    images: extractLatestUserImages(context.messages),
  };
}

export function buildIncrementalCursorPrompt(context: ManifestCursorContext): CursorPrompt {
  const sections: string[] = ['Continue the conversation.'];
  if (context.systemPrompt) {
    sections.push(`System instructions:\n${context.systemPrompt}`);
  }
  const latestIndex = getLatestUserMessageIndex(context.messages);
  if (latestIndex >= 0) {
    const formatted = formatOpenAiMessage(context.messages[latestIndex]);
    if (formatted) sections.push(formatted);
  }
  return {
    text: sections.join(SECTION_SEPARATOR),
    images: extractLatestUserImages(context.messages),
  };
}

export function cursorPromptToSdkUserMessage(prompt: CursorPrompt): SDKUserMessage {
  return prompt.images.length > 0
    ? { text: prompt.text, images: prompt.images }
    : { text: prompt.text };
}

export function estimateTokensFromText(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}
