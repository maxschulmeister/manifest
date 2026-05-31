import {
  buildManifestBridgeMcpToolDescription,
  getManifestBridgeContractText,
  MANIFEST_BRIDGE_MCP_TOOL_PREFIX,
} from './manifest-bridge-contract';

describe('manifest-bridge-contract', () => {
  it('exposes contract text and MCP prefix', () => {
    expect(MANIFEST_BRIDGE_MCP_TOOL_PREFIX).toBe('manifest__');
    expect(getManifestBridgeContractText()).toContain('manifest__');
    expect(getManifestBridgeContractText({ bridgeToolsActive: true })).toContain(
      'manifest__* bridge tools only',
    );
    expect(getManifestBridgeContractText({ bridgeToolsActive: true })).not.toContain(
      'separate from the manifest bridge',
    );
  });

  it('builds MCP tool descriptions with optional guidelines', () => {
    const without = buildManifestBridgeMcpToolDescription({
      agentToolName: 'bash',
      mcpToolName: 'manifest__bash',
      agentToolDescription: 'Run shell',
    });
    expect(without).toContain('manifest__bash');

    const withGuidelines = buildManifestBridgeMcpToolDescription({
      agentToolName: 'bash',
      mcpToolName: 'manifest__bash',
      agentToolDescription: 'Run shell',
      promptGuidelines: ['  use absolute paths  ', ''],
    });
    expect(withGuidelines).toContain('Tool prompt guidelines');
  });
});
