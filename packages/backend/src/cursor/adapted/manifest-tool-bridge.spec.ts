import {
  __manifestBridgeTestUtils,
  getManifestToolBridgeRegistry,
} from './manifest-tool-bridge-server';
import { buildManifestToolBridgeSnapshotFromOpenAiTools } from './manifest-tool-bridge-snapshot';
import type { ManifestBridgeToolRequest } from './manifest-tool-bridge-types';
import { disposeCursorTestState, withMcpTestClient } from '../cursor-test-harness';

describe('manifest-tool-bridge', () => {
  afterEach(async () => {
    await disposeCursorTestState();
  });

  it('exposes tools over loopback MCP and queues callTool without executing', async () => {
    const snapshot = buildManifestToolBridgeSnapshotFromOpenAiTools([
      {
        type: 'function',
        function: { name: 'bash', description: 'Shell', parameters: { type: 'object' } },
      },
    ]);
    const requests: ManifestBridgeToolRequest[] = [];
    const run = await getManifestToolBridgeRegistry().createRun({
      snapshot,
      onToolRequest: (request) => requests.push(request),
    });
    const mcpConfig = run.mcpServers?.manifest_tools as { type: 'http'; url: string };
    expect(mcpConfig.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\//);

    await withMcpTestClient(mcpConfig.url, async (client) => {
      const listed = await client.listTools();
      expect(listed.tools.map((t) => t.name)).toEqual(['manifest__bash']);

      const callPromise = client.callTool({ name: 'manifest__bash', arguments: { command: 'ls' } });
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(requests).toHaveLength(1);
      expect(requests[0]?.agentToolName).toBe('bash');
      expect(requests[0]?.args).toEqual({ command: 'ls' });

      run.resolveToolResults([
        { toolCallId: requests[0]!.manifestToolCallId, content: 'listed files' },
      ]);
      const result = await callPromise;
      expect(result.content).toEqual([{ type: 'text', text: 'listed files' }]);
    });
    await run.dispose();
  });

  it('rejects unknown MCP tool names without pending state', async () => {
    const snapshot = buildManifestToolBridgeSnapshotFromOpenAiTools([
      { type: 'function', function: { name: 'bash' } },
    ]);
    const run = await getManifestToolBridgeRegistry().createRun({ snapshot });
    const mcpConfig = run.mcpServers?.manifest_tools as { type: 'http'; url: string };
    await withMcpTestClient(mcpConfig.url, async (client) => {
      const result = await client.callTool({ name: 'manifest__missing', arguments: {} });
      expect(result.isError).toBe(true);
    });
    await run.dispose();
  });

  it('rejects MCP callTool args that violate the bridged schema without queuing to pi', async () => {
    const snapshot = buildManifestToolBridgeSnapshotFromOpenAiTools([
      {
        type: 'function',
        function: {
          name: 'web_search',
          parameters: {
            type: 'object',
            required: ['query'],
            properties: { query: { type: 'string' } },
          },
        },
      },
    ]);
    const requests: ManifestBridgeToolRequest[] = [];
    const run = await getManifestToolBridgeRegistry().createRun({
      snapshot,
      onToolRequest: (request) => requests.push(request),
    });
    const mcpConfig = run.mcpServers?.manifest_tools as { type: 'http'; url: string };
    await withMcpTestClient(mcpConfig.url, async (client) => {
      const result = await client.callTool({
        name: 'manifest__web_search',
        arguments: { search_term: 'austria world cup 2026' },
      });
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result.content)).toContain(
        'Missing or empty required properties: query',
      );
      expect(requests).toHaveLength(0);
    });
    await run.dispose();
  });

  it('registry tracks pending manifest tool call ids', async () => {
    const registry = __manifestBridgeTestUtils.createRegistry();
    const snapshot = buildManifestToolBridgeSnapshotFromOpenAiTools([
      { type: 'function', function: { name: 'bash' } },
    ]);
    const requests: ManifestBridgeToolRequest[] = [];
    const run = await registry.createRun({
      snapshot,
      onToolRequest: (request) => requests.push(request),
    });
    const mcpConfig = run.mcpServers?.manifest_tools as { type: 'http'; url: string };
    await withMcpTestClient(mcpConfig.url, async (client) => {
      const callPromise = client.callTool({ name: 'manifest__bash', arguments: {} });
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(requests).toHaveLength(1);
      expect(registry.hasPendingManifestToolCallId(requests[0]!.manifestToolCallId)).toBe(true);
      run.resolveToolResults([{ toolCallId: requests[0]!.manifestToolCallId, content: 'ok' }]);
      await callPromise;
    });
    await run.dispose();
  });
});
