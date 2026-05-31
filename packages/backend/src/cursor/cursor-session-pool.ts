import { createHash } from 'node:crypto';

export function hashCursorApiKeyForPool(apiKey: string): string {
  return createHash('sha256').update(apiKey).digest('hex').slice(0, 16);
}

export function buildCursorSessionPoolKey(
  agentId: string,
  apiKey: string,
  conversationId: string,
): string {
  const keyHash = hashCursorApiKeyForPool(apiKey);
  return `${agentId}:${keyHash}:${conversationId}`;
}

export function resolveCursorConversationId(
  sessionKey: string,
  extraHeaders?: Record<string, string>,
): string {
  const header =
    extraHeaders?.['x-manifest-conversation-id'] ?? extraHeaders?.['X-Manifest-Conversation-Id'];
  if (header && header.trim()) return header.trim();
  if (sessionKey && sessionKey !== 'default') return sessionKey;
  return 'default';
}
