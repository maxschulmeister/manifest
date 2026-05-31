/**
 * Adapted from pi-cursor-sdk cursor-bridge-contract.ts (MIT). See ATTRIBUTION.md.
 */
export const MANIFEST_BRIDGE_MCP_TOOL_PREFIX = 'manifest__';

const MANIFEST_BRIDGE_CONTRACT_LINES = [
  'Manifest tool bridge contract:',
  `${MANIFEST_BRIDGE_MCP_TOOL_PREFIX}* names are live Cursor MCP bridge tool names only when exposed in the current run.`,
  `Call the ${MANIFEST_BRIDGE_MCP_TOOL_PREFIX}* MCP tool name, not the agent tool name from request history.`,
  'Bridged calls return OpenAI tool_calls to the agent; Manifest does not execute tools on the backend.',
  'On the next request, send role:tool messages with matching tool_call_id to resume the same Cursor SDK run.',
  'Cursor-native host tools and configured MCP servers are separate from the manifest bridge.',
] as const;

export function getManifestBridgeContractText(): string {
  return MANIFEST_BRIDGE_CONTRACT_LINES.join('\n');
}

function formatPromptGuidelines(
  promptGuidelines: readonly string[] | undefined,
): string | undefined {
  const guidelines = promptGuidelines?.map((g) => g.trim()).filter(Boolean) ?? [];
  if (guidelines.length === 0) return undefined;
  return ['Tool prompt guidelines:', ...guidelines.map((g) => `- ${g}`)].join('\n');
}

export function buildManifestBridgeMcpToolDescription(options: {
  agentToolName: string;
  mcpToolName: string;
  agentToolDescription: string;
  promptGuidelines?: readonly string[];
}): string {
  return [
    options.agentToolDescription,
    formatPromptGuidelines(options.promptGuidelines),
    `Call MCP name ${options.mcpToolName} (agent tool: ${options.agentToolName}). Full tool-surface rules are in the session bootstrap prompt.`,
  ]
    .filter((line): line is string => line !== undefined)
    .join('\n');
}
