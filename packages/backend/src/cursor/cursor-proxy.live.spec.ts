/**
 * Live Cursor SDK integration tests. Opt in with RUN_CURSOR_LIVE_TESTS=1 and CURSOR_API_KEY.
 * Run from packages/backend:
 *   RUN_CURSOR_LIVE_TESTS=1 npx jest src/cursor/cursor-proxy.live.spec.ts --testTimeout=90000
 *
 * Bridge probe test must not await MCP callTool (deadlocks until tool results arrive).
 */
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { config as loadEnv } from 'dotenv';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { __manifestBridgeTestUtils } from './adapted/manifest-tool-bridge-server';
import {
  manifestCursorLiveRuns,
  markManifestLiveRunFinished,
} from './adapted/manifest-cursor-live-run';
import { buildCursorSessionPoolKey } from './cursor-session-pool';
import { CursorProxyService } from './cursor-proxy.service';
import { disposeCursorTestState, isCursorLiveTestsEnabled } from './cursor-test-harness';

const liveEnvPath = resolve(__dirname, '../../.env');
if (existsSync(liveEnvPath)) {
  loadEnv({ path: liveEnvPath, override: true, quiet: true });
}

const liveTestsEnabled = isCursorLiveTestsEnabled();
const apiKey = process.env.CURSOR_API_KEY?.trim();
if (liveTestsEnabled && !apiKey) {
  throw new Error(
    `RUN_CURSOR_LIVE_TESTS is set but CURSOR_API_KEY is missing. Set it in ${liveEnvPath} ` +
      '(dotenv override: true; empty shell values are replaced).',
  );
}
if (!liveTestsEnabled) {
  console.warn(
    'Skipping live Cursor tests: set RUN_CURSOR_LIVE_TESTS=1 to opt in. ' +
      'CURSOR_API_KEY alone does not enable live SDK calls.',
  );
}
const describeLive = liveTestsEnabled && apiKey ? describe : describe.skip;

const LIVE_MODEL = process.env.CURSOR_LIVE_MODEL?.trim() || 'cursor/composer-2.5';
const LIVE_TIMEOUT_MS = 90_000;
const BRIDGE_POLL_MS = 15_000;

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

const LIVE_BRIDGE_TOOL_NAMES = ['live_weather_lookup', 'live_send_email', 'live_calc_sum'] as const;

function makeFunctionTool(name: string, description: string) {
  return {
    type: 'function' as const,
    function: {
      name,
      description,
      parameters: {
        type: 'object',
        properties: {},
      },
    },
  };
}

const liveBridgeTools = LIVE_BRIDGE_TOOL_NAMES.map((name) =>
  makeFunctionTool(name, `Integration-test tool: ${name}`),
);

function expectContentListsToolNames(content: string, toolNames: readonly string[]): void {
  const normalized = content.toLowerCase();
  for (const name of toolNames) {
    expect(normalized).toContain(name.toLowerCase());
  }
}

interface InvokeBridgeDuringForwardOptions {
  command?: string;
  expectedMcpToolNames?: readonly string[];
}

async function invokeBridgeBashToolCall(
  url: string,
  command: string,
  options: { expectedMcpToolNames?: readonly string[] } = {},
): Promise<void> {
  const client = new Client({ name: 'manifest-live-test', version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(url));
  try {
    await client.connect(transport);
    if (options.expectedMcpToolNames) {
      const listed = await client.listTools();
      expect(listed.tools.map((tool) => tool.name)).toEqual([...options.expectedMcpToolNames]);
    }
    // Do not await callTool — it blocks until the agent sends tool results on the next
    // HTTP request, which deadlocks this test while forward() is still in flight.
    void client
      .callTool({
        name: 'manifest__bash',
        arguments: { command },
      })
      .catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 100));
  } finally {
    await transport.close().catch(() => undefined);
  }
}

