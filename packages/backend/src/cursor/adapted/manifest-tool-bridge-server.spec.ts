import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  MANIFEST_BRIDGE_LOOPBACK_HOST,
  __manifestBridgeTestUtils,
  disposeManifestToolBridgeForTests,
  getManifestToolBridgeRegistry,
} from './manifest-tool-bridge-server';
import { buildManifestToolBridgeSnapshotFromOpenAiTools } from './manifest-tool-bridge-snapshot';
import { ManifestToolBridgeRunImpl } from './manifest-tool-bridge-run';

describe('manifest-tool-bridge-server', () => {
  afterEach(async () => {
    await disposeManifestToolBridgeForTests();
  });

  it('closes HTTP server when last run unregisters', async () => {
    const registry = __manifestBridgeTestUtils.createRegistry();
    const snapshot = buildManifestToolBridgeSnapshotFromOpenAiTools([
      { type: 'function', function: { name: 'bash' } },
    ]);
    const run = await registry.createRun({ snapshot });
    expect(registry.getEndpointCount()).toBe(1);
    expect(registry.getHttpServerAddress()?.port).toBeGreaterThan(0);
    await run.dispose();
    expect(registry.getEndpointCount()).toBe(0);
  });

  it('reuses HTTP server for multiple runs', async () => {
    const registry = __manifestBridgeTestUtils.createRegistry();
    const snapshot = buildManifestToolBridgeSnapshotFromOpenAiTools([
      { type: 'function', function: { name: 'bash' } },
    ]);
    const run1 = await registry.createRun({ snapshot });
    const port1 = registry.getHttpServerAddress()?.port;
    const run2 = await registry.createRun({ snapshot });
    const port2 = registry.getHttpServerAddress()?.port;
    expect(port1).toBe(port2);
    expect(registry.getEndpointCount()).toBe(2);
    await run1.dispose();
    await run2.dispose();
  });

  it('returns 404 for unknown bridge paths', async () => {
    const registry = __manifestBridgeTestUtils.createRegistry();
    const snapshot = buildManifestToolBridgeSnapshotFromOpenAiTools([
      { type: 'function', function: { name: 'bash' } },
    ]);
    await registry.createRun({ snapshot });
    const port = registry.getHttpServerAddress()!.port;
    const response = await fetch(`http://${MANIFEST_BRIDGE_LOOPBACK_HOST}:${port}/missing/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    expect(response.status).toBe(404);
    await disposeManifestToolBridgeForTests();
  });

  it('returns 500 when run handler throws', async () => {
    const registry = __manifestBridgeTestUtils.createRegistry();
    const snapshot = buildManifestToolBridgeSnapshotFromOpenAiTools([
      { type: 'function', function: { name: 'bash' } },
    ]);
    const run = (await registry.createRun({ snapshot })) as ManifestToolBridgeRunImpl;
    const pathname = new URL((run.mcpServers!.manifest_tools as { url: string }).url).pathname;
    jest.spyOn(run, 'handleHttpRequest').mockRejectedValueOnce(new Error('boom'));
    const port = registry.getHttpServerAddress()!.port;
    const response = await fetch(`http://${MANIFEST_BRIDGE_LOOPBACK_HOST}:${port}${pathname}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'tools/list',
        params: {},
        id: 1,
      }),
    });
    expect(response.status).toBe(500);
    await run.dispose();
  });

  it('exposes the registered bridge singleton for tests', () => {
    const registry = getManifestToolBridgeRegistry();
    expect(__manifestBridgeTestUtils.getRegisteredBridgeForTests()).toBe(registry);
  });

  it('returns false when no run has the pending tool call id', async () => {
    const registry = __manifestBridgeTestUtils.createRegistry();
    expect(registry.hasPendingManifestToolCallId('missing-id')).toBe(false);
  });

  it('returns true when a run has the pending tool call id', async () => {
    const registry = __manifestBridgeTestUtils.createRegistry();
    const snapshot = buildManifestToolBridgeSnapshotFromOpenAiTools([
      { type: 'function', function: { name: 'bash' } },
    ]);
    const run = await registry.createRun({ snapshot });
    const url = (run.mcpServers?.manifest_tools as { url: string }).url;
    const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
    const { StreamableHTTPClientTransport } =
      await import('@modelcontextprotocol/sdk/client/streamableHttp.js');
    const client = new Client({ name: 'pending-id-test', version: '1.0.0' });
    const transport = new StreamableHTTPClientTransport(new URL(url));
    await client.connect(transport);
    const callPromise = client.callTool({ name: 'manifest__bash', arguments: {} });
    await new Promise((r) => setTimeout(r, 25));
    const queued = run.takeQueuedToolRequests();
    expect(registry.hasPendingManifestToolCallId(queued[0]!.manifestToolCallId)).toBe(true);
    run.resolveToolResults([{ toolCallId: queued[0]!.manifestToolCallId, content: 'ok' }]);
    await callPromise;
    await Promise.allSettled([transport.close(), client.close()]);
    await run.dispose();
  });

  it('reports endpoint count and reuses an existing HTTP server', async () => {
    const registry = __manifestBridgeTestUtils.createRegistry();
    expect(registry.getEndpointCount()).toBe(0);
    const snapshot = buildManifestToolBridgeSnapshotFromOpenAiTools([
      { type: 'function', function: { name: 'bash' } },
    ]);
    const run1 = await registry.createRun({ snapshot });
    const run2 = await registry.createRun({ snapshot });
    expect(registry.getEndpointCount()).toBe(2);
    await run1.dispose();
    expect(registry.getEndpointCount()).toBe(1);
    await run2.dispose();
    expect(registry.getEndpointCount()).toBe(0);
  });

  it('returns undefined when no active runs expose an MCP URL', () => {
    const registry = __manifestBridgeTestUtils.createRegistry();
    expect(registry.getFirstRunMcpUrlForTests()).toBeUndefined();
    expect(registry.getFirstBridgeRunForTests()).toBeUndefined();
  });

  it('exposes first run MCP URL and bridge run for tests', async () => {
    const registry = __manifestBridgeTestUtils.createRegistry();
    const snapshot = buildManifestToolBridgeSnapshotFromOpenAiTools([
      { type: 'function', function: { name: 'bash' } },
    ]);
    const run = await registry.createRun({ snapshot });
    const mcpUrl = registry.getFirstRunMcpUrlForTests();
    expect(mcpUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\//);
    expect(registry.getFirstBridgeRunForTests()).toBe(run);

    const singleton = getManifestToolBridgeRegistry();
    await singleton.createRun({ snapshot });
    expect(__manifestBridgeTestUtils.getFirstRunMcpUrlForTests()).toBeDefined();
    expect(__manifestBridgeTestUtils.getFirstBridgeRunForTests()).toBeDefined();
    await disposeManifestToolBridgeForTests();
    expect(__manifestBridgeTestUtils.getFirstRunMcpUrlForTests()).toBeUndefined();
    expect(__manifestBridgeTestUtils.getFirstBridgeRunForTests()).toBeUndefined();
  });

  it('rejects non-loopback requests with 403', async () => {
    const registry = __manifestBridgeTestUtils.createRegistry();
    let statusCode = 0;
    const req = { socket: { localAddress: '10.0.0.2' }, url: '/nope' } as IncomingMessage;
    const end = jest.fn();
    const res = {
      headersSent: false,
      writeHead: jest.fn((code: number) => {
        statusCode = code;
        return { end };
      }),
      end,
    } as unknown as ServerResponse;
    await __manifestBridgeTestUtils.handleManifestBridgeHttpRequestForTests(registry, req, res);
    expect(statusCode).toBe(403);
  });
});
