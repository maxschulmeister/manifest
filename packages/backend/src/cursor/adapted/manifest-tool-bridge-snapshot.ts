/**
 * Adapted from pi-cursor-sdk cursor-pi-tool-bridge-snapshot.ts (MIT). See ATTRIBUTION.md.
 * Manifest builds snapshots from OpenAI request body.tools instead of pi ExtensionAPI.
 */
import type {
  ManifestBridgeToolDefinition,
  ManifestToolBridgeSnapshot,
} from './manifest-tool-bridge-types';
import {
  createMcpToolName,
  normalizeMcpInputSchema,
  stableNameHash,
} from './manifest-tool-bridge-mcp';

export function createEmptyManifestToolBridgeSnapshot(): ManifestToolBridgeSnapshot {
  return {
    tools: [],
    mcpToolNameToAgentToolName: new Map(),
    agentToolNameToMcpToolName: new Map(),
  };
}

function isOpenAiFunctionTool(value: unknown): value is {
  type: string;
  function: { name: string; description?: string; parameters?: unknown };
} {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  if (record.type !== 'function') return false;
  const fn = record.function;
  if (typeof fn !== 'object' || fn === null) return false;
  return typeof (fn as { name?: unknown }).name === 'string';
}

export function buildManifestToolBridgeSnapshotFromOpenAiTools(
  tools: unknown,
): ManifestToolBridgeSnapshot {
  if (!Array.isArray(tools) || tools.length === 0) {
    return createEmptyManifestToolBridgeSnapshot();
  }

  const usedMcpToolNames = new Set<string>();
  const mcpToolNameToAgentToolName = new Map<string, string>();
  const agentToolNameToMcpToolName = new Map<string, string>();
  const definitions: ManifestBridgeToolDefinition[] = [];

  for (const tool of tools) {
    if (!isOpenAiFunctionTool(tool)) continue;
    const agentToolName = tool.function.name.trim();
    if (!agentToolName) continue;

    const mcpToolName = createMcpToolName(agentToolName, usedMcpToolNames);
    const description = tool.function.description?.trim() || `Run agent tool ${agentToolName}`;
    mcpToolNameToAgentToolName.set(mcpToolName, agentToolName);
    agentToolNameToMcpToolName.set(agentToolName, mcpToolName);
    definitions.push({
      agentToolName,
      mcpToolName,
      description,
      inputSchema: normalizeMcpInputSchema(tool.function.parameters),
    });
  }

  return {
    tools: definitions,
    mcpToolNameToAgentToolName,
    agentToolNameToMcpToolName,
  };
}

export function buildManifestToolBridgeSurfaceSignature(
  snapshot: ManifestToolBridgeSnapshot,
): string {
  if (snapshot.tools.length === 0) return 'bridge:empty';
  const serializedTools = snapshot.tools
    .map((tool) =>
      JSON.stringify({
        agentToolName: tool.agentToolName,
        mcpToolName: tool.mcpToolName,
        description: tool.description,
        inputSchema: tool.inputSchema,
      }),
    )
    .sort()
    .join('\0');
  return `bridge:on:${stableNameHash(serializedTools)}`;
}
