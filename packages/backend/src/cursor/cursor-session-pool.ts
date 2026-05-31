import { createHash } from 'node:crypto';
import type { IncomingHttpHeaders } from 'http';

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

/** Pulls the documented conversation id header from an inbound proxy request. */
export function extractManifestConversationExtraHeaders(
  headers?: IncomingHttpHeaders,
): Record<string, string> | undefined {
  if (!headers) return undefined;
  const raw = headers['x-manifest-conversation-id'] ?? headers['X-Manifest-Conversation-Id'];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== 'string' || !value.trim()) return undefined;
  return { 'x-manifest-conversation-id': value.trim() };
}
