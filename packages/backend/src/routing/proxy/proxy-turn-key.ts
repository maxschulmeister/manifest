import { createHash } from 'crypto';

type ChatMessage = {
  role?: unknown;
  content?: unknown;
};

type ChatRequestBody = {
  messages?: unknown;
  tools?: unknown;
  functions?: unknown;
  tool_choice?: unknown;
};

export function buildSyntheticTurnKey(
  body: unknown,
  sessionKey: string | null | undefined,
  routeKey: string | null | undefined,
): string | undefined {
  if (
    !sessionKey ||
    sessionKey === 'default' ||
    !routeKey ||
    typeof body !== 'object' ||
    body === null
  ) {
    return undefined;
  }

  const request = body as ChatRequestBody;
  if (!isToolCapableRequest(request) || !Array.isArray(request.messages)) return undefined;

  const messages = request.messages.filter(isChatMessage);
  const userMessages = messages.filter((message) => message.role === 'user');
  const latestUserMessage = userMessages.at(-1);
  if (!latestUserMessage) return undefined;

  const hash = createHash('sha256')
    .update(
      stableStringify({
        sessionKey,
        routeKey,
        userTurn: userMessages.length,
        content: latestUserMessage.content ?? null,
      }),
    )
    .digest('hex')
    .slice(0, 32);

  return `turn:${hash}`;
}

function isToolCapableRequest(request: ChatRequestBody): boolean {
  return hasItems(request.tools) || hasItems(request.functions) || request.tool_choice != null;
}

function hasItems(value: unknown): boolean {
  return Array.isArray(value) && value.length > 0;
}

function isChatMessage(value: unknown): value is ChatMessage {
  return typeof value === 'object' && value !== null;
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}
