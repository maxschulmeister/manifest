/**
 * Adapted from pi-cursor-sdk cursor-tool-manifest.ts (MIT). See adapted/ATTRIBUTION.md.
 */
import type { ManifestToolBridgeSnapshot } from './adapted/manifest-tool-bridge-types';
import { formatBridgedToolSchemaHint } from './adapted/manifest-tool-bridge-schema';

/** Retained for tests/docs; not advertised to the model when the pi bridge is active. */
export const CURSOR_HOST_TOOL_MANIFEST_SUMMARY =
  'read, shell, grep, glob, ls, edit, write, delete, readLints, updateTodos, createPlan, task, generateImage, mcp, semSearch, recordScreen, and web search/fetch when exposed';

export function buildCursorToolManifestText(
  options: {
    bridgeSnapshot?: ManifestToolBridgeSnapshot;
    bridgeEnabled?: boolean;
  } = {},
): string {
  const bridgeEnabled = options.bridgeEnabled ?? true;
  const bridgeTools = options.bridgeSnapshot?.tools ?? [];

  if (!bridgeEnabled) {
    return ['Callable tool surfaces this run:', '- Manifest bridge: disabled.'].join('\n');
  }

  if (bridgeTools.length === 0) {
    return [
      'Callable tool surfaces this run:',
      '- Manifest bridge: no manifest__* tools exposed this run.',
      '- Reply with text only.',
    ].join('\n');
  }

  const names = [...bridgeTools.map((tool) => tool.mcpToolName)].sort().join(', ');
  const lines = [
    'Callable tool surfaces this run:',
    `- Agent tools (manifest__* MCP only): ${names}.`,
    '- Cursor host tools are not available in this Manifest integration.',
    '- Agent tools execute in pi on the user machine; Manifest only forwards tool_calls.',
    '- Use exact JSON property names from each tool schema below — do not substitute Cursor-native names.',
    '- Not callable: replay IDs and transcript labels.',
    'Bridged tool schemas:',
  ];
  for (const tool of [...bridgeTools].sort((a, b) =>
    a.agentToolName.localeCompare(b.agentToolName),
  )) {
    lines.push(`${tool.mcpToolName} (agent: ${tool.agentToolName}):`);
    lines.push(formatBridgedToolSchemaHint(tool.inputSchema));
  }
  return lines.join('\n');
}
