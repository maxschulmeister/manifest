export type PromptCompressionApiMode = 'chat_completions' | 'responses' | 'messages';

type JsonRecord = Record<string, unknown>;

const PLACEHOLDER_PREFIX = '\uE000';
const PLACEHOLDER_SUFFIX = '\uE001';

const PROTECTED_PATTERNS: RegExp[] = [
  /```[\s\S]*?```/g,
  /`[^`\n]+`/g,
  /https?:\/\/[^\s)\]}>"']+/gi,
  /(?:[A-Za-z]:\\|~\/|\.{1,2}\/)[^\s)\]}>"']+/g,
  /\/(?:[\w.-]+\/)+[\w.-]+(?:\.\w+)?/g,
  /\$\{?[A-Z_][A-Z0-9_]*\}?/g,
  /%[A-Z_][A-Z0-9_]*%/g,
  /^(?:Error|TypeError|ReferenceError|SyntaxError|Exception):.*$/gm,
  /^\s*at\s+.+$/gm,
];

const FILLER_PATTERN =
  /\b(?:please|kindly|just|really|basically|actually|simply|certainly|definitely|very|quite|perhaps|maybe|somewhat|in order to|as well as)\b/gi;
const ARTICLE_PATTERN = /\b(?:a|an|the)\b/gi;

function isRecord(value: unknown): value is JsonRecord {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

interface MaskedRegion {
  placeholder: string;
  original: string;
}

function maskProtectedRegions(text: string): { masked: string; regions: MaskedRegion[] } {
  let masked = text;
  const regions: MaskedRegion[] = [];
  let index = 0;

  for (const pattern of PROTECTED_PATTERNS) {
    pattern.lastIndex = 0;
    masked = masked.replace(pattern, (match) => {
      const placeholder = `${PLACEHOLDER_PREFIX}${index++}${PLACEHOLDER_SUFFIX}`;
      regions.push({ placeholder, original: match });
      return placeholder;
    });
  }

  return { masked, regions };
}

function unmaskRegions(text: string, regions: MaskedRegion[]): string {
  let result = text;
  for (const { placeholder, original } of regions) {
    result = result.split(placeholder).join(original);
  }
  return result;
}

function validateUnmask(text: string, regions: MaskedRegion[]): boolean {
  for (const { placeholder, original } of regions) {
    if (text.includes(placeholder)) return false;
    if (!text.includes(original)) return false;
  }
  return true;
}

function compressProse(masked: string): string {
  return masked
    .replace(FILLER_PATTERN, '')
    .replace(ARTICLE_PATTERN, '')
    .replace(/\s+/g, ' ')
    .replace(/\s+([,.;:!?])/g, '$1')
    .trim();
}

export function compressUserPromptText(text: string): string {
  if (!text) return text;

  const { masked, regions } = maskProtectedRegions(text);
  const compressed = compressProse(masked);
  const result = unmaskRegions(compressed, regions);

  if (!validateUnmask(result, regions)) return text;
  if (result.length >= text.length) return text;
  return result;
}

function compressMessageContent(content: unknown): unknown {
  if (typeof content === 'string') return compressUserPromptText(content);
  if (!Array.isArray(content)) return content;

  return content.map((part) => {
    if (isRecord(part) && typeof part.text === 'string') {
      const compressed = compressUserPromptText(part.text);
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
    if (!isRecord(msg) || msg.role !== 'user') continue;
    messages[i] = { ...msg, content: compressMessageContent(msg.content) };
  }
}

function compressResponsesInputItem(item: unknown): unknown {
  if (typeof item === 'string') return compressUserPromptText(item);
  if (!isRecord(item)) return item;

  const role = typeof item.role === 'string' ? item.role : 'user';
  if (role !== 'user') return item;

  if (typeof item.content === 'string') {
    return { ...item, content: compressUserPromptText(item.content) };
  }

  if (Array.isArray(item.content)) {
    return { ...item, content: compressMessageContent(item.content) };
  }

  return item;
}

function injectResponses(body: JsonRecord): void {
  if (typeof body.input === 'string') {
    body.input = compressUserPromptText(body.input);
    return;
  }

  if (Array.isArray(body.input)) {
    body.input = body.input.map((item) => compressResponsesInputItem(item));
  }
}

function injectAnthropicMessages(body: JsonRecord): void {
  const messages = body.messages;
  if (!Array.isArray(messages)) return;

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (!isRecord(msg) || msg.role !== 'user') continue;
    messages[i] = { ...msg, content: compressMessageContent(msg.content) };
  }
}

export function applyPromptCompression(
  body: JsonRecord,
  apiMode: PromptCompressionApiMode,
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
