import type { SDKAgent } from '@cursor/sdk';
import {
  acquireSessionCursorAgent,
  disposeAllSessionCursorAgents,
  resetSessionCursorAgent,
} from './adapted/cursor-session-agent';
import { MAX_COMPLETED_INCREMENTAL_SENDS_BEFORE_REBOOTSTRAP } from './adapted/cursor-session-send-policy';
import { CursorProxyService } from './cursor-proxy.service';

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
) {
  return {
    scopeKey: 'scope',
    poolKey: 'pool',
    instanceId: 1,
    agent,
    sendState,
    created: true,
    commitSend: jest.fn(),
    trackRunCompletion: jest.fn(),
  };
}

describe('CursorProxyService', () => {
  afterEach(async () => {
    jest.clearAllMocks();
    await disposeAllSessionCursorAgents();
  });

  it('uses incremental prompt on follow-up turns', async () => {
    const { computeManifestContextFingerprint } = await import('./cursor-message-converter');
    const context = { messages: [{ role: 'user', content: 'Follow up' }] };
    const fingerprint = computeManifestContextFingerprint(context);
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
});
