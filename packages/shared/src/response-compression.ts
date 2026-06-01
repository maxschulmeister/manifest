export const RESPONSE_COMPRESSION_MARKER = '[manifest:compress-response]';

export const RESPONSE_COMPRESSION_SUFFIX =
  'Reply briefly and concisely unless the user explicitly asks for more detail.';

export const RESPONSE_COMPRESSION_INSTRUCTION = `${RESPONSE_COMPRESSION_MARKER} ${RESPONSE_COMPRESSION_SUFFIX}`;

export type ResponseCompressionApiMode = 'chat_completions' | 'responses' | 'messages';

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function textContainsMarker(text: string): boolean {
  return text.includes(RESPONSE_COMPRESSION_MARKER);
}

function appendInstructionToText(existing: string): string {
  if (textContainsMarker(existing)) return existing;
  const trimmed = existing.trim();
  return trimmed
    ? `${trimmed}\n\n${RESPONSE_COMPRESSION_INSTRUCTION}`
    : RESPONSE_COMPRESSION_INSTRUCTION;
}

function messageContentHasMarker(content: unknown): boolean {
  if (typeof content === 'string') return textContainsMarker(content);
  if (!Array.isArray(content)) return false;
  return content.some(
    (part) => isRecord(part) && typeof part.text === 'string' && textContainsMarker(part.text),
  );
}

export function requestBodyHasResponseCompressionMarker(
  body: JsonRecord,
  apiMode: ResponseCompressionApiMode,
): boolean {
  try {
    if (JSON.stringify(body).includes(RESPONSE_COMPRESSION_MARKER)) return true;
  } catch {
    // Fall through to field-scoped checks.
  }

  if (apiMode === 'responses' && typeof body.instructions === 'string') {
    return textContainsMarker(body.instructions);
  }

  if (apiMode === 'messages') {
    if (typeof body.system === 'string') return textContainsMarker(body.system);
    if (Array.isArray(body.system)) {
      return body.system.some(
        (part) => isRecord(part) && typeof part.text === 'string' && textContainsMarker(part.text),
      );
    }
  }

  const messages = body.messages;
  if (!Array.isArray(messages)) return false;
  return messages.some(
    (msg) =>
      isRecord(msg) &&
      (msg.role === 'system' || msg.role === 'developer') &&
      messageContentHasMarker(msg.content),
  );
}

function appendToMessageContent(content: unknown): unknown {
  if (typeof content === 'string') return appendInstructionToText(content);
  if (!Array.isArray(content)) return RESPONSE_COMPRESSION_INSTRUCTION;
  const blocks = content.map((part) => (isRecord(part) ? { ...part } : part));
  for (let i = blocks.length - 1; i >= 0; i--) {
    const part = blocks[i];
    if (isRecord(part) && typeof part.text === 'string') {
      part.text = appendInstructionToText(part.text);
      return blocks;
    }
  }
  blocks.push({ type: 'text', text: RESPONSE_COMPRESSION_INSTRUCTION });
  return blocks;
}

function injectChatCompletions(body: JsonRecord): void {
  const messages = body.messages;
  if (!Array.isArray(messages)) {
    body.messages = [{ role: 'system', content: RESPONSE_COMPRESSION_INSTRUCTION }];
    return;
  }

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (!isRecord(msg) || (msg.role !== 'system' && msg.role !== 'developer')) continue;
    messages[i] = { ...msg, content: appendToMessageContent(msg.content) };
    return;
  }

  messages.unshift({ role: 'system', content: RESPONSE_COMPRESSION_INSTRUCTION });
}

function injectResponses(body: JsonRecord): void {
  if (typeof body.instructions === 'string') {
    body.instructions = appendInstructionToText(body.instructions);
    return;
  }
  body.instructions = RESPONSE_COMPRESSION_INSTRUCTION;
}

function injectAnthropicMessages(body: JsonRecord): void {
  if (typeof body.system === 'string') {
    body.system = appendInstructionToText(body.system);
    return;
  }

  if (Array.isArray(body.system)) {
    const blocks = body.system.map((part) => (isRecord(part) ? { ...part } : part));
    for (let i = blocks.length - 1; i >= 0; i--) {
      const part = blocks[i];
      if (isRecord(part) && typeof part.text === 'string') {
        part.text = appendInstructionToText(part.text);
        body.system = blocks;
        return;
      }
    }
    blocks.push({ type: 'text', text: RESPONSE_COMPRESSION_INSTRUCTION });
    body.system = blocks;
    return;
  }

  body.system = RESPONSE_COMPRESSION_INSTRUCTION;
}

export function applyResponseCompressionInstruction(
  body: JsonRecord,
  apiMode: ResponseCompressionApiMode,
): JsonRecord {
  if (requestBodyHasResponseCompressionMarker(body, apiMode)) return body;

  if (apiMode === 'responses') {
    injectResponses(body);
  } else if (apiMode === 'messages') {
    injectAnthropicMessages(body);
  } else {
    injectChatCompletions(body);
  }

  return body;
}
