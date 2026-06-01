import type { SDKAgent } from '@cursor/sdk';
import {
  acquireSessionCursorAgent,
  disposeAllSessionCursorAgents,
  resetSessionCursorAgent,
} from './adapted/cursor-session-agent';
import { MAX_COMPLETED_INCREMENTAL_SENDS_BEFORE_REBOOTSTRAP } from './adapted/cursor-session-send-policy';
import { disposeManifestToolBridgeForTests } from './adapted/manifest-tool-bridge-server';
import {
  ManifestCursorLiveRunAbortError,
  getManifestCursorLiveRunForScope,
  markManifestLiveRunCancelled,
  markManifestLiveRunError,
  markManifestLiveRunFinished,
  queueManifestLiveEvent,
  releaseAllManifestCursorLiveRunsForTests,
  startManifestCursorLiveRun,
} from './adapted/manifest-cursor-live-run';
import * as manifestCursorLiveRun from './adapted/manifest-cursor-live-run';
import type {
  ManifestBridgeToolRequest,
  ManifestToolBridgeRun,
} from './adapted/manifest-tool-bridge-types';
import { buildManifestToolBridgeSnapshotFromOpenAiTools } from './adapted/manifest-tool-bridge-snapshot';
import { openAiMessagesToContext } from './cursor-message-converter';
import { buildCursorSessionPoolKey } from './cursor-session-pool';
import { CursorProxyService, __testUtils } from './cursor-proxy.service';

jest.mock('./adapted/cursor-session-agent', () => {
  const actual = jest.requireActual('./adapted/cursor-session-agent');
  return {
    ...actual,
    acquireSessionCursorAgent: jest.fn(),
    resetSessionCursorAgent: jest.fn().mockResolvedValue(undefined),
  };
});

const mockAcquire = acquireSessionCursorAgent as jest.MockedFunction<
  typeof acquireSessionCursorAgent
>;
const mockReset = resetSessionCursorAgent as jest.MockedFunction<typeof resetSessionCursorAgent>;

function mockRun(content: string, status: 'finished' | 'error' = 'finished') {
  return {
    id: 'run-1',
    agentId: 'agent-1',
    stream: async function* () {
      yield {
        type: 'assistant',
        agent_id: 'agent-1',
        run_id: 'run-1',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: content }],
        },
      };
    },
    wait: jest
      .fn()
      .mockResolvedValue({ id: 'run-1', status, result: status === 'error' ? 'failed' : content }),
    cancel: jest.fn().mockResolvedValue(undefined),
    status,
    supports: () => true,
    unsupportedReason: () => undefined,
    conversation: jest.fn(),
    onDidChangeStatus: () => () => undefined,
  };
}

function mockLease(
  agent: SDKAgent,
  sendState = {
    bootstrapped: false,
    contextFingerprint: '',
    incrementalSendCount: 0,
  },
  bridgeRun?: ManifestToolBridgeRun,
) {
  return {
    scopeKey: 'scope',
    poolKey: 'pool',
    instanceId: 1,
    agent,
    bridgeRun,
    sendState,
    created: true,
    commitSend: jest.fn(),
    trackRunCompletion: jest.fn(),
  };
}

const bridgeToolRequest: ManifestBridgeToolRequest = {
  runId: 'bridge-run',
  bridgeCallId: 'b1',
  manifestToolCallId: 'call-stream-1',
  agentToolName: 'bash',
  mcpToolName: 'manifest__bash',
  args: { command: 'ls' },
};

