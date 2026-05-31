/**
 * Live Cursor SDK integration tests. Requires CURSOR_API_KEY in the environment.
 * Run: CURSOR_API_KEY=... npm test -- --testPathPattern=cursor-proxy.live
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { disposeAllSessionCursorAgents } from './adapted/cursor-session-agent';
import {
  __manifestBridgeTestUtils,
  disposeManifestToolBridgeForTests,
} from './adapted/manifest-tool-bridge-server';
import {
  manifestCursorLiveRuns,
  markManifestLiveRunFinished,
  releaseAllManifestCursorLiveRunsForTests,
} from './adapted/manifest-cursor-live-run';
import { buildCursorSessionPoolKey } from './cursor-session-pool';
import { CursorProxyService } from './cursor-proxy.service';

const apiKey = process.env.CURSOR_API_KEY?.trim();
const describeLive = apiKey ? describe : describe.skip;

const LIVE_MODEL = process.env.CURSOR_LIVE_MODEL?.trim() || 'cursor/composer-2.5';
const LIVE_TIMEOUT_MS = 120_000;
const BRIDGE_POLL_MS = 30_000;

const bashTool = {
  type: 'function' as const,
  function: {
    name: 'bash',
    description: 'Run a shell command',
    parameters: {
      type: 'object',
      properties: { command: { type: 'string' } },
      required: ['command'],
    },
  },
};

function fireBridgeBashToolCall(url: string): void {
  const client = new Client({ name: 'manifest-live-test', version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(url));
  void (async () => {
    try {
      await client.connect(transport);
      await client.callTool({
        name: 'manifest__bash',
        arguments: { command: 'echo bridge-live-ok' },
      });
    } catch {
      // MCP may fail if the live run ends before tool results are resolved.
    } finally {
      await transport.close().catch(() => undefined);
    }
  })();
}

async function invokeBridgeDuringForward(
  forwardPromise: Promise<{ response: Response }>,
  pollMs: number,
): Promise<Response> {
  const [, result] = await Promise.all([
    (async () => {
      const bridgeUrl = await waitForBridgeMcpUrl(pollMs);
      await new Promise((r) => setTimeout(r, 250));
      fireBridgeBashToolCall(bridgeUrl);
    })(),
    forwardPromise,
  ]);
  return result.response;
}

async function waitForBridgeMcpUrl(deadlineMs: number): Promise<string> {
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    const url = __manifestBridgeTestUtils.getFirstRunMcpUrlForTests();
    if (url) return url;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('Timed out waiting for manifest tool bridge MCP URL');
}

async function disposeLiveCursorTestState(): Promise<void> {
  await releaseAllManifestCursorLiveRunsForTests();
  await disposeManifestToolBridgeForTests();
  await disposeAllSessionCursorAgents();
  await new Promise((r) => setTimeout(r, 500));
}

describeLive('CursorProxyService (live Cursor SDK)', () => {
  beforeEach(disposeLiveCursorTestState);
  afterEach(disposeLiveCursorTestState);

  it(
    'exposes tool_calls and resumes after tool results on the next request',
    async () => {
      const service = new CursorProxyService();
      const sessionKey = `live-bridge-flow-${Date.now()}`;
      const scopeKey = buildCursorSessionPoolKey('live-agent', apiKey!, sessionKey);

      const firstResponse = await invokeBridgeDuringForward(
        service.forward({
          provider: 'cursor',
          apiKey: apiKey!,
          model: LIVE_MODEL,
          body: {
            messages: [{ role: 'user', content: 'Run a shell command.' }],
            tools: [bashTool],
          },
          stream: false,
          agentId: 'live-agent',
          sessionKey,
        }),
        BRIDGE_POLL_MS,
      );

      expect(firstResponse.ok).toBe(true);
      const firstJson = (await firstResponse.json()) as {
        choices: Array<{
          finish_reason: string;
          message: { tool_calls?: Array<{ id: string; function: { name: string } }> };
        }>;
      };
      expect(firstJson.choices[0]?.finish_reason).toBe('tool_calls');
      const toolCallId = firstJson.choices[0]?.message.tool_calls?.[0]?.id;
      expect(toolCallId).toBeDefined();
      expect(firstJson.choices[0]?.message.tool_calls?.[0]?.function.name).toBe('bash');

      const liveRun = manifestCursorLiveRuns.getForScope(scopeKey);
      expect(liveRun).toBeDefined();
      liveRun!.textDeltas.push('Live resume after tool');
      markManifestLiveRunFinished(liveRun!);

      const second = await service.forward({
        provider: 'cursor',
        apiKey: apiKey!,
        model: LIVE_MODEL,
        body: {
          messages: [
            { role: 'user', content: 'Run a shell command.' },
            { role: 'tool', tool_call_id: toolCallId!, content: 'bridge-multiturn-1\n' },
          ],
          tools: [bashTool],
        },
        stream: false,
        agentId: 'live-agent',
        sessionKey,
      });

      expect(second.response.ok).toBe(true);
      const secondJson = (await second.response.json()) as {
        choices: Array<{ message: { content: string } }>;
      };
      expect(secondJson.choices[0]?.message?.content).toContain('Live resume after tool');
    },
    LIVE_TIMEOUT_MS,
  );

  it(
    'completes a non-stream chat completion',
    async () => {
      const service = new CursorProxyService();
      const sessionKey = `live-non-stream-${Date.now()}`;
      const result = await service.forward({
        provider: 'cursor',
        apiKey: apiKey!,
        model: LIVE_MODEL,
        body: {
          messages: [
            {
              role: 'user',
              content: 'Reply with exactly one word: pong. No punctuation.',
            },
          ],
        },
        stream: false,
        agentId: 'live-agent',
        sessionKey,
      });

      expect(result.response.ok).toBe(true);
      const json = (await result.response.json()) as {
        choices: Array<{ message: { content: string } }>;
      };
      const content = json.choices[0]?.message?.content?.toLowerCase() ?? '';
      expect(content).toContain('pong');
    },
    LIVE_TIMEOUT_MS,
  );

  it(
    'streams a chat completion over SSE',
    async () => {
      const service = new CursorProxyService();
      const result = await service.forward({
        provider: 'cursor',
        apiKey: apiKey!,
        model: LIVE_MODEL,
        body: {
          messages: [
            {
              role: 'user',
              content: 'Reply with exactly one word: stream. No punctuation.',
            },
          ],
        },
        stream: true,
        agentId: 'live-agent',
        sessionKey: `live-stream-${Date.now()}`,
      });

      expect(result.response.headers.get('Content-Type')).toBe('text/event-stream');
      const text = await result.response.text();
      expect(text).toContain('data:');
      expect(text).toContain('[DONE]');
      expect(text.toLowerCase()).toContain('stream');
    },
    LIVE_TIMEOUT_MS,
  );
});
