import {
  buildManifestToolBridgeSnapshotFromOpenAiTools,
  buildManifestToolBridgeSurfaceSignature,
  createEmptyManifestToolBridgeSnapshot,
} from './manifest-tool-bridge-snapshot';

describe('manifest-tool-bridge-snapshot', () => {
  it('returns empty snapshot for missing tools', () => {
    const snapshot = buildManifestToolBridgeSnapshotFromOpenAiTools(undefined);
    expect(snapshot.tools).toEqual([]);
    expect(buildManifestToolBridgeSurfaceSignature(snapshot)).toBe('bridge:empty');
  });

  it('maps OpenAI function tools to manifest__ MCP names', () => {
    const snapshot = buildManifestToolBridgeSnapshotFromOpenAiTools([
      {
        type: 'function',
        function: {
          name: 'bash',
          description: 'Run shell',
          parameters: { type: 'object', properties: { command: { type: 'string' } } },
        },
      },
      { type: 'function', function: { name: 'read', description: 'Read file' } },
    ]);
    expect(snapshot.tools.map((t) => t.agentToolName)).toEqual(['bash', 'read']);
    expect(snapshot.tools[0]?.mcpToolName).toBe('manifest__bash');
    expect(snapshot.agentToolNameToMcpToolName.get('bash')).toBe('manifest__bash');
    expect(buildManifestToolBridgeSurfaceSignature(snapshot)).toMatch(/^bridge:on:/);
  });

  it('deduplicates colliding MCP names with hash suffix', () => {
    const snapshot = buildManifestToolBridgeSnapshotFromOpenAiTools([
      { type: 'function', function: { name: 'tool-a' } },
      { type: 'function', function: { name: 'tool.a' } },
    ]);
    const mcpNames = snapshot.tools.map((t) => t.mcpToolName);
    expect(new Set(mcpNames).size).toBe(2);
    expect(mcpNames.every((name) => name.startsWith('manifest__'))).toBe(true);
  });

  it('ignores non-function tool entries', () => {
    const snapshot = buildManifestToolBridgeSnapshotFromOpenAiTools([
      { type: 'code_interpreter' },
      { type: 'function', function: { name: '' } },
      { type: 'function', function: { name: 'valid' } },
    ]);
    expect(snapshot.tools.map((t) => t.agentToolName)).toEqual(['valid']);
  });

  it('createEmptyManifestToolBridgeSnapshot returns stable empty maps', () => {
    const a = createEmptyManifestToolBridgeSnapshot();
    const b = createEmptyManifestToolBridgeSnapshot();
    expect(a.tools).toEqual(b.tools);
    expect(a.mcpToolNameToAgentToolName.size).toBe(0);
  });
});