describe('CursorProxyService', () => {
  afterEach(async () => {
    jest.clearAllMocks();
    await releaseAllManifestCursorLiveRunsForTests();
    await disposeManifestToolBridgeForTests();
    await disposeAllSessionCursorAgents();
  });

  it('uses incremental prompt on follow-up turns', async () => {
    const { computeManifestBootstrapContextFingerprint } =
      await import('./cursor-message-converter');
    const context = { messages: [{ role: 'user', content: 'Follow up' }] };
    const fingerprint = computeManifestBootstrapContextFingerprint(context);
    const agent = {
      agentId: 'agent-1',
      model: { id: 'composer-2.5' },
      send: jest.fn().mockReturnValue(mockRun('incremental reply')),
      close: jest.fn(),
      reload: jest.fn().mockResolvedValue(undefined),
      [Symbol.asyncDispose]: jest.fn().mockResolvedValue(undefined),
      listArtifacts: jest.fn().mockResolvedValue([]),
      downloadArtifact: jest.fn(),
    } as unknown as SDKAgent;
    mockAcquire.mockResolvedValue(
      mockLease(agent, {
        bootstrapped: true,
        contextFingerprint: fingerprint,
        incrementalSendCount: 1,
      }),
    );

    const service = new CursorProxyService();
    await service.forward({
      provider: 'cursor',
      apiKey: 'cursor-key',
      model: 'cursor/composer-2.5',
      body: { messages: [{ role: 'user', content: 'Follow up' }] },
      stream: false,
      agentId: 'agent-db-1',
      sessionKey: 'conv-1',
    });

    const sent = (agent.send as jest.Mock).mock.calls[0][0] as { text: string };
    expect(sent.text).toContain('Continue the conversation');
    expect(mockReset).not.toHaveBeenCalled();
  });

  it('uses incremental prompt when full transcript grows on follow-up', async () => {
    const { computeManifestBootstrapContextFingerprint } =
      await import('./cursor-message-converter');
    const firstTurn = { messages: [{ role: 'user', content: 'Hello' }] };
    const bootstrapFingerprint = computeManifestBootstrapContextFingerprint(firstTurn);
    const agent = {
      agentId: 'agent-1',
      model: { id: 'composer-2.5' },
      send: jest.fn().mockReturnValue(mockRun('incremental reply')),
      close: jest.fn(),
      reload: jest.fn().mockResolvedValue(undefined),
      [Symbol.asyncDispose]: jest.fn().mockResolvedValue(undefined),
      listArtifacts: jest.fn().mockResolvedValue([]),
      downloadArtifact: jest.fn(),
    } as unknown as SDKAgent;
    mockAcquire.mockResolvedValue(
      mockLease(agent, {
        bootstrapped: true,
        contextFingerprint: bootstrapFingerprint,
        incrementalSendCount: 1,
      }),
    );

    const service = new CursorProxyService();
    await service.forward({
      provider: 'cursor',
      apiKey: 'cursor-key',
      model: 'cursor/composer-2.5',
      body: {
        messages: [
          { role: 'user', content: 'Hello' },
          { role: 'assistant', content: 'Hi there' },
          { role: 'user', content: 'Follow up' },
        ],
      },
      stream: false,
      agentId: 'agent-db-1',
      sessionKey: 'conv-full-transcript',
    });

    const sent = (agent.send as jest.Mock).mock.calls[0][0] as { text: string };
    expect(sent.text).toContain('Continue the conversation');
    expect(sent.text).toContain('User: Follow up');
    expect(mockReset).not.toHaveBeenCalled();
  });

  it('uses X-Manifest-Conversation-Id from extraHeaders for session pooling', async () => {
    const agent = {
      agentId: 'agent-1',
      model: { id: 'composer-2.5' },
      send: jest.fn().mockReturnValue(mockRun('ok')),
      close: jest.fn(),
      reload: jest.fn().mockResolvedValue(undefined),
      [Symbol.asyncDispose]: jest.fn().mockResolvedValue(undefined),
      listArtifacts: jest.fn().mockResolvedValue([]),
      downloadArtifact: jest.fn(),
    } as unknown as SDKAgent;
    mockAcquire.mockResolvedValue(mockLease(agent));

    const service = new CursorProxyService();
    await service.forward({
      provider: 'cursor',
      apiKey: 'cursor-key',
      model: 'cursor/composer-2.5',
      body: { messages: [{ role: 'user', content: 'Hi' }] },
      stream: false,
      agentId: 'agent-1',
      sessionKey: 'default',
      extraHeaders: { 'x-manifest-conversation-id': 'thread-9' },
    });

    expect(mockAcquire).toHaveBeenCalledWith(
      buildCursorSessionPoolKey('agent-1', 'cursor-key', 'thread-9'),
      expect.any(Object),
    );
  });

  it('returns tool_calls when bridge requests are queued before the live run starts', async () => {
    const agent = {
      agentId: 'agent-1',
      model: { id: 'composer-2.5' },
      send: jest.fn().mockReturnValue(mockRun('should not return')),
      close: jest.fn(),
      reload: jest.fn().mockResolvedValue(undefined),
      [Symbol.asyncDispose]: jest.fn().mockResolvedValue(undefined),
      listArtifacts: jest.fn().mockResolvedValue([]),
      downloadArtifact: jest.fn(),
    } as unknown as SDKAgent;

    mockAcquire.mockImplementation(async (_scope, params) => {
      params.onBridgeToolRequest?.({
        runId: 'bridge-run',
        bridgeCallId: 'b1',
        manifestToolCallId: 'call-1',
        agentToolName: 'bash',
        mcpToolName: 'manifest__bash',
        args: { command: 'ls' },
      });
      return mockLease(agent);
    });

    const service = new CursorProxyService();
    const result = await service.forward({
      provider: 'cursor',
      apiKey: 'cursor-key',
      model: 'cursor/composer-2.5',
      body: {
        messages: [{ role: 'user', content: 'List files' }],
        tools: [{ type: 'function', function: { name: 'bash', parameters: { type: 'object' } } }],
      },
      stream: false,
      agentId: 'agent-db-1',
      sessionKey: 'conv-bridge',
    });

    expect(agent.send).not.toHaveBeenCalled();
    const json = (await result.response.json()) as {
      choices: Array<{
        finish_reason: string;
        message: { tool_calls: Array<{ function: { name: string } }> };
      }>;
    };
    expect(json.choices[0].finish_reason).toBe('tool_calls');
    expect(json.choices[0].message.tool_calls[0].function.name).toBe('bash');
  });

  it('resumes a pending live run with streaming when tool results arrive', async () => {
    const scopeKey = buildCursorSessionPoolKey('agent-db-1', 'cursor-key', 'conv-resume-stream');
    const bridgeRun = {
      hasPendingManifestToolCallId: (id: string) => id === 'call-resume-stream-1',
      hasPendingToolCalls: () => true,
      resolveToolResults: jest.fn(),
      cancel: jest.fn(),
      dispose: jest.fn().mockResolvedValue(undefined),
    } as unknown as ManifestToolBridgeRun;
    const liveRun = startManifestCursorLiveRun({
      id: 'live-resume-stream',
      scopeKey,
      agent: { agentId: 'agent-1' } as unknown as SDKAgent,
      bridgeRun,
    });
    liveRun.textDeltas.push('Streamed after tool');
    markManifestLiveRunFinished(liveRun);

    const service = new CursorProxyService();
    const result = await service.forward({
      provider: 'cursor',
      apiKey: 'cursor-key',
      model: 'cursor/composer-2.5',
      body: {
        messages: [
          { role: 'user', content: 'run' },
          { role: 'tool', tool_call_id: 'call-resume-stream-1', content: 'ok' },
        ],
        tools: [{ type: 'function', function: { name: 'bash', parameters: { type: 'object' } } }],
      },
      stream: true,
      agentId: 'agent-db-1',
      sessionKey: 'conv-resume-stream',
    });

    expect(mockAcquire).not.toHaveBeenCalled();
    const text = await result.response.text();
    expect(text).toContain('Streamed after tool');
    expect(text).toContain('[DONE]');
  });

  it('resumes a pending live run when tool results arrive on the next request', async () => {
    const scopeKey = buildCursorSessionPoolKey('agent-db-1', 'cursor-key', 'conv-resume');
    const bridgeRun = {
      hasPendingManifestToolCallId: (id: string) => id === 'call-resume-1',
      hasPendingToolCalls: () => true,
      resolveToolResults: jest.fn(),
      cancel: jest.fn(),
      dispose: jest.fn().mockResolvedValue(undefined),
    } as unknown as ManifestToolBridgeRun;
    const liveRun = startManifestCursorLiveRun({
      id: 'live-resume',
      scopeKey,
      agent: { agentId: 'agent-1' } as unknown as SDKAgent,
      bridgeRun,
    });
    liveRun.textDeltas.push('After tool execution');
    markManifestLiveRunFinished(liveRun);

    const service = new CursorProxyService();
    const result = await service.forward({
      provider: 'cursor',
      apiKey: 'cursor-key',
      model: 'cursor/composer-2.5',
      body: {
        messages: [
          { role: 'user', content: 'run' },
          { role: 'tool', tool_call_id: 'call-resume-1', content: 'ok' },
        ],
        tools: [{ type: 'function', function: { name: 'bash', parameters: { type: 'object' } } }],
      },
      stream: false,
      agentId: 'agent-db-1',
      sessionKey: 'conv-resume',
    });

    expect(mockAcquire).not.toHaveBeenCalled();
    expect(bridgeRun.resolveToolResults).toHaveBeenCalledWith([
      { toolCallId: 'call-resume-1', content: 'ok' },
    ]);
    const json = (await result.response.json()) as {
      choices: Array<{ message: { content: string } }>;
    };
    expect(json.choices[0].message.content).toBe('After tool execution');
  });

  it('returns error when resumed live run failed after tool results', async () => {
    const scopeKey = buildCursorSessionPoolKey('agent-db-1', 'cursor-key', 'conv-resume-fail');
    const bridgeRun = {
      hasPendingManifestToolCallId: (id: string) => id === 'call-resume-fail-1',
      hasPendingToolCalls: () => true,
      resolveToolResults: jest.fn(),
      cancel: jest.fn(),
      dispose: jest.fn().mockResolvedValue(undefined),
    } as unknown as ManifestToolBridgeRun;
    const liveRun = startManifestCursorLiveRun({
      id: 'live-resume-fail',
      scopeKey,
      agent: { agentId: 'agent-1' } as unknown as SDKAgent,
      bridgeRun,
    });
    markManifestLiveRunError(liveRun, 'Cursor SDK run failed');

    const service = new CursorProxyService();
    const result = await service.forward({
      provider: 'cursor',
      apiKey: 'cursor-key',
      model: 'cursor/composer-2.5',
      body: {
        messages: [
          { role: 'user', content: 'run' },
          { role: 'tool', tool_call_id: 'call-resume-fail-1', content: 'ok' },
        ],
        tools: [{ type: 'function', function: { name: 'bash', parameters: { type: 'object' } } }],
      },
      stream: false,
      agentId: 'agent-db-1',
      sessionKey: 'conv-resume-fail',
    });

    expect(mockAcquire).not.toHaveBeenCalled();
    expect(result.response.ok).toBe(false);
    const json = (await result.response.json()) as { error: { message: string } };
    expect(json.error.message).toContain('Cursor SDK run failed');
  });

  it('returns error when resumed live run was cancelled after tool results', async () => {
    const scopeKey = buildCursorSessionPoolKey('agent-db-1', 'cursor-key', 'conv-resume-cancel');
    const bridgeRun = {
      hasPendingManifestToolCallId: (id: string) => id === 'call-resume-cancel-1',
      hasPendingToolCalls: () => true,
      resolveToolResults: jest.fn(),
      cancel: jest.fn(),
      dispose: jest.fn().mockResolvedValue(undefined),
    } as unknown as ManifestToolBridgeRun;
    const liveRun = startManifestCursorLiveRun({
      id: 'live-resume-cancel',
      scopeKey,
      agent: { agentId: 'agent-1' } as unknown as SDKAgent,
      bridgeRun,
    });
    markManifestLiveRunCancelled(liveRun, 'Run cancelled');

    const service = new CursorProxyService();
    const result = await service.forward({
      provider: 'cursor',
      apiKey: 'cursor-key',
      model: 'cursor/composer-2.5',
      body: {
        messages: [
          { role: 'user', content: 'run' },
          { role: 'tool', tool_call_id: 'call-resume-cancel-1', content: 'ok' },
        ],
        tools: [{ type: 'function', function: { name: 'bash', parameters: { type: 'object' } } }],
      },
      stream: false,
      agentId: 'agent-db-1',
      sessionKey: 'conv-resume-cancel',
    });

    expect(mockAcquire).not.toHaveBeenCalled();
    expect(result.response.ok).toBe(false);
    const json = (await result.response.json()) as { error: { message: string } };
    expect(json.error.message).toContain('Run cancelled');
  });

  it('skips resume when tool results are followed by a new user turn', async () => {
    const scopeKey = buildCursorSessionPoolKey('agent-db-1', 'cursor-key', 'conv-trailing-user');
    const bridgeRun = {
      hasPendingManifestToolCallId: (id: string) => id === 'call-trailing-1',
      hasPendingToolCalls: () => true,
      resolveToolResults: jest.fn(),
      cancel: jest.fn(),
      dispose: jest.fn().mockResolvedValue(undefined),
    } as unknown as ManifestToolBridgeRun;
    startManifestCursorLiveRun({
      id: 'live-trailing-user',
      scopeKey,
      agent: { agentId: 'agent-1' } as unknown as SDKAgent,
      bridgeRun,
    });

    const agent = {
      agentId: 'agent-1',
      model: { id: 'composer-2.5' },
      send: jest.fn().mockReturnValue(mockRun('Fresh turn')),
      close: jest.fn(),
      reload: jest.fn().mockResolvedValue(undefined),
      [Symbol.asyncDispose]: jest.fn().mockResolvedValue(undefined),
      listArtifacts: jest.fn().mockResolvedValue([]),
      downloadArtifact: jest.fn(),
    } as unknown as SDKAgent;
    mockAcquire.mockResolvedValue(mockLease(agent));

    const service = new CursorProxyService();
    const result = await service.forward({
      provider: 'cursor',
      apiKey: 'cursor-key',
      model: 'cursor/composer-2.5',
      body: {
        messages: [
          { role: 'user', content: 'run' },
          { role: 'tool', tool_call_id: 'call-trailing-1', content: 'ok' },
          { role: 'user', content: 'continue differently' },
        ],
        tools: [{ type: 'function', function: { name: 'bash', parameters: { type: 'object' } } }],
      },
      stream: false,
      agentId: 'agent-db-1',
      sessionKey: 'conv-trailing-user',
    });

    expect(mockAcquire).toHaveBeenCalled();
    expect(bridgeRun.resolveToolResults).not.toHaveBeenCalled();
    expect(getManifestCursorLiveRunForScope(scopeKey)).toBeUndefined();
    expect(result.response.ok).toBe(true);
    const json = (await result.response.json()) as {
      choices: Array<{ message: { content: string } }>;
    };
    expect(json.choices[0].message.content).toBe('Fresh turn');
  });

  it('returns OpenAI chat completion for non-stream cursor requests', async () => {
    const agent = {
      agentId: 'agent-1',
      model: { id: 'composer-2.5' },
      send: jest.fn().mockReturnValue(mockRun('Hello from Cursor')),
      close: jest.fn(),
      reload: jest.fn().mockResolvedValue(undefined),
      [Symbol.asyncDispose]: jest.fn().mockResolvedValue(undefined),
      listArtifacts: jest.fn().mockResolvedValue([]),
      downloadArtifact: jest.fn(),
    } as unknown as SDKAgent;

    mockAcquire.mockResolvedValue(mockLease(agent));

    const service = new CursorProxyService();
    const result = await service.forward({
      provider: 'cursor',
      apiKey: 'cursor-key',
      model: 'cursor/composer-2.5',
      body: { messages: [{ role: 'user', content: 'Hi' }] },
      stream: false,
      agentId: 'agent-db-1',
      sessionKey: 'conv-1',
    });

    expect(result.response.ok).toBe(true);
    const json = (await result.response.json()) as Record<string, unknown>;
    const choices = json.choices as Array<{ message: { content: string } }>;
    expect(choices[0].message.content).toBe('Hello from Cursor');
  });

  it('returns SSE stream for stream=true', async () => {
    const agent = {
      agentId: 'agent-1',
      model: { id: 'composer-2.5' },
      send: jest.fn().mockReturnValue(mockRun('Streamed')),
      close: jest.fn(),
      reload: jest.fn().mockResolvedValue(undefined),
      [Symbol.asyncDispose]: jest.fn().mockResolvedValue(undefined),
      listArtifacts: jest.fn().mockResolvedValue([]),
      downloadArtifact: jest.fn(),
    } as unknown as SDKAgent;
    mockAcquire.mockResolvedValue(mockLease(agent));

    const service = new CursorProxyService();
    const result = await service.forward({
      provider: 'cursor',
      apiKey: 'cursor-key',
      model: 'cursor/composer-2.5',
      body: { messages: [{ role: 'user', content: 'Hi' }] },
      stream: true,
      agentId: 'agent-db-1',
      sessionKey: 'conv-1',
    });

    expect(result.response.headers.get('Content-Type')).toBe('text/event-stream');
    const text = await result.response.text();
    expect(text).toContain('Streamed');
  });

  it('returns stream tool_calls when bridge is queued before send', async () => {
    const agent = {
      agentId: 'agent-1',
      model: { id: 'composer-2.5' },
      send: jest.fn().mockReturnValue(mockRun('should not return')),
      close: jest.fn(),
      reload: jest.fn().mockResolvedValue(undefined),
      [Symbol.asyncDispose]: jest.fn().mockResolvedValue(undefined),
      listArtifacts: jest.fn().mockResolvedValue([]),
      downloadArtifact: jest.fn(),
    } as unknown as SDKAgent;
    mockAcquire.mockImplementation(async (_scope, params) => {
      params.onBridgeToolRequest?.(bridgeToolRequest);
      return mockLease(agent);
    });

    const service = new CursorProxyService();
    const result = await service.forward({
      provider: 'cursor',
      apiKey: 'cursor-key',
      model: 'cursor/composer-2.5',
      body: {
        messages: [{ role: 'user', content: 'Run tool' }],
        tools: [{ type: 'function', function: { name: 'bash', parameters: { type: 'object' } } }],
      },
      stream: true,
      agentId: 'agent-db-1',
      sessionKey: 'conv-stream-early-bridge',
    });

    const text = await result.response.text();
    expect(text).toContain('tool_calls');
    expect(agent.send).not.toHaveBeenCalled();
  });

  it('streams tool_calls when live run has queued bridge events', async () => {
    const service = new CursorProxyService();
    const liveRun = startManifestCursorLiveRun({
      id: 'live-stream-bridge',
      scopeKey: 'scope-stream-bridge',
      agent: { agentId: 'agent-1' } as unknown as SDKAgent,
    });
    queueManifestLiveEvent(liveRun, { type: 'text-delta', text: 'partial' });
    queueManifestLiveEvent(liveRun, { type: 'bridge-tool', request: bridgeToolRequest });
    markManifestLiveRunFinished(liveRun);

    const result = await __testUtils.streamLiveRunUntilDoneForTests(
      service,
      liveRun,
      {
        provider: 'cursor',
        apiKey: 'cursor-key',
        model: 'cursor/composer-2.5',
        body: { messages: [{ role: 'user', content: 'Run tool' }] },
        stream: true,
        agentId: 'agent-db-1',
        sessionKey: 'conv-stream-bridge',
      },
      'cursor/composer-2.5',
      'prompt',
    );

    const text = await result.response.text();
    expect(text).toContain('tool_calls');
    expect(text).toContain('bash');
    expect(text).toContain('[DONE]');
  });

  it('finalizes background run and commits send when wait succeeds', async () => {
    let completion: Promise<void> | undefined;
    const agent = {
      agentId: 'agent-1',
      model: { id: 'composer-2.5' },
      send: jest.fn().mockReturnValue(mockRun('done')),
      close: jest.fn(),
      reload: jest.fn().mockResolvedValue(undefined),
      [Symbol.asyncDispose]: jest.fn().mockResolvedValue(undefined),
      listArtifacts: jest.fn().mockResolvedValue([]),
      downloadArtifact: jest.fn(),
    } as unknown as SDKAgent;
    const lease = mockLease(agent);
    lease.trackRunCompletion = jest.fn((promise: Promise<void>) => {
      completion = promise;
    });
    mockAcquire.mockResolvedValue(lease);

    const service = new CursorProxyService();
    await service.forward({
      provider: 'cursor',
      apiKey: 'cursor-key',
      model: 'cursor/composer-2.5',
      body: { messages: [{ role: 'user', content: 'Hi' }] },
      stream: false,
      agentId: 'a',
      sessionKey: 's',
    });
    await completion;
    expect(lease.commitSend).toHaveBeenCalled();
  });

  it('resets session agent when send plan requires reboot', async () => {
    const agent = {
      agentId: 'agent-1',
      model: { id: 'composer-2.5' },
      send: jest.fn().mockReturnValue(mockRun('ok')),
      close: jest.fn(),
      reload: jest.fn().mockResolvedValue(undefined),
      [Symbol.asyncDispose]: jest.fn().mockResolvedValue(undefined),
      listArtifacts: jest.fn().mockResolvedValue([]),
      downloadArtifact: jest.fn(),
    } as unknown as SDKAgent;
    mockAcquire
      .mockResolvedValueOnce(
        mockLease(agent, {
          bootstrapped: true,
          contextFingerprint: 'old',
          incrementalSendCount: MAX_COMPLETED_INCREMENTAL_SENDS_BEFORE_REBOOTSTRAP,
        }),
      )
      .mockResolvedValueOnce(mockLease(agent));

    const service = new CursorProxyService();
    await service.forward({
      provider: 'cursor',
      apiKey: 'cursor-key',
      model: 'cursor/composer-2.5',
      body: { messages: [{ role: 'user', content: 'Hi' }] },
      stream: false,
      agentId: 'agent-db-1',
      sessionKey: 'conv-1',
    });

    expect(mockReset).toHaveBeenCalled();
  });

  it('resets session agent with bridge tools and re-acquires fresh bridge', async () => {
    const agent = {
      agentId: 'agent-1',
      model: { id: 'composer-2.5' },
      send: jest.fn().mockReturnValue(mockRun('ok')),
      close: jest.fn(),
      reload: jest.fn().mockResolvedValue(undefined),
      [Symbol.asyncDispose]: jest.fn().mockResolvedValue(undefined),
      listArtifacts: jest.fn().mockResolvedValue([]),
      downloadArtifact: jest.fn(),
    } as unknown as SDKAgent;
    mockAcquire
      .mockResolvedValueOnce(
        mockLease(agent, {
          bootstrapped: true,
          contextFingerprint: 'old',
          incrementalSendCount: MAX_COMPLETED_INCREMENTAL_SENDS_BEFORE_REBOOTSTRAP,
        }),
      )
      .mockResolvedValueOnce(mockLease(agent));

    const service = new CursorProxyService();
    await service.forward({
      provider: 'cursor',
      apiKey: 'cursor-key',
      model: 'cursor/composer-2.5',
      body: {
        messages: [{ role: 'user', content: 'Hi' }],
        tools: [{ type: 'function', function: { name: 'bash', parameters: { type: 'object' } } }],
      },
      stream: false,
      agentId: 'agent-db-1',
      sessionKey: 'conv-reset-bridge',
    });

    expect(mockReset).toHaveBeenCalled();
    expect(mockAcquire).toHaveBeenCalledTimes(2);
  });

  it('returns 401 when api key missing', async () => {
    const service = new CursorProxyService();
    const result = await service.forward({
      provider: 'cursor',
      apiKey: '  ',
      model: 'cursor/composer-2.5',
      body: { messages: [] },
      stream: false,
      agentId: 'a',
      sessionKey: 's',
    });
    expect(result.response.status).toBe(401);
  });

  it('returns sanitized error when SDK throws', async () => {
    mockAcquire.mockRejectedValue(new Error('401 Unauthorized'));
    const service = new CursorProxyService();
    const result = await service.forward({
      provider: 'cursor',
      apiKey: 'bad',
      model: 'cursor/composer-2.5',
      body: { messages: [{ role: 'user', content: 'Hi' }] },
      stream: false,
      agentId: 'a',
      sessionKey: 's',
    });
    expect(result.response.status).toBe(502);
  });

  it('disposes session agents on module destroy', async () => {
    const service = new CursorProxyService();
    await service.onModuleDestroy();
    expect(mockAcquire).not.toHaveBeenCalled();
  });

  it('aborts in-flight stream when signal is aborted', async () => {
    const run = mockRun('partial');
    const agent = {
      agentId: 'agent-1',
      model: { id: 'composer-2.5' },
      send: jest.fn().mockReturnValue(run),
      close: jest.fn(),
      reload: jest.fn().mockResolvedValue(undefined),
      [Symbol.asyncDispose]: jest.fn().mockResolvedValue(undefined),
      listArtifacts: jest.fn().mockResolvedValue([]),
      downloadArtifact: jest.fn(),
    } as unknown as SDKAgent;
    mockAcquire.mockResolvedValue(mockLease(agent));

    const controller = new AbortController();
    controller.abort();
    const service = new CursorProxyService();
    const result = await service.forward({
      provider: 'cursor',
      apiKey: 'cursor-key',
      model: 'cursor/composer-2.5',
      body: { messages: [{ role: 'user', content: 'Hi' }] },
      stream: true,
      agentId: 'a',
      sessionKey: 's',
      signal: controller.signal,
    });
    expect(result.response.status).toBe(502);
  });

  it('uses wait() result text when stream yields no assistant deltas', async () => {
    const run = {
      ...mockRun('from-wait'),
      stream: async function* () {
        yield {
          type: 'status',
          agent_id: 'agent-1',
          run_id: 'run-1',
          status: 'RUNNING',
        };
      },
      wait: jest.fn().mockResolvedValue({ id: 'run-1', status: 'finished', result: 'from-wait' }),
    };
    const agent = {
      agentId: 'agent-1',
      model: { id: 'composer-2.5' },
      send: jest.fn().mockReturnValue(run),
      close: jest.fn(),
      reload: jest.fn().mockResolvedValue(undefined),
      [Symbol.asyncDispose]: jest.fn().mockResolvedValue(undefined),
      listArtifacts: jest.fn().mockResolvedValue([]),
      downloadArtifact: jest.fn(),
    } as unknown as SDKAgent;
    mockAcquire.mockResolvedValue(mockLease(agent));

    const service = new CursorProxyService();
    const result = await service.forward({
      provider: 'cursor',
      apiKey: 'cursor-key',
      model: 'cursor/composer-2.5',
      body: { messages: [{ role: 'user', content: 'Hi' }] },
      stream: false,
      agentId: 'a',
      sessionKey: 's',
    });
    const json = (await result.response.json()) as {
      choices: Array<{ message: { content: string } }>;
    };
    expect(json.choices[0].message.content).toBe('from-wait');
  });

  it('aborts non-stream collection when signal is aborted', async () => {
    const run = mockRun('partial');
    const agent = {
      agentId: 'agent-1',
      model: { id: 'composer-2.5' },
      send: jest.fn().mockReturnValue(run),
      close: jest.fn(),
      reload: jest.fn().mockResolvedValue(undefined),
      [Symbol.asyncDispose]: jest.fn().mockResolvedValue(undefined),
      listArtifacts: jest.fn().mockResolvedValue([]),
      downloadArtifact: jest.fn(),
    } as unknown as SDKAgent;
    mockAcquire.mockResolvedValue(mockLease(agent));

    const controller = new AbortController();
    controller.abort();
    const service = new CursorProxyService();
    const result = await service.forward({
      provider: 'cursor',
      apiKey: 'cursor-key',
      model: 'cursor/composer-2.5',
      body: { messages: [{ role: 'user', content: 'Hi' }] },
      stream: false,
      agentId: 'a',
      sessionKey: 's',
      signal: controller.signal,
    });
    expect(result.response.status).toBe(502);
  });

  it('surfaces SDK run errors without result text', async () => {
    const run = {
      ...mockRun(''),
      wait: jest.fn().mockResolvedValue({ id: 'run-1', status: 'error' }),
    };
    const agent = {
      agentId: 'agent-1',
      model: { id: 'composer-2.5' },
      send: jest.fn().mockReturnValue(run),
      close: jest.fn(),
      reload: jest.fn().mockResolvedValue(undefined),
      [Symbol.asyncDispose]: jest.fn().mockResolvedValue(undefined),
      listArtifacts: jest.fn().mockResolvedValue([]),
      downloadArtifact: jest.fn(),
    } as unknown as SDKAgent;
    mockAcquire.mockResolvedValue(mockLease(agent));

    const service = new CursorProxyService();
    const result = await service.forward({
      provider: 'cursor',
      apiKey: 'cursor-key',
      model: 'cursor/composer-2.5',
      body: { messages: [{ role: 'user', content: 'Hi' }] },
      stream: false,
      agentId: 'a',
      sessionKey: 's',
    });
    expect(result.response.status).toBe(502);
  });

  it('surfaces SDK run errors', async () => {
    const run = mockRun('', 'error');
    const agent = {
      agentId: 'agent-1',
      model: { id: 'composer-2.5' },
      send: jest.fn().mockReturnValue(run),
      close: jest.fn(),
      reload: jest.fn().mockResolvedValue(undefined),
      [Symbol.asyncDispose]: jest.fn().mockResolvedValue(undefined),
      listArtifacts: jest.fn().mockResolvedValue([]),
      downloadArtifact: jest.fn(),
    } as unknown as SDKAgent;
    mockAcquire.mockResolvedValue(mockLease(agent));

    const service = new CursorProxyService();
    const result = await service.forward({
      provider: 'cursor',
      apiKey: 'cursor-key',
      model: 'cursor/composer-2.5',
      body: { messages: [{ role: 'user', content: 'Hi' }] },
      stream: false,
      agentId: 'a',
      sessionKey: 's',
    });
    expect(result.response.status).toBe(502);
  });

  it('applies SDK text-delta updates to the live run', async () => {
    const service = new CursorProxyService();
    const liveRun = startManifestCursorLiveRun({
      id: 'live-delta',
      scopeKey: 'scope-delta',
      agent: { agentId: 'agent-1' } as unknown as SDKAgent,
    });
    __testUtils.handleSdkDeltaForTests(service, liveRun, { type: 'text-delta', text: 'chunk' });
    expect(liveRun.textDeltas).toEqual(['chunk']);
  });

  it('collectSdkRunWithBridge returns bridge requests from bridge poll ticks', async () => {
    const service = new CursorProxyService();
    const liveRun = startManifestCursorLiveRun({
      id: 'live-collect-text-progress',
      scopeKey: 'scope-collect-text-progress',
      agent: { agentId: 'agent-1' } as unknown as SDKAgent,
    });
    let releaseStream!: () => void;
    const streamGate = new Promise<void>((resolve) => {
      releaseStream = resolve;
    });
    const run = {
      id: 'run-1',
      agentId: 'agent-1',
      stream: async function* () {
        await streamGate;
      },
      wait: jest.fn().mockResolvedValue({ status: 'completed', result: '' }),
      cancel: jest.fn().mockResolvedValue(undefined),
    } as unknown as Awaited<ReturnType<SDKAgent['send']>>;

    const collectPromise = __testUtils.collectSdkRunWithBridgeForTests(service, liveRun, run);
    await new Promise((r) => setImmediate(r));
    queueManifestLiveEvent(liveRun, { type: 'text-delta', text: 'partial' });
    await new Promise((r) => setImmediate(r));
    queueManifestLiveEvent(liveRun, { type: 'bridge-tool', request: bridgeToolRequest });
    releaseStream();

    const result = await collectPromise;
    expect(result.text).toBe('');
    expect(result.bridgeRequests).toHaveLength(1);
  });

  it('collectSdkRunWithBridge returns bridge requests while the SDK stream is idle', async () => {
    const service = new CursorProxyService();
    const liveRun = startManifestCursorLiveRun({
      id: 'live-collect-idle',
      scopeKey: 'scope-collect-idle',
      agent: { agentId: 'agent-1' } as unknown as SDKAgent,
    });
    let releaseStream!: () => void;
    const streamGate = new Promise<void>((resolve) => {
      releaseStream = resolve;
    });
    const run = {
      id: 'run-1',
      agentId: 'agent-1',
      stream: async function* () {
        await streamGate;
      },
      wait: jest.fn().mockResolvedValue({ status: 'completed', result: '' }),
      cancel: jest.fn().mockResolvedValue(undefined),
    } as unknown as Awaited<ReturnType<SDKAgent['send']>>;

    const collectPromise = __testUtils.collectSdkRunWithBridgeForTests(service, liveRun, run);
    await new Promise((r) => setImmediate(r));
    queueManifestLiveEvent(liveRun, { type: 'bridge-tool', request: bridgeToolRequest });
    releaseStream();

    const result = await collectPromise;
    expect(result.bridgeRequests).toHaveLength(1);
    expect(run.wait).not.toHaveBeenCalled();
  });

  it('collectSdkRunWithBridge returns bridge requests from the live run queue', async () => {
    const service = new CursorProxyService();
    const liveRun = startManifestCursorLiveRun({
      id: 'live-collect',
      scopeKey: 'scope-collect',
      agent: { agentId: 'agent-1' } as unknown as SDKAgent,
    });
    let releaseStream!: () => void;
    const streamGate = new Promise<void>((resolve) => {
      releaseStream = resolve;
    });
    const run = {
      id: 'run-1',
      agentId: 'agent-1',
      stream: async function* () {
        yield {
          type: 'assistant',
          agent_id: 'agent-1',
          run_id: 'run-1',
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: 'hi' }],
          },
        };
        queueManifestLiveEvent(liveRun, { type: 'bridge-tool', request: bridgeToolRequest });
        await streamGate;
      },
      wait: jest.fn(),
      cancel: jest.fn().mockResolvedValue(undefined),
    } as unknown as Awaited<ReturnType<SDKAgent['send']>>;

    const result = await __testUtils.collectSdkRunWithBridgeForTests(service, liveRun, run);
    releaseStream();
    expect(result.bridgeRequests).toHaveLength(1);
    expect(result.text).toBe('hi');
  });

  it('collectSdkRunWithBridge propagates unexpected bridge poll errors', async () => {
    const bridgePollSpy = jest
      .spyOn(manifestCursorLiveRun, 'waitForBridgeToolOrLiveRunDone')
      .mockRejectedValueOnce(new Error('bridge poll failed'));
    const service = new CursorProxyService();
    const liveRun = startManifestCursorLiveRun({
      id: 'live-bridge-poll-error',
      scopeKey: 'scope-bridge-poll-error',
      agent: { agentId: 'agent-1' } as unknown as SDKAgent,
    });
    const run = {
      id: 'run-1',
      agentId: 'agent-1',
      stream: async function* () {
        yield {
          type: 'assistant',
          agent_id: 'agent-1',
          run_id: 'run-1',
          message: { role: 'assistant', content: [{ type: 'text', text: 'x' }] },
        };
      },
      wait: jest.fn(),
      cancel: jest.fn().mockResolvedValue(undefined),
    } as unknown as Awaited<ReturnType<SDKAgent['send']>>;

    await expect(
      __testUtils.collectSdkRunWithBridgeForTests(service, liveRun, run),
    ).rejects.toThrow('bridge poll failed');
    bridgePollSpy.mockRestore();
  });

  it('collectSdkRunWithBridge aborts when the signal aborts during bridge poll wait', async () => {
    const service = new CursorProxyService();
    const liveRun = startManifestCursorLiveRun({
      id: 'live-abort-progress',
      scopeKey: 'scope-abort-progress',
      agent: { agentId: 'agent-1' } as unknown as SDKAgent,
    });
    let releaseStream!: () => void;
    const streamGate = new Promise<void>((resolve) => {
      releaseStream = resolve;
    });
    const controller = new AbortController();
    const run = {
      id: 'run-1',
      agentId: 'agent-1',
      stream: async function* () {
        await streamGate;
      },
      wait: jest.fn(),
      cancel: jest.fn().mockResolvedValue(undefined),
    } as unknown as Awaited<ReturnType<SDKAgent['send']>>;

    const collectPromise = __testUtils.collectSdkRunWithBridgeForTests(
      service,
      liveRun,
      run,
      controller.signal,
    );
    await new Promise((r) => setImmediate(r));
    controller.abort();
    await expect(collectPromise).rejects.toThrow('Request aborted');
    releaseStream();
    expect(run.cancel).toHaveBeenCalled();
  });

  it('collectSdkRunWithBridge aborts when the signal is aborted mid-stream', async () => {
    const service = new CursorProxyService();
    const liveRun = startManifestCursorLiveRun({
      id: 'live-abort-collect',
      scopeKey: 'scope-abort-collect',
      agent: { agentId: 'agent-1' } as unknown as SDKAgent,
    });
    const controller = new AbortController();
    const run = {
      id: 'run-1',
      agentId: 'agent-1',
      stream: async function* () {
        yield {
          type: 'assistant',
          agent_id: 'agent-1',
          run_id: 'run-1',
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: 'partial' }],
          },
        };
        controller.abort();
        yield {
          type: 'assistant',
          agent_id: 'agent-1',
          run_id: 'run-1',
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: 'more' }],
          },
        };
      },
      wait: jest.fn(),
      cancel: jest.fn().mockResolvedValue(undefined),
    } as unknown as Awaited<ReturnType<SDKAgent['send']>>;

    await expect(
      __testUtils.collectSdkRunWithBridgeForTests(service, liveRun, run, controller.signal),
    ).rejects.toThrow('Request aborted');
    expect(run.cancel).toHaveBeenCalled();
  });

  it('streams assistant deltas and tool_calls from an attached SDK run', async () => {
    const service = new CursorProxyService();
    const liveRun = startManifestCursorLiveRun({
      id: 'live-sdk-stream',
      scopeKey: 'scope-sdk-stream',
      agent: { agentId: 'agent-1' } as unknown as SDKAgent,
    });
    const run = {
      id: 'run-1',
      agentId: 'agent-1',
      stream: async function* () {
        yield {
          type: 'assistant',
          agent_id: 'agent-1',
          run_id: 'run-1',
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: 'from-sdk' }],
          },
        };
        queueManifestLiveEvent(liveRun, { type: 'bridge-tool', request: bridgeToolRequest });
      },
      cancel: jest.fn().mockResolvedValue(undefined),
    } as unknown as Awaited<ReturnType<SDKAgent['send']>>;

    const result = await __testUtils.streamLiveRunUntilDoneForTests(
      service,
      liveRun,
      {
        provider: 'cursor',
        apiKey: 'cursor-key',
        model: 'cursor/composer-2.5',
        body: { messages: [{ role: 'user', content: 'Hi' }] },
        stream: true,
        agentId: 'a',
        sessionKey: 's',
      },
      'cursor/composer-2.5',
      'prompt',
      run,
    );
    const text = await result.response.text();
    expect(text).toContain('from-sdk');
    expect(text).toContain('tool_calls');
  });

  it('streams trailing bridge tools after the SDK run stream completes', async () => {
    const service = new CursorProxyService();
    const liveRun = startManifestCursorLiveRun({
      id: 'live-trailing',
      scopeKey: 'scope-trailing',
      agent: { agentId: 'agent-1' } as unknown as SDKAgent,
    });
    const run = {
      id: 'run-1',
      agentId: 'agent-1',
      stream: async function* () {
        yield {
          type: 'assistant',
          agent_id: 'agent-1',
          run_id: 'run-1',
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: 'done' }],
          },
        };
        queueManifestLiveEvent(liveRun, { type: 'bridge-tool', request: bridgeToolRequest });
      },
      cancel: jest.fn().mockResolvedValue(undefined),
    } as unknown as Awaited<ReturnType<SDKAgent['send']>>;

    const result = await __testUtils.streamLiveRunUntilDoneForTests(
      service,
      liveRun,
      {
        provider: 'cursor',
        apiKey: 'cursor-key',
        model: 'cursor/composer-2.5',
        body: { messages: [{ role: 'user', content: 'Hi' }] },
        stream: true,
        agentId: 'a',
        sessionKey: 's',
      },
      'cursor/composer-2.5',
      'prompt',
      run,
    );
    const text = await result.response.text();
    expect(text).toContain('tool_calls');
    expect(text).toContain('done');
  });

  it('waits for live-run progress and streams queued text deltas', async () => {
    const service = new CursorProxyService();
    const liveRun = startManifestCursorLiveRun({
      id: 'live-wait',
      scopeKey: 'scope-wait',
      agent: { agentId: 'agent-1' } as unknown as SDKAgent,
    });

    const resultPromise = __testUtils.streamLiveRunUntilDoneForTests(
      service,
      liveRun,
      {
        provider: 'cursor',
        apiKey: 'cursor-key',
        model: 'cursor/composer-2.5',
        body: { messages: [{ role: 'user', content: 'Hi' }] },
        stream: true,
        agentId: 'a',
        sessionKey: 's',
      },
      'cursor/composer-2.5',
      'prompt',
    );
    await new Promise((r) => setImmediate(r));
    queueManifestLiveEvent(liveRun, { type: 'text-delta', text: 'queued' });
    markManifestLiveRunFinished(liveRun);
    const result = await resultPromise;
    const text = await result.response.text();
    expect(text).toContain('queued');
    expect(text).toContain('[DONE]');
  });

  it('collectLiveRunUntilDone joins text deltas after progress', async () => {
    const service = new CursorProxyService();
    const liveRun = startManifestCursorLiveRun({
      id: 'live-collect-done',
      scopeKey: 'scope-collect-done',
      agent: { agentId: 'agent-1' } as unknown as SDKAgent,
    });
    liveRun.textDeltas.push('joined');
    markManifestLiveRunFinished(liveRun);

    const result = await __testUtils.collectLiveRunUntilDoneForTests(service, liveRun);
    expect(result.text).toBe('joined');
  });

  it('marks live run error when background finalize wait throws', async () => {
    const service = new CursorProxyService();
    const liveRun = startManifestCursorLiveRun({
      id: 'live-finalize-err',
      scopeKey: 'scope-finalize-err',
      agent: { agentId: 'agent-1' } as unknown as SDKAgent,
    });
    const run = {
      wait: jest.fn().mockRejectedValue(new Error('wait blew up')),
      cancel: jest.fn().mockResolvedValue(undefined),
    } as unknown as Awaited<ReturnType<SDKAgent['send']>>;
    const lease = mockLease({ agentId: 'agent-1' } as unknown as SDKAgent);

    await __testUtils.finalizeLiveRunInBackgroundForTests(
      service,
      liveRun,
      run,
      lease,
      'fp',
      false,
    );
    expect(liveRun.errorMessage).toBe('wait blew up');
    expect(lease.commitSend).not.toHaveBeenCalled();
  });

  it('aborts streamLiveRunUntilDone when the signal aborts during progress wait', async () => {
    const service = new CursorProxyService();
    const liveRun = startManifestCursorLiveRun({
      id: 'live-stream-abort',
      scopeKey: 'scope-stream-abort',
      agent: { agentId: 'agent-1' } as unknown as SDKAgent,
    });
    const controller = new AbortController();
    const result = await __testUtils.streamLiveRunUntilDoneForTests(
      service,
      liveRun,
      {
        provider: 'cursor',
        apiKey: 'cursor-key',
        model: 'cursor/composer-2.5',
        body: { messages: [{ role: 'user', content: 'Hi' }] },
        stream: true,
        agentId: 'a',
        sessionKey: 's',
        signal: controller.signal,
      },
      'cursor/composer-2.5',
      'prompt',
    );
    const readPromise = result.response.text();
    await new Promise((r) => setImmediate(r));
    controller.abort();
    await expect(readPromise).rejects.toBeInstanceOf(ManifestCursorLiveRunAbortError);
  });

  it('prefers SDK run.stream text over duplicate onDelta when both fire', async () => {
    const agent = {
      agentId: 'agent-1',
      model: { id: 'composer-2.5' },
      send: jest.fn((_msg, options) => {
        options?.onDelta?.({ update: { type: 'text-delta', text: 'delta-chunk' } });
        return mockRun('stream-body');
      }),
      close: jest.fn(),
      reload: jest.fn().mockResolvedValue(undefined),
      [Symbol.asyncDispose]: jest.fn().mockResolvedValue(undefined),
      listArtifacts: jest.fn().mockResolvedValue([]),
      downloadArtifact: jest.fn(),
    } as unknown as SDKAgent;
    mockAcquire.mockResolvedValue(mockLease(agent));

    const service = new CursorProxyService();
    const result = await service.forward({
      provider: 'cursor',
      apiKey: 'cursor-key',
      model: 'cursor/composer-2.5',
      body: { messages: [{ role: 'user', content: 'Hi' }] },
      stream: true,
      agentId: 'a',
      sessionKey: 's',
    });
    const text = await result.response.text();
    expect(text).toContain('stream-body');
    expect(text).not.toContain('delta-chunk');
  });

  it('does not emit duplicate content for cumulative run.stream assistant snapshots', async () => {
    const agent = {
      agentId: 'agent-1',
      model: { id: 'composer-2.5' },
      send: jest.fn(() => ({
        stream: () => ({
          [Symbol.asyncIterator]() {
            const snapshots = ["I'll call", "I'll call the web"];
            let index = 0;
            return {
              next: async () => {
                if (index >= snapshots.length) return { done: true, value: undefined };
                const text = snapshots[index++]!;
                return {
                  done: false,
                  value: {
                    type: 'assistant',
                    agent_id: 'agent-1',
                    run_id: 'run-1',
                    message: {
                      role: 'assistant',
                      content: [{ type: 'text', text }],
                    },
                  },
                };
              },
            };
          },
        }),
        wait: jest.fn().mockResolvedValue({ status: 'finished', result: "I'll call the web" }),
        cancel: jest.fn().mockResolvedValue(undefined),
      })),
      close: jest.fn(),
      reload: jest.fn().mockResolvedValue(undefined),
      [Symbol.asyncDispose]: jest.fn().mockResolvedValue(undefined),
      listArtifacts: jest.fn().mockResolvedValue([]),
      downloadArtifact: jest.fn(),
    } as unknown as SDKAgent;
    mockAcquire.mockResolvedValue(mockLease(agent));

    const service = new CursorProxyService();
    const result = await service.forward({
      provider: 'cursor',
      apiKey: 'cursor-key',
      model: 'cursor/composer-2.5',
      body: { messages: [{ role: 'user', content: 'Hi' }] },
      stream: true,
      agentId: 'a',
      sessionKey: 's-cumulative',
    });
    const text = await result.response.text();
    expect(text).toContain('"content":"I\'ll call"');
    expect(text).toContain('"content":" the web"');
    expect(text.match(/"content":"I'll call the web"/g) ?? []).toHaveLength(0);
  });

  it('does not emit the full assistant text twice when onDelta mirrors run.stream', async () => {
    const duplicate = 'same-text-twice';
    const agent = {
      agentId: 'agent-1',
      model: { id: 'composer-2.5' },
      send: jest.fn((_msg, options) => {
        options?.onDelta?.({ update: { type: 'text-delta', text: duplicate } });
        return mockRun(duplicate);
      }),
      close: jest.fn(),
      reload: jest.fn().mockResolvedValue(undefined),
      [Symbol.asyncDispose]: jest.fn().mockResolvedValue(undefined),
      listArtifacts: jest.fn().mockResolvedValue([]),
      downloadArtifact: jest.fn(),
    } as unknown as SDKAgent;
    mockAcquire.mockResolvedValue(mockLease(agent));

    const service = new CursorProxyService();
    const result = await service.forward({
      provider: 'cursor',
      apiKey: 'cursor-key',
      model: 'cursor/composer-2.5',
      body: { messages: [{ role: 'user', content: 'Hi' }] },
      stream: true,
      agentId: 'a',
      sessionKey: 's',
    });
    const text = await result.response.text();
    const contentChunks = text.match(/"content":"same-text-twice"/g) ?? [];
    expect(contentChunks).toHaveLength(1);
  });

  it('streams tool_calls when bridge arrives during the live-run wait loop', async () => {
    const service = new CursorProxyService();
    const liveRun = startManifestCursorLiveRun({
      id: 'live-wait-bridge',
      scopeKey: 'scope-wait-bridge',
      agent: { agentId: 'agent-1' } as unknown as SDKAgent,
    });
    const resultPromise = __testUtils.streamLiveRunUntilDoneForTests(
      service,
      liveRun,
      {
        provider: 'cursor',
        apiKey: 'cursor-key',
        model: 'cursor/composer-2.5',
        body: { messages: [{ role: 'user', content: 'Hi' }] },
        stream: true,
        agentId: 'a',
        sessionKey: 's',
      },
      'cursor/composer-2.5',
      'prompt',
    );
    await new Promise((r) => setImmediate(r));
    queueManifestLiveEvent(liveRun, { type: 'bridge-tool', request: bridgeToolRequest });
    const text = await (await resultPromise).response.text();
    expect(text).toContain('tool_calls');
  });

  it('rejects streamLiveRunUntilDone when the signal is already aborted', async () => {
    const service = new CursorProxyService();
    const liveRun = startManifestCursorLiveRun({
      id: 'live-pre-abort',
      scopeKey: 'scope-pre-abort',
      agent: { agentId: 'agent-1' } as unknown as SDKAgent,
    });
    const controller = new AbortController();
    controller.abort();
    await expect(
      __testUtils.streamLiveRunUntilDoneForTests(
        service,
        liveRun,
        {
          provider: 'cursor',
          apiKey: 'cursor-key',
          model: 'cursor/composer-2.5',
          body: { messages: [{ role: 'user', content: 'Hi' }] },
          stream: true,
          agentId: 'a',
          sessionKey: 's',
          signal: controller.signal,
        },
        'cursor/composer-2.5',
        'prompt',
      ),
    ).rejects.toThrow('Request aborted');
  });

  it('collectLiveRunUntilDone waits until the live run finishes', async () => {
    const service = new CursorProxyService();
    const liveRun = startManifestCursorLiveRun({
      id: 'live-collect-wait',
      scopeKey: 'scope-collect-wait',
      agent: { agentId: 'agent-1' } as unknown as SDKAgent,
    });
    const collectPromise = __testUtils.collectLiveRunUntilDoneForTests(service, liveRun);
    await new Promise((r) => setImmediate(r));
    liveRun.textDeltas.push('after-wait');
    markManifestLiveRunFinished(liveRun);
    const result = await collectPromise;
    expect(result.text).toBe('after-wait');
  });

  it('returns tool_calls when bridgeRun handler fires during executeRun wiring', async () => {
    const bridgeRun = {
      id: 'bridge-wire',
      setOnToolRequest: jest.fn((handler?: (request: ManifestBridgeToolRequest) => void) => {
        handler?.(bridgeToolRequest);
      }),
      cancel: jest.fn(),
      dispose: jest.fn().mockResolvedValue(undefined),
    } as unknown as ManifestToolBridgeRun;
    const agent = {
      agentId: 'agent-1',
      model: { id: 'composer-2.5' },
      send: jest.fn().mockReturnValue(mockRun('ok')),
      close: jest.fn(),
      reload: jest.fn().mockResolvedValue(undefined),
      [Symbol.asyncDispose]: jest.fn().mockResolvedValue(undefined),
      listArtifacts: jest.fn().mockResolvedValue([]),
      downloadArtifact: jest.fn(),
    } as unknown as SDKAgent;
    mockAcquire.mockResolvedValue(mockLease(agent, undefined, bridgeRun));

    const service = new CursorProxyService();
    const result = await service.forward({
      provider: 'cursor',
      apiKey: 'cursor-key',
      model: 'cursor/composer-2.5',
      body: {
        messages: [{ role: 'user', content: 'Hi' }],
        tools: [{ type: 'function', function: { name: 'bash', parameters: { type: 'object' } } }],
      },
      stream: false,
      agentId: 'a',
      sessionKey: 's-bridge-wire',
    });
    expect(bridgeRun.setOnToolRequest).toHaveBeenCalled();
    expect(agent.send).not.toHaveBeenCalled();
    const json = (await result.response.json()) as {
      choices: Array<{ finish_reason: string }>;
    };
    expect(json.choices[0].finish_reason).toBe('tool_calls');
  });

  it('queues bridge on the live run via reset-path onBridgeToolRequest', async () => {
    const queueSpy = jest.spyOn(manifestCursorLiveRun, 'queueManifestLiveEvent');
    let onBridgeSecond: ((request: ManifestBridgeToolRequest) => void) | undefined;
    let releaseSend: (() => void) | undefined;
    let sendStarted!: () => void;
    const sendStartedPromise = new Promise<void>((resolve) => {
      sendStarted = resolve;
    });
    const agent = {
      agentId: 'agent-1',
      model: { id: 'composer-2.5' },
      send: jest.fn(
        () =>
          new Promise((resolve) => {
            sendStarted();
            releaseSend = () =>
              resolve({
                ...mockRun(''),
                stream: async function* () {
                  yield {
                    type: 'assistant',
                    agent_id: 'agent-1',
                    run_id: 'run-1',
                    message: {
                      role: 'assistant',
                      content: [{ type: 'text', text: 'done' }],
                    },
                  };
                },
              });
          }),
      ),
      close: jest.fn(),
      reload: jest.fn().mockResolvedValue(undefined),
      [Symbol.asyncDispose]: jest.fn().mockResolvedValue(undefined),
      listArtifacts: jest.fn().mockResolvedValue([]),
      downloadArtifact: jest.fn(),
    } as unknown as SDKAgent;
    mockAcquire
      .mockResolvedValueOnce(
        mockLease(agent, {
          bootstrapped: true,
          contextFingerprint: 'old',
          incrementalSendCount: MAX_COMPLETED_INCREMENTAL_SENDS_BEFORE_REBOOTSTRAP,
        }),
      )
      .mockImplementationOnce(async (_scope, params) => {
        onBridgeSecond = params.onBridgeToolRequest;
        return mockLease(agent);
      });

    const service = new CursorProxyService();
    const forwardPromise = service.forward({
      provider: 'cursor',
      apiKey: 'cursor-key',
      model: 'cursor/composer-2.5',
      body: {
        messages: [{ role: 'user', content: 'Hi' }],
        tools: [{ type: 'function', function: { name: 'bash', parameters: { type: 'object' } } }],
      },
      stream: false,
      agentId: 'agent-db-1',
      sessionKey: 'conv-reset-live-on-bridge',
    });
    await sendStartedPromise;
    onBridgeSecond?.(bridgeToolRequest);
    releaseSend?.();
    await forwardPromise;
    expect(queueSpy).toHaveBeenCalledWith(
      expect.objectContaining({ id: expect.any(String) }),
      expect.objectContaining({ type: 'bridge-tool', request: bridgeToolRequest }),
    );
    expect(mockAcquire).toHaveBeenCalledTimes(2);
    queueSpy.mockRestore();
  });

  it('returns tool_calls from executeRun after collectSdkRunWithBridge', async () => {
    const service = new CursorProxyService();
    const serviceWithPrivates = service as unknown as {
      collectSdkRunWithBridge: () => Promise<{
        text: string;
        bridgeRequests: ManifestBridgeToolRequest[];
      }>;
    };
    const collectSpy = jest
      .spyOn(serviceWithPrivates, 'collectSdkRunWithBridge')
      .mockResolvedValue({
        text: 'partial',
        bridgeRequests: [bridgeToolRequest],
      });
    const agent = {
      agentId: 'agent-1',
      model: { id: 'composer-2.5' },
      send: jest.fn().mockReturnValue(mockRun('partial')),
      close: jest.fn(),
      reload: jest.fn().mockResolvedValue(undefined),
      [Symbol.asyncDispose]: jest.fn().mockResolvedValue(undefined),
      listArtifacts: jest.fn().mockResolvedValue([]),
      downloadArtifact: jest.fn(),
    } as unknown as SDKAgent;
    const bridgeSnapshot = buildManifestToolBridgeSnapshotFromOpenAiTools([
      { type: 'function', function: { name: 'bash' } },
    ]);
    const context = openAiMessagesToContext({
      messages: [{ role: 'user', content: 'Run tool' }],
      tools: [{ type: 'function', function: { name: 'bash', parameters: { type: 'object' } } }],
    });
    const lease = mockLease(agent);
    const result = await __testUtils.executeRunForTests(service, {
      lease,
      plan: { mode: 'bootstrap', resetAgent: false, reason: 'initial' },
      context,
      opts: {
        provider: 'cursor',
        apiKey: 'cursor-key',
        model: 'cursor/composer-2.5',
        body: {
          messages: [{ role: 'user', content: 'Run tool' }],
          tools: [{ type: 'function', function: { name: 'bash', parameters: { type: 'object' } } }],
        },
        stream: false,
        agentId: 'agent-db-1',
        sessionKey: 'conv-exec-302',
      },
      manifestModelId: 'cursor/composer-2.5',
      apiKey: 'cursor-key',
      scopeKey: 'scope-exec-302',
      bridgeSnapshot,
      bridgeEnabled: true,
    });
    const json = (await result.response.json()) as {
      choices: Array<{ finish_reason: string }>;
    };
    expect(json.choices[0].finish_reason).toBe('tool_calls');
    collectSpy.mockRestore();
  });

  it('queues bridge tools before live run during agent reset re-acquire', async () => {
    const agent = {
      agentId: 'agent-1',
      model: { id: 'composer-2.5' },
      send: jest.fn().mockReturnValue(mockRun('ok')),
      close: jest.fn(),
      reload: jest.fn().mockResolvedValue(undefined),
      [Symbol.asyncDispose]: jest.fn().mockResolvedValue(undefined),
      listArtifacts: jest.fn().mockResolvedValue([]),
      downloadArtifact: jest.fn(),
    } as unknown as SDKAgent;
    mockAcquire
      .mockResolvedValueOnce(
        mockLease(agent, {
          bootstrapped: true,
          contextFingerprint: 'old',
          incrementalSendCount: MAX_COMPLETED_INCREMENTAL_SENDS_BEFORE_REBOOTSTRAP,
        }),
      )
      .mockImplementationOnce(async (_scope, params) => {
        params.onBridgeToolRequest?.(bridgeToolRequest);
        return mockLease(agent);
      });

    const service = new CursorProxyService();
    const result = await service.forward({
      provider: 'cursor',
      apiKey: 'cursor-key',
      model: 'cursor/composer-2.5',
      body: {
        messages: [{ role: 'user', content: 'Hi' }],
        tools: [{ type: 'function', function: { name: 'bash', parameters: { type: 'object' } } }],
      },
      stream: false,
      agentId: 'agent-db-1',
      sessionKey: 'conv-reset-pre-bridge',
    });
    const json = (await result.response.json()) as {
      choices: Array<{ finish_reason: string }>;
    };
    expect(json.choices[0].finish_reason).toBe('tool_calls');
    expect(mockAcquire).toHaveBeenCalledTimes(2);
  });

  it('routes onBridgeToolRequest to the live run when send is in flight', async () => {
    const queueSpy = jest.spyOn(manifestCursorLiveRun, 'queueManifestLiveEvent');
    let onBridgeToolRequest: ((request: ManifestBridgeToolRequest) => void) | undefined;
    let releaseSend: (() => void) | undefined;
    const agent = {
      agentId: 'agent-1',
      model: { id: 'composer-2.5' },
      send: jest.fn(
        () =>
          new Promise((resolve) => {
            releaseSend = () => resolve(mockRun('late'));
          }),
      ),
      close: jest.fn(),
      reload: jest.fn().mockResolvedValue(undefined),
      [Symbol.asyncDispose]: jest.fn().mockResolvedValue(undefined),
      listArtifacts: jest.fn().mockResolvedValue([]),
      downloadArtifact: jest.fn(),
    } as unknown as SDKAgent;
    mockAcquire.mockImplementation(async (_scope, params) => {
      onBridgeToolRequest = params.onBridgeToolRequest;
      return mockLease(agent);
    });

    const service = new CursorProxyService();
    const forwardPromise = service.forward({
      provider: 'cursor',
      apiKey: 'cursor-key',
      model: 'cursor/composer-2.5',
      body: {
        messages: [{ role: 'user', content: 'Run tool' }],
        tools: [{ type: 'function', function: { name: 'bash', parameters: { type: 'object' } } }],
      },
      stream: false,
      agentId: 'agent-db-1',
      sessionKey: 'conv-bridge-inflight',
    });
    await new Promise((r) => setImmediate(r));
    onBridgeToolRequest?.(bridgeToolRequest);
    releaseSend?.();
    await forwardPromise;
    expect(queueSpy).toHaveBeenCalledWith(
      expect.objectContaining({ id: expect.any(String) }),
      expect.objectContaining({ type: 'bridge-tool', request: bridgeToolRequest }),
    );
    queueSpy.mockRestore();
  });

  it('returns tool_calls from collectSdkRunWithBridge via buildForwardResult', async () => {
    const service = new CursorProxyService();
    const liveRun = startManifestCursorLiveRun({
      id: 'live-build-forward',
      scopeKey: 'scope-build-forward',
      agent: { agentId: 'agent-1' } as unknown as SDKAgent,
    });
    const run = {
      id: 'run-1',
      agentId: 'agent-1',
      stream: async function* () {
        queueManifestLiveEvent(liveRun, { type: 'bridge-tool', request: bridgeToolRequest });
        yield {
          type: 'assistant',
          agent_id: 'agent-1',
          run_id: 'run-1',
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: 'partial' }],
          },
        };
      },
      wait: jest.fn(),
      cancel: jest.fn().mockResolvedValue(undefined),
    } as unknown as Awaited<ReturnType<SDKAgent['send']>>;

    const collected = await __testUtils.collectSdkRunWithBridgeForTests(service, liveRun, run);
    const result = __testUtils.buildForwardResultForTests(
      service,
      'cursor/composer-2.5',
      collected.text,
      collected.bridgeRequests,
      false,
      'prompt',
    );
    const json = (await result.response.json()) as {
      choices: Array<{ finish_reason: string }>;
    };
    expect(collected.bridgeRequests).toHaveLength(1);
    expect(json.choices[0].finish_reason).toBe('tool_calls');
  });

  it('buildForwardResult commits send when there are no tool calls', () => {
    const agent = {
      agentId: 'agent-1',
      model: { id: 'composer-2.5' },
    } as unknown as SDKAgent;
    const lease = mockLease(agent);
    const service = new CursorProxyService();
    __testUtils.buildForwardResultForTests(
      service,
      'cursor/composer-2.5',
      'hello',
      [],
      false,
      'prompt',
      lease,
      'fingerprint-1',
      true,
    );
    expect(lease.commitSend).toHaveBeenCalledWith('fingerprint-1', true);
  });

  it('marks live run error when the SDK stream throws', async () => {
    const service = new CursorProxyService();
    const liveRun = startManifestCursorLiveRun({
      id: 'live-stream-error',
      scopeKey: 'scope-stream-error',
      agent: { agentId: 'agent-1' } as unknown as SDKAgent,
    });
    const run = {
      id: 'run-1',
      agentId: 'agent-1',
      stream: async function* () {
        throw new Error('stream blew up');
      },
      cancel: jest.fn().mockResolvedValue(undefined),
    } as unknown as Awaited<ReturnType<SDKAgent['send']>>;

    const result = await __testUtils.streamLiveRunUntilDoneForTests(
      service,
      liveRun,
      {
        provider: 'cursor',
        apiKey: 'cursor-key',
        model: 'cursor/composer-2.5',
        body: { messages: [{ role: 'user', content: 'Hi' }] },
        stream: true,
        agentId: 'a',
        sessionKey: 's',
      },
      'cursor/composer-2.5',
      'prompt',
      run,
    );
    await expect(result.response.text()).rejects.toThrow('stream blew up');
    expect(liveRun.errorMessage).toBe('stream blew up');
  });

  it('aborts SDK stream iteration when signal aborts between stream events', async () => {
    const service = new CursorProxyService();
    const liveRun = startManifestCursorLiveRun({
      id: 'live-stream-mid-abort',
      scopeKey: 'scope-stream-mid-abort',
      agent: { agentId: 'agent-1' } as unknown as SDKAgent,
    });
    const controller = new AbortController();
    let resumeGenerator: (() => void) | undefined;
    const run = {
      id: 'run-1',
      agentId: 'agent-1',
      stream: async function* () {
        yield {
          type: 'assistant',
          agent_id: 'agent-1',
          run_id: 'run-1',
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: 'partial' }],
          },
        };
        await new Promise<void>((resolve) => {
          resumeGenerator = resolve;
        });
        yield {
          type: 'assistant',
          agent_id: 'agent-1',
          run_id: 'run-1',
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: 'more' }],
          },
        };
      },
      cancel: jest.fn().mockResolvedValue(undefined),
    } as unknown as Awaited<ReturnType<SDKAgent['send']>>;

    const result = await __testUtils.streamLiveRunUntilDoneForTests(
      service,
      liveRun,
      {
        provider: 'cursor',
        apiKey: 'cursor-key',
        model: 'cursor/composer-2.5',
        body: { messages: [{ role: 'user', content: 'Hi' }] },
        stream: true,
        agentId: 'a',
        sessionKey: 's',
        signal: controller.signal,
      },
      'cursor/composer-2.5',
      'prompt',
      run,
    );
    const readPromise = result.response.text();
    await new Promise((r) => setImmediate(r));
    controller.abort();
    resumeGenerator?.();
    await expect(readPromise).rejects.toThrow('Request aborted');
    expect(run.cancel).toHaveBeenCalled();
  });
});
