import {
  buildCursorSessionPoolKey,
  hashCursorApiKeyForPool,
  resolveCursorConversationId,
} from './cursor-session-pool';

describe('cursor-session-pool', () => {
  it('builds pool key from agentId, api key hash, and conversation id', () => {
    const hash = hashCursorApiKeyForPool('secret-key');
    expect(buildCursorSessionPoolKey('agent-1', 'secret-key', 'conv-a')).toBe(
      `agent-1:${hash}:conv-a`,
    );
  });

  it('uses x-manifest-conversation-id header when present', () => {
    expect(
      resolveCursorConversationId('sess-1', {
        'x-manifest-conversation-id': 'thread-9',
      }),
    ).toBe('thread-9');
  });

  it('falls back to session key when header absent', () => {
    expect(resolveCursorConversationId('sess-abc', undefined)).toBe('sess-abc');
    expect(resolveCursorConversationId('default', undefined)).toBe('default');
  });
});