async function invokeBridgeDuringForward(
  forwardPromise: Promise<{ response: Response }>,
  pollMs: number,
  options: InvokeBridgeDuringForwardOptions = {},
): Promise<Response> {
  const command = options.command ?? 'echo bridge-live-ok';
  const [, result] = await Promise.all([
    (async () => {
      const bridgeUrl = await waitForBridgeMcpUrl(pollMs);
      await new Promise((r) => setTimeout(r, 250));
      await invokeBridgeBashToolCall(bridgeUrl, command, {
        expectedMcpToolNames: options.expectedMcpToolNames,
      });
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
  await disposeCursorTestState();
}

describeLive('CursorProxyService (live Cursor SDK)', () => {
  beforeEach(disposeLiveCursorTestState);
  afterEach(disposeLiveCursorTestState);

  it(
    'returns exact tool_calls for a forced manifest__bash probe command and resumes',
    async () => {
      const probeDir = mkdtempSync(join(tmpdir(), 'manifest-bridge-probe-'));
      const token = randomUUID();
      const probeLine = `PROBE=${token}`;
      const probePath = join(probeDir, 'token.txt');
      writeFileSync(probePath, `${probeLine}\n`, 'utf8');
      expect(readFileSync(probePath, 'utf8').trimEnd()).toBe(probeLine);

      const command = `cat ${probePath}`;
      const service = new CursorProxyService();
      const sessionKey = `live-bridge-exact-${Date.now()}`;
      const scopeKey = buildCursorSessionPoolKey('live-agent', apiKey!, sessionKey);

      try {
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
          { command, expectedMcpToolNames: ['manifest__bash'] },
        );

        expect(firstResponse.ok).toBe(true);
        const firstJson = (await firstResponse.json()) as {
          choices: Array<{
            finish_reason: string;
            message: {
              tool_calls?: Array<{
                id: string;
                type: string;
                function: { name: string; arguments: string };
              }>;
            };
          }>;
        };
        expect(firstJson.choices[0]?.finish_reason).toBe('tool_calls');
        expect(firstJson.choices[0]?.message.tool_calls).toEqual([
          {
            id: expect.any(String),
            type: 'function',
            function: {
              name: 'bash',
              arguments: JSON.stringify({ command }),
            },
          },
        ]);
        const toolCallId = firstJson.choices[0]?.message.tool_calls?.[0]?.id;
        expect(toolCallId).toBeDefined();

        const liveRun = manifestCursorLiveRuns.getForScope(scopeKey);
        expect(liveRun).toBeDefined();
        liveRun!.textDeltas.push(probeLine);
        markManifestLiveRunFinished(liveRun!);

        const second = await service.forward({
          provider: 'cursor',
          apiKey: apiKey!,
          model: LIVE_MODEL,
          body: {
            messages: [
              { role: 'user', content: 'Run a shell command.' },
              { role: 'tool', tool_call_id: toolCallId!, content: `${probeLine}\n` },
            ],
            tools: [bashTool],
          },
          stream: false,
          agentId: 'live-agent',
          sessionKey,
        });

        expect(second.response.ok).toBe(true);
        const secondJson = (await second.response.json()) as {
          choices: Array<{
            finish_reason: string;
            message: { content: string; tool_calls?: unknown };
          }>;
        };
        expect(secondJson.choices[0]?.finish_reason).toBe('stop');
        expect(secondJson.choices[0]?.message.tool_calls).toBeUndefined();
        expect(secondJson.choices[0]?.message.content).toBe(probeLine);
      } finally {
        rmSync(probeDir, { recursive: true, force: true });
      }
    },
    LIVE_TIMEOUT_MS,
  );

  it(
    'completes without tool_calls when the request exposes no agent tools',
    async () => {
      const service = new CursorProxyService();
      const result = await service.forward({
        provider: 'cursor',
        apiKey: apiKey!,
        model: LIVE_MODEL,
        body: {
          messages: [{ role: 'user', content: 'Reply with exactly one word: hi' }],
        },
        stream: false,
        agentId: 'live-agent',
        sessionKey: `live-no-bridge-${Date.now()}`,
      });

      expect(result.response.ok).toBe(true);
      const json = (await result.response.json()) as {
        choices: Array<{
          finish_reason: string;
          message: { tool_calls?: unknown };
        }>;
      };
      expect(json.choices[0]?.finish_reason).toBe('stop');
      expect(json.choices[0]?.message.tool_calls).toBeUndefined();
      expect(__manifestBridgeTestUtils.getFirstRunMcpUrlForTests()).toBeUndefined();
    },
    LIVE_TIMEOUT_MS,
  );

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
    'reports all three bridged agent tools when asked what tools are available',
    async () => {
      const service = new CursorProxyService();
      const result = await service.forward({
        provider: 'cursor',
        apiKey: apiKey!,
        model: 'cursor/auto',
        body: {
          messages: [
            {
              role: 'user',
              content: [
                'What manifest bridge agent tool function names do you have available in this run?',
                'List every bridged agent tool name (not Cursor SDK host tools).',
                'Reply in plain text with one tool name per line.',
              ].join(' '),
            },
          ],
          tools: [...liveBridgeTools],
        },
        stream: false,
        agentId: 'live-agent',
        sessionKey: `live-tool-manifest-${Date.now()}`,
      });

      expect(result.response.ok).toBe(true);
      const json = (await result.response.json()) as {
        choices: Array<{ message: { content: string } }>;
      };
      const content = json.choices[0]?.message?.content ?? '';
      expect(content.length).toBeGreaterThan(0);
      expectContentListsToolNames(content, LIVE_BRIDGE_TOOL_NAMES);
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
