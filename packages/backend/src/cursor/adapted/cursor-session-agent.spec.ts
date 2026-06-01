import type { SDKAgent } from '@cursor/sdk';
import {
  __testUtils,
  acquireSessionCursorAgent,
  resetSessionCursorAgent,
} from './cursor-session-agent';
import { disposeCursorTestState } from '../cursor-test-harness';

function mockAgent(id = 'agent-1'): SDKAgent {
  return {
    agentId: id,
    model: { id: 'composer-2.5' },
    send: jest.fn(),
    close: jest.fn(),
    reload: jest.fn().mockResolvedValue(undefined),
    [Symbol.asyncDispose]: jest.fn().mockResolvedValue(undefined),
    listArtifacts: jest.fn().mockResolvedValue([]),
    downloadArtifact: jest.fn(),
  } as unknown as SDKAgent;
}

describe('cursor-session-agent', () => {
  afterEach(async () => {
    await disposeCursorTestState();
  });

  it('reuses the same agent for identical pool keys', async () => {
    const agent = mockAgent();
    const createAgent = jest.fn().mockResolvedValue(agent);
    const params = {
      apiKey: 'key-1',
      cwd: '/tmp',
      modelSelection: { id: 'composer-2.5' },
      agentMode: 'agent' as const,
      createAgent,
    };

    const lease1 = await acquireSessionCursorAgent('scope-a', params);
    const lease2 = await acquireSessionCursorAgent('scope-a', params);

    expect(createAgent).toHaveBeenCalledTimes(1);
    expect(lease1.agent).toBe(agent);
    expect(lease2.agent).toBe(agent);
    expect(lease1.created).toBe(true);
    expect(lease2.created).toBe(false);
  });

  it('recreates agent when pool key changes', async () => {
    const agent1 = mockAgent('a1');
    const agent2 = mockAgent('a2');
    const createAgent = jest.fn().mockResolvedValueOnce(agent1).mockResolvedValueOnce(agent2);
    const base = {
      apiKey: 'key-1',
      cwd: '/tmp',
      agentMode: 'agent' as const,
      createAgent,
    };

    const lease1 = await acquireSessionCursorAgent('scope-b', {
      ...base,
      modelSelection: { id: 'composer-2.5' },
    });
    const lease2 = await acquireSessionCursorAgent('scope-b', {
      ...base,
      modelSelection: { id: 'composer-2-fast' },
    });

    expect(createAgent).toHaveBeenCalledTimes(2);
    expect(lease1.agent).toBe(agent1);
    expect(lease2.agent).toBe(agent2);
  });

  it('returns agent to ready after tracked run completes', async () => {
    const agent = mockAgent();
    const createAgent = jest.fn().mockResolvedValue(agent);
    const params = {
      apiKey: 'key',
      cwd: '/tmp',
      modelSelection: { id: 'composer-2.5' },
      agentMode: 'agent' as const,
      createAgent,
    };
    const lease = await acquireSessionCursorAgent('scope-busy-done', params);
    lease.trackRunCompletion(Promise.resolve());
    await new Promise((resolve) => setTimeout(resolve, 0));
    const entry = __testUtils.sessionAgentsByScope.get('scope-busy-done');
    expect(entry?.status).toBe('ready');
  });

  it('waits for busy agent before re-leasing', async () => {
    const agent = mockAgent();
    const createAgent = jest.fn().mockResolvedValue(agent);
    const params = {
      apiKey: 'key-1',
      cwd: '/tmp',
      modelSelection: { id: 'composer-2.5' },
      agentMode: 'agent' as const,
      createAgent,
    };
    const lease = await acquireSessionCursorAgent('scope-c', params);
    let resolveWait: () => void = () => undefined;
    lease.trackRunCompletion(
      new Promise<void>((resolve) => {
        resolveWait = resolve;
      }),
    );
    const pending = acquireSessionCursorAgent('scope-c', params);
    resolveWait();
    const lease2 = await pending;
    expect(lease2.agent).toBe(agent);
  });

  it('resets and disposes scopes', async () => {
    const agent = mockAgent();
    const createAgent = jest.fn().mockResolvedValue(agent);
    await acquireSessionCursorAgent('scope-d', {
      apiKey: 'k',
      cwd: '/tmp',
      modelSelection: { id: 'm' },
      agentMode: 'agent',
      createAgent,
    });
    await resetSessionCursorAgent('scope-d');
    expect(__testUtils.sessionAgentsByScope.has('scope-d')).toBe(false);
  });

  it('includes api key hash in pool key', () => {
    const hash = __testUtils.buildApiKeyPoolKeyFingerprint('secret');
    const key = __testUtils.buildSessionAgentPoolKey('scope', {
      apiKey: 'secret',
      cwd: '/tmp',
      modelSelection: { id: 'm' },
      agentMode: 'agent',
    });
    expect(key).toContain(hash);
  });

  it('commits send state on the active lease', async () => {
    const agent = mockAgent();
    const createAgent = jest.fn().mockResolvedValue(agent);
    const lease = await acquireSessionCursorAgent('scope-e', {
      apiKey: 'k',
      cwd: '/tmp',
      modelSelection: { id: 'm' },
      agentMode: 'agent',
      createAgent,
    });
    lease.commitSend('fp-1', true);
    lease.commitSend('fp-2', false);
    const entry = __testUtils.sessionAgentsByScope.get('scope-e');
    expect(entry && entry.status !== 'creating' && entry.sendState.bootstrapped).toBe(true);
    expect(entry && entry.status !== 'creating' && entry.sendState.incrementalSendCount).toBe(1);
  });

  it('ignores commitSend when lease instance is stale', async () => {
    const agent = mockAgent();
    const createAgent = jest.fn().mockResolvedValue(agent);
    const lease = await acquireSessionCursorAgent('scope-g', {
      apiKey: 'key',
      cwd: '/tmp',
      modelSelection: { id: 'm' },
      agentMode: 'agent',
      createAgent,
    });
    await resetSessionCursorAgent('scope-g');
    lease.commitSend('fp', true);
    expect(__testUtils.sessionAgentsByScope.has('scope-g')).toBe(false);
  });

  it('waits on concurrent creation for same scope', async () => {
    const agent = mockAgent();
    let resolveCreate: (agent: SDKAgent) => void = () => undefined;
    const createAgent = jest.fn(
      () =>
        new Promise<SDKAgent>((resolve) => {
          resolveCreate = resolve;
        }),
    );
    const params = {
      apiKey: 'key',
      cwd: '/tmp',
      modelSelection: { id: 'm' },
      agentMode: 'agent' as const,
      createAgent,
    };
    const pending1 = acquireSessionCursorAgent('scope-h', params);
    const pending2 = acquireSessionCursorAgent('scope-h', params);
    resolveCreate(agent);
    const [lease1, lease2] = await Promise.all([pending1, pending2]);
    expect(createAgent).toHaveBeenCalledTimes(1);
    expect(lease1.agent).toBe(agent);
    expect(lease2.agent).toBe(agent);
  });

  it('returns to ready when tracked run rejects', async () => {
    const agent = mockAgent();
    const createAgent = jest.fn().mockResolvedValue(agent);
    const lease = await acquireSessionCursorAgent('scope-reject', {
      apiKey: 'key',
      cwd: '/tmp',
      modelSelection: { id: 'm' },
      agentMode: 'agent',
      createAgent,
    });
    lease.trackRunCompletion(Promise.reject(new Error('run failed')));
    await new Promise((resolve) => setTimeout(resolve, 0));
    const entry = __testUtils.sessionAgentsByScope.get('scope-reject');
    expect(entry?.status).toBe('ready');
  });

  it('disposes orphaned agent when creation is superseded', async () => {
    const agent = mockAgent();
    const disposeSpy = jest.spyOn(agent, Symbol.asyncDispose);
    let resolveCreate!: (value: SDKAgent) => void;
    const createAgent = jest.fn(
      () =>
        new Promise<SDKAgent>((resolve) => {
          resolveCreate = resolve;
        }),
    );
    const params = {
      apiKey: 'key',
      cwd: '/tmp',
      modelSelection: { id: 'm' },
      agentMode: 'agent' as const,
      createAgent,
    };
    const pending = acquireSessionCursorAgent('scope-orphan', params);
    __testUtils.sessionAgentsByScope.delete('scope-orphan');
    resolveCreate(agent);
    const lease = await pending;
    expect(lease.agent).toBe(agent);
    expect(disposeSpy).toHaveBeenCalled();
  });

  it('uses cwd as both the Cursor workspace and local executor directory', async () => {
    const agent = mockAgent();
    const createAgent = jest.fn().mockResolvedValue(agent);

    await acquireSessionCursorAgent('scope-cwd', {
      apiKey: 'k',
      cwd: '/tmp/manifest worktree/compression',
      modelSelection: { id: 'm' },
      agentMode: 'agent',
      createAgent,
    });

    expect(createAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        local: expect.objectContaining({ cwd: '/tmp/manifest worktree/compression' }),
        platform: expect.objectContaining({ workspaceRef: '/tmp/manifest worktree/compression' }),
      }),
    );
  });

  it('recreates the agent when a bridge appears on an existing bridge pool key', async () => {
    const agent1 = mockAgent('without-bridge');
    const agent2 = mockAgent('with-bridge');
    const createAgent = jest.fn().mockResolvedValueOnce(agent1).mockResolvedValueOnce(agent2);
    const bridgeRun = {
      mcpServers: { manifest_tools: { url: 'http://127.0.0.1:1/bridge' } },
      setOnToolRequest: jest.fn(),
      cancel: jest.fn(),
      dispose: jest.fn().mockResolvedValue(undefined),
    };
    const params = {
      apiKey: 'k',
      cwd: '/tmp',
      modelSelection: { id: 'm' },
      agentMode: 'agent' as const,
      bridgeSurfaceSignature: 'bridge:same-tools',
      createAgent,
    };

    await acquireSessionCursorAgent('scope-bridge-appears', params);
    const lease = await acquireSessionCursorAgent('scope-bridge-appears', {
      ...params,
      bridgeRun: bridgeRun as never,
    });

    expect(createAgent).toHaveBeenCalledTimes(2);
    expect(lease.agent).toBe(agent2);
    expect(lease.bridgeRun).toBe(bridgeRun);
  });

  it('keeps the session bridge and disposes unused replacement bridges for identical pool keys', async () => {
    const agent = mockAgent();
    const createAgent = jest.fn().mockResolvedValue(agent);
    const firstBridgeRun = {
      mcpServers: { manifest_tools: { url: 'http://127.0.0.1:1/first' } },
      setOnToolRequest: jest.fn(),
      cancel: jest.fn(),
      dispose: jest.fn().mockResolvedValue(undefined),
    };
    const secondBridgeRun = {
      mcpServers: { manifest_tools: { url: 'http://127.0.0.1:1/second' } },
      setOnToolRequest: jest.fn(),
      cancel: jest.fn(),
      dispose: jest.fn().mockResolvedValue(undefined),
    };
    const params = {
      apiKey: 'k',
      cwd: '/tmp',
      modelSelection: { id: 'm' },
      agentMode: 'agent' as const,
      bridgeSurfaceSignature: 'bridge:same-tools',
      createAgent,
    };

    const firstLease = await acquireSessionCursorAgent('scope-bridge-reuse', {
      ...params,
      bridgeRun: firstBridgeRun as never,
    });
    const secondLease = await acquireSessionCursorAgent('scope-bridge-reuse', {
      ...params,
      bridgeRun: secondBridgeRun as never,
    });

    expect(createAgent).toHaveBeenCalledTimes(1);
    expect(firstLease.bridgeRun).toBe(firstBridgeRun);
    expect(secondLease.bridgeRun).toBe(firstBridgeRun);
    expect(secondBridgeRun.cancel).toHaveBeenCalledWith('Unused Cursor session bridge replaced');
    expect(secondBridgeRun.dispose).toHaveBeenCalled();
  });

  it('wires bridge tool requests when creating an agent with a bridge run', async () => {
    const agent = mockAgent();
    const createAgent = jest.fn().mockResolvedValue(agent);
    const setOnToolRequest = jest.fn();
    const bridgeRun = {
      mcpServers: { manifest_tools: { url: 'http://127.0.0.1:1/mcp' } },
      setOnToolRequest,
      cancel: jest.fn(),
      dispose: jest.fn().mockResolvedValue(undefined),
    };
    const onBridgeToolRequest = jest.fn();
    await acquireSessionCursorAgent('scope-bridge', {
      apiKey: 'k',
      cwd: '/tmp',
      modelSelection: { id: 'm' },
      agentMode: 'agent',
      createAgent,
      bridgeRun: bridgeRun as never,
      onBridgeToolRequest,
    });
    expect(setOnToolRequest).toHaveBeenCalledWith(onBridgeToolRequest);
    expect(createAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        mcpServers: bridgeRun.mcpServers,
      }),
    );
  });

  it('throws when agent creation fails', async () => {
    const createAgent = jest.fn().mockRejectedValue(new Error('create failed'));
    await expect(
      acquireSessionCursorAgent('scope-f', {
        apiKey: 'k',
        cwd: '/tmp',
        modelSelection: { id: 'm' },
        agentMode: 'agent',
        createAgent,
      }),
    ).rejects.toThrow('Cursor session agent creation failed');
  });
});
