import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { MANIFEST_MCP_SERVER_NAME } from './manifest-tool-bridge-constants';
import { ManifestToolBridgeRunImpl } from './manifest-tool-bridge-run';
import type {
  ManifestBridgeToolRequest,
  ManifestToolBridgeRun,
} from './manifest-tool-bridge-types';
import { __manifestBridgeTestUtils } from './manifest-tool-bridge-server';
import { buildManifestToolBridgeSnapshotFromOpenAiTools } from './manifest-tool-bridge-snapshot';
import { disposeCursorTestState, withMcpTestClient } from '../cursor-test-harness';

function mcpUrl(run: ManifestToolBridgeRun): string {
  return (run.mcpServers?.manifest_tools as { url: string }).url;
}

async function withRunMcpClient<T>(
  run: ManifestToolBridgeRun,
  fn: (client: Client) => Promise<T>,
): Promise<T> {
  return withMcpTestClient(mcpUrl(run), fn);
}

describe('manifest-tool-bridge-run', () => {
  afterEach(async () => {
    await disposeCursorTestState();
  });

  it('skips MCP server when disabled with empty snapshot', async () => {
    const registry = __manifestBridgeTestUtils.createRegistry();
    const run = await registry.createRun({
      snapshot: buildManifestToolBridgeSnapshotFromOpenAiTools([]),
    });
    expect(run.enabled).toBe(false);
    expect(run.mcpServers).toBeUndefined();
    await run.dispose();
  });

  it('returns 410 for HTTP requests after dispose', async () => {
    const registry = __manifestBridgeTestUtils.createRegistry();
    const snapshot = buildManifestToolBridgeSnapshotFromOpenAiTools([
      { type: 'function', function: { name: 'bash' } },
    ]);
    const run = (await registry.createRun({ snapshot })) as ManifestToolBridgeRunImpl;
    let statusCode = 0;
    const end = jest.fn();
    await run.dispose();
    await run.handleHttpRequest(
      { socket: { localAddress: '127.0.0.1' } } as never,
      {
        headersSent: false,
        writeHead: jest.fn((code: number) => {
          statusCode = code;
          return { end };
        }),
        end,
      } as never,
    );
    expect(statusCode).toBe(410);
  });

  it('rejects when handler detached after setOnToolRequest(undefined)', async () => {
    const registry = __manifestBridgeTestUtils.createRegistry();
    const snapshot = buildManifestToolBridgeSnapshotFromOpenAiTools([
      { type: 'function', function: { name: 'bash' } },
    ]);
    const run = await registry.createRun({ snapshot });
    run.setOnToolRequest(undefined);
    await withRunMcpClient(run, async (client) => {
      await expect(client.callTool({ name: 'manifest__bash', arguments: {} })).rejects.toThrow(
        /no active live run/i,
      );
    });
    await run.dispose();
  });

  it('dispatches queued requests when handler is attached', async () => {
    const registry = __manifestBridgeTestUtils.createRegistry();
    const snapshot = buildManifestToolBridgeSnapshotFromOpenAiTools([
      { type: 'function', function: { name: 'bash' } },
    ]);
    const seen: string[] = [];
    let capturedToolCallId = '';
    const run = await registry.createRun({ snapshot });
    await withRunMcpClient(run, async (client) => {
      const callPromise = client.callTool({ name: 'manifest__bash', arguments: {} });
      await new Promise((r) => setTimeout(r, 25));
      run.setOnToolRequest((req) => {
        seen.push(req.agentToolName);
        capturedToolCallId = req.manifestToolCallId;
      });
      expect(seen).toEqual(['bash']);
      run.resolveToolResults([{ toolCallId: capturedToolCallId, content: 'ok' }]);
      await callPromise;
    });
    await run.dispose();
    expect(capturedToolCallId).toMatch(/-tool-/);
  });

  it('rejects handler errors and supports isBridgeMcpToolCall matching', async () => {
    const registry = __manifestBridgeTestUtils.createRegistry();
    const snapshot = buildManifestToolBridgeSnapshotFromOpenAiTools([
      { type: 'function', function: { name: 'bash' } },
    ]);
    const run = await registry.createRun({
      snapshot,
      onToolRequest: () => {
        throw new Error('handler failed');
      },
    });
    expect(run.isBridgeMcpToolCall({ name: 'manifest__bash' })).toBe(true);
    expect(run.isBridgeMcpToolCall({ name: 'read' })).toBe(false);
    await withRunMcpClient(run, async (client) => {
      await expect(client.callTool({ name: 'manifest__bash', arguments: {} })).rejects.toThrow(
        'handler failed',
      );
    });
    await run.dispose();
  });

  it('aborts in-flight MCP tool calls when signal aborts', async () => {
    const registry = __manifestBridgeTestUtils.createRegistry();
    const snapshot = buildManifestToolBridgeSnapshotFromOpenAiTools([
      { type: 'function', function: { name: 'bash' } },
    ]);
    const run = await registry.createRun({ snapshot });
    await withRunMcpClient(run, async (client) => {
      const controller = new AbortController();
      const callPromise = client.callTool({ name: 'manifest__bash', arguments: {} }, undefined, {
        signal: controller.signal,
      });
      await new Promise((r) => setTimeout(r, 20));
      controller.abort();
      await expect(callPromise).rejects.toThrow();
    });
    await run.dispose();
  });

  it('rejects callTool on disposed run', async () => {
    const registry = __manifestBridgeTestUtils.createRegistry();
    const snapshot = buildManifestToolBridgeSnapshotFromOpenAiTools([
      { type: 'function', function: { name: 'bash' } },
    ]);
    const run = (await registry.createRun({ snapshot })) as ManifestToolBridgeRunImpl;
    await run.dispose();
    await expect(
      (
        run as unknown as { enqueueToolRequest: (...args: unknown[]) => Promise<unknown> }
      ).enqueueToolRequest('manifest__bash', {}, 'cursor-call-1'),
    ).rejects.toThrow(/disposed/i);
  });

  it('matches MCP envelope tool calls by cursor call id', async () => {
    const registry = __manifestBridgeTestUtils.createRegistry();
    const snapshot = buildManifestToolBridgeSnapshotFromOpenAiTools([
      { type: 'function', function: { name: 'bash' } },
    ]);
    const requests: ManifestBridgeToolRequest[] = [];
    const run = await registry.createRun({
      snapshot,
      onToolRequest: (req) => requests.push(req),
    });
    await withRunMcpClient(run, async (client) => {
      const callPromise = client.callTool({ name: 'manifest__bash', arguments: {} });
      await new Promise((r) => setTimeout(r, 25));
      const callId = requests[0]?.cursorMcpCallId;
      expect(callId).toBeDefined();
      expect(
        run.isBridgeMcpToolCall({
          name: 'mcp',
          call_id: callId,
        }),
      ).toBe(true);
      const toolCallId = requests[0]?.manifestToolCallId;
      if (toolCallId) {
        run.resolveToolResults([{ toolCallId, content: 'done' }]);
      }
      await callPromise;
    });
    await run.dispose();
  });

  it('resolveToolResults skips settled and unknown ids', async () => {
    const registry = __manifestBridgeTestUtils.createRegistry();
    const snapshot = buildManifestToolBridgeSnapshotFromOpenAiTools([
      { type: 'function', function: { name: 'bash' } },
    ]);
    const run = await registry.createRun({ snapshot });
    run.resolveToolResults([
      { toolCallId: 'missing', content: 'x' },
      { toolCallId: 'missing', content: 'y', isError: true },
    ]);
    await run.dispose();
  });

  it('takeQueuedToolRequests drains the queue', async () => {
    const registry = __manifestBridgeTestUtils.createRegistry();
    const snapshot = buildManifestToolBridgeSnapshotFromOpenAiTools([
      { type: 'function', function: { name: 'bash' } },
    ]);
    const run = await registry.createRun({ snapshot });
    await withRunMcpClient(run, async (client) => {
      const callPromise = client.callTool({ name: 'manifest__bash', arguments: {} });
      await new Promise((r) => setTimeout(r, 25));
      const queued = run.takeQueuedToolRequests();
      expect(queued).toHaveLength(1);
      run.resolveToolResults([{ toolCallId: queued[0]!.manifestToolCallId, content: 'ok' }]);
      await callPromise;
      expect(run.takeQueuedToolRequests()).toEqual([]);
    });
    await run.dispose();
  });

  it('resolves tool results with isError flag', async () => {
    const registry = __manifestBridgeTestUtils.createRegistry();
    const snapshot = buildManifestToolBridgeSnapshotFromOpenAiTools([
      { type: 'function', function: { name: 'bash' } },
    ]);
    const requests: ManifestBridgeToolRequest[] = [];
    const run = await registry.createRun({
      snapshot,
      onToolRequest: (request) => requests.push(request),
    });
    await withRunMcpClient(run, async (client) => {
      const callPromise = client.callTool({ name: 'manifest__bash', arguments: {} });
      await new Promise((r) => setTimeout(r, 25));
      run.resolveToolResults([
        { toolCallId: requests[0]!.manifestToolCallId, content: 'failed', isError: true },
      ]);
      const result = await callPromise;
      expect(result.isError).toBe(true);
    });
    await run.dispose();
  });

  it('rejects immediately when callTool signal is already aborted', async () => {
    const registry = __manifestBridgeTestUtils.createRegistry();
    const snapshot = buildManifestToolBridgeSnapshotFromOpenAiTools([
      { type: 'function', function: { name: 'bash' } },
    ]);
    const run = await registry.createRun({ snapshot });
    await withRunMcpClient(run, async (client) => {
      const controller = new AbortController();
      controller.abort();
      await expect(
        client.callTool({ name: 'manifest__bash', arguments: {} }, undefined, {
          signal: controller.signal,
        }),
      ).rejects.toThrow();
    });
    await run.dispose();
  });

  it('rejects pending queued calls when handler is cleared after enqueue', async () => {
    const registry = __manifestBridgeTestUtils.createRegistry();
    const snapshot = buildManifestToolBridgeSnapshotFromOpenAiTools([
      { type: 'function', function: { name: 'bash' } },
    ]);
    const run = await registry.createRun({ snapshot });
    await withRunMcpClient(run, async (client) => {
      const callPromise = client.callTool({ name: 'manifest__bash', arguments: {} });
      await new Promise((r) => setTimeout(r, 25));
      run.setOnToolRequest(undefined);
      await expect(callPromise).rejects.toThrow(/no active live run/i);
    });
    await run.dispose();
  });

  it('rejects queued calls when handler is detached without live run', async () => {
    const registry = __manifestBridgeTestUtils.createRegistry();
    const snapshot = buildManifestToolBridgeSnapshotFromOpenAiTools([
      { type: 'function', function: { name: 'bash' } },
    ]);
    const run = await registry.createRun({ snapshot });
    run.setOnToolRequest(undefined);
    await withRunMcpClient(run, async (client) => {
      await expect(client.callTool({ name: 'manifest__bash', arguments: {} })).rejects.toThrow(
        /no active live run/i,
      );
    });
    await run.dispose();
  });

  it('rejects when abort signal fires after the call is queued', async () => {
    const registry = __manifestBridgeTestUtils.createRegistry();
    const snapshot = buildManifestToolBridgeSnapshotFromOpenAiTools([
      { type: 'function', function: { name: 'bash' } },
    ]);
    const run = await registry.createRun({
      snapshot,
      onToolRequest: () => {
        /* block until abort */
      },
    });
    await withRunMcpClient(run, async (client) => {
      const controller = new AbortController();
      const callPromise = client.callTool({ name: 'manifest__bash', arguments: {} }, undefined, {
        signal: controller.signal,
      });
      await new Promise((r) => setTimeout(r, 25));
      controller.abort();
      await expect(callPromise).rejects.toThrow(/aborted/i);
    });
    await run.dispose();
  });

  it('rejects when the tool handler throws', async () => {
    const registry = __manifestBridgeTestUtils.createRegistry();
    const snapshot = buildManifestToolBridgeSnapshotFromOpenAiTools([
      { type: 'function', function: { name: 'bash' } },
    ]);
    const run = await registry.createRun({
      snapshot,
      onToolRequest: () => {
        throw new Error('handler failed');
      },
    });
    await withRunMcpClient(run, async (client) => {
      await expect(client.callTool({ name: 'manifest__bash', arguments: {} })).rejects.toThrow(
        /handler failed/i,
      );
    });
    await run.dispose();
  });

  it('reports pending tool calls while MCP requests are open', async () => {
    const registry = __manifestBridgeTestUtils.createRegistry();
    const snapshot = buildManifestToolBridgeSnapshotFromOpenAiTools([
      { type: 'function', function: { name: 'bash' } },
    ]);
    const run = await registry.createRun({ snapshot });
    expect(run.hasPendingToolCalls()).toBe(false);
    await withRunMcpClient(run, async (client) => {
      const callPromise = client.callTool({ name: 'manifest__bash', arguments: {} });
      await new Promise((r) => setTimeout(r, 25));
      expect(run.hasPendingToolCalls()).toBe(true);
      const queued = run.takeQueuedToolRequests();
      run.resolveToolResults([{ toolCallId: queued[0]!.manifestToolCallId, content: 'ok' }]);
      await callPromise;
      expect(run.hasPendingToolCalls()).toBe(false);
    });
    await run.dispose();
  });

  it('splices queued requests when resolving a still-queued pending call', async () => {
    const registry = __manifestBridgeTestUtils.createRegistry();
    const snapshot = buildManifestToolBridgeSnapshotFromOpenAiTools([
      { type: 'function', function: { name: 'bash' } },
    ]);
    const run = (await registry.createRun({ snapshot })) as ManifestToolBridgeRunImpl;
    await withRunMcpClient(run, async (client) => {
      const callPromise = client.callTool({ name: 'manifest__bash', arguments: {} });
      await new Promise((r) => setTimeout(r, 25));
      const queued = (run as unknown as { queuedRequests: ManifestBridgeToolRequest[] })
        .queuedRequests;
      expect(queued).toHaveLength(1);
      run.resolveToolResults([{ toolCallId: queued[0]!.manifestToolCallId, content: 'ok' }]);
      await callPromise;
      expect(queued).toHaveLength(0);
    });
    await run.dispose();
  });

  it('removes queued requests when a pending call is cancelled', async () => {
    const registry = __manifestBridgeTestUtils.createRegistry();
    const snapshot = buildManifestToolBridgeSnapshotFromOpenAiTools([
      { type: 'function', function: { name: 'bash' } },
    ]);
    const run = await registry.createRun({ snapshot });
    await withRunMcpClient(run, async (client) => {
      const callPromise = client.callTool({ name: 'manifest__bash', arguments: {} });
      await new Promise((r) => setTimeout(r, 25));
      expect(run.hasPendingToolCalls()).toBe(true);
      run.cancel('queued cancel');
      await expect(callPromise).rejects.toThrow(/queued cancel/i);
      expect(run.takeQueuedToolRequests()).toEqual([]);
    });
    await run.dispose();
  });

  it('rejects enqueueToolRequest when the abort signal is already set', async () => {
    const registry = __manifestBridgeTestUtils.createRegistry();
    const snapshot = buildManifestToolBridgeSnapshotFromOpenAiTools([
      { type: 'function', function: { name: 'bash' } },
    ]);
    const run = (await registry.createRun({ snapshot })) as ManifestToolBridgeRunImpl;
    const controller = new AbortController();
    controller.abort();
    await expect(
      (
        run as unknown as {
          enqueueToolRequest: (
            name: string,
            args: unknown,
            cursorMcpCallId: string,
            signal?: AbortSignal,
          ) => Promise<unknown>;
        }
      ).enqueueToolRequest('manifest__bash', {}, 'cursor-aborted', controller.signal),
    ).rejects.toThrow(/aborted/i);
    await run.dispose();
  });

  it('matches manifest_tools server envelope by cursor call id', async () => {
    const registry = __manifestBridgeTestUtils.createRegistry();
    const snapshot = buildManifestToolBridgeSnapshotFromOpenAiTools([
      { type: 'function', function: { name: 'bash' } },
    ]);
    const requests: ManifestBridgeToolRequest[] = [];
    const run = await registry.createRun({
      snapshot,
      onToolRequest: (request) => requests.push(request),
    });
    await withRunMcpClient(run, async (client) => {
      const callPromise = client.callTool({ name: 'manifest__bash', arguments: {} });
      await new Promise((r) => setTimeout(r, 25));
      const callId = requests[0]?.cursorMcpCallId;
      expect(
        run.isBridgeMcpToolCall({
          name: MANIFEST_MCP_SERVER_NAME,
          call_id: callId,
        }),
      ).toBe(true);
      if (callId) {
        run.resolveToolResults([{ toolCallId: requests[0]!.manifestToolCallId, content: 'ok' }]);
      }
      await callPromise;
    });
    await run.dispose();
  });
});
